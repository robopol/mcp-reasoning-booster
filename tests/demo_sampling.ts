import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
// Note: Avoid importing node:process to keep types simple for Pylance.

type ToolContent = { type: string; [k: string]: unknown };

function getText(content: ToolContent[]): string | undefined {
  return (content.find(c => c.type === "text") as any)?.text as string | undefined;
}

function extractJson<T>(content: ToolContent[]): T | null {
  const txt = getText(content);
  if (!txt) return null;
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = txt.slice(start, end + 1);
    try { return JSON.parse(slice) as T; } catch {}
  }
  try { return JSON.parse(txt) as T; } catch {}
  return null;
}

async function run() {
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
  const client = new Client({ name: "rb-demo", version: "0.1.0" }, { capabilities: { tools: {}, prompts: {}, resources: {}, sampling: {} } });

  // Provide a trivial sampling handler that emits JSON proposals per server instruction
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const userMsg = request.params?.messages?.find(m => m.role === "user");
    const text = (userMsg as any)?.content?.text as string | undefined;
    const match = text?.match(/Return exactly\s+(\d+)/i);
    const k = Math.max(1, Math.min(8, Number(match?.[1] ?? 5)));
    const templates = [
      "State a small lemma that reduces the goal.",
      "Check a local invariant implied by assumptions.",
      "Split the goal into two simpler subgoals.",
      "Rephrase the claim in an equivalent form.",
      "Eliminate an implausible branch via a counterexample sketch.",
    ];
    const items = Array.from({ length: k }, (_, i) => ({
      text: templates[i % templates.length],
      rationale: "Sampling mock: concise next step"
    }));
    return {
      model: "demo-mock",
      role: "assistant",
      content: { type: "text", text: JSON.stringify(items) }
    } as any;
  });

  await client.connect(transport);

  // One-shot solve (simplest demo)
  function getArg(flag: string): string | undefined {
    const argv: string[] = ((globalThis as any).process?.argv ?? []) as string[];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === flag && i + 1 < argv.length) return argv[i + 1];
      const eq = flag + "=";
      if (a.startsWith(eq)) return a.slice(eq.length);
    }
    return undefined;
  }
  const taskArg = getArg("--task");
  const taskEnv = (globalThis as any).process?.env?.TASK as string | undefined;
  const task = (taskArg && taskArg.trim().length > 0)
    ? taskArg
    : (taskEnv && taskEnv.trim().length > 0)
      ? taskEnv
      : "Plan a household monthly budget: categorize expenses, set savings goal, prioritize essentials, reduce discretionary spending, create step-by-step actions";
  const res = await client.callTool({
    name: "solve",
    arguments: {
      task,
      iterations: 8,
      config: { useSampling: true, numCandidates: 5, topM: 2 },
      outputPath: "demo-summary.json",
      outputFormat: "json"
    }
  });
  const raw = getText(res.content as ToolContent[]) || "";
  let payload: any = {};
  try { payload = JSON.parse(raw); } catch {}
  const summary = payload?.summary ?? "(no summary)";
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  console.log("SUMMARY:", summary);
  if (steps.length) {
    console.log("STEPS (first 5):");
    for (const s of steps.slice(0, 5)) console.log("-", s.text);
  }

  await client.close();
}

run().catch(err => {
  console.error(err?.stack || String(err));
  (globalThis as any).process?.exit?.(1);
});