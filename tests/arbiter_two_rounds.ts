import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type ToolContent = { type: string; [k: string]: unknown };

function getText(content: ToolContent[]): string | undefined {
  return (content.find(c => c.type === "text") as any)?.text as string | undefined;
}

function parsePrimary<T>(content: ToolContent[]): T | null {
  const txt = getText(content);
  if (!txt) return null;
  try { return JSON.parse(txt) as T; } catch {}
  const s = txt.indexOf("{");
  const e = txt.lastIndexOf("}");
  if (s >= 0 && e > s) {
    const slice = txt.slice(s, e + 1);
    try { return JSON.parse(slice) as T; } catch {}
  }
  return null;
}

async function writeFileSafe(path: string, data: string) {
  try {
    const fsMod: any = await (new Function("return import('fs')")());
    if (fsMod?.promises?.writeFile) {
      await fsMod.promises.writeFile(path, data, { encoding: "utf8" });
    }
  } catch {}
}

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

async function main() {
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
  const client = new Client({ name: "rb-arbiter-demo", version: "0.1.0" }, { capabilities: { tools: {}, prompts: {}, resources: {}, sampling: {} } });

  // Minimal sampling handler (mock) to satisfy MCP sampling if no API keys are present
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const userMsg = request.params?.messages?.find(m => m.role === "user");
    const text = (userMsg as any)?.content?.text as string | undefined;
    const match = text?.match(/(?:Output|Return)\s+exactly\s+(\d+)/i);
    const k = Math.max(1, Math.min(8, Number(match?.[1] ?? 5)));
    const templates = [
      "Define one measurable subgoal and the success criterion.",
      "Design a quick experiment that isolates one factor.",
      "Compare two small alternatives; pick one by a clear rule.",
      "Record the outcome and update the option set.",
      "Check a constraint/assumption blocking progress.",
    ];
    const hows = [
      "Criterion is binary and testable on task terms.",
      "Only one variable changes; capture before/after metric.",
      "Rule computed on both options produces a strict winner.",
      "State delta lists removals/additions with reason.",
      "Find counterexample or confirm with a minimal test.",
    ];
    const items = Array.from({ length: k }, (_, i) => ({
      text: templates[i % templates.length],
      rationale: "Sampling mock: concise next step",
      how_to_verify: hows[i % hows.length],
    }));
    return { model: "demo-mock", role: "assistant", content: { type: "text", text: JSON.stringify(items) } } as any;
  });

  await client.connect(transport);

  const taskArg = getArg("--task") || "Plan a three-sprint MVP for scheduling feature with measurable outcomes.";
  const iterations = Math.max(1, Number(getArg("--iterations") ?? 2));

  // Start session without seed hints
  const startRes = await client.callTool({
    name: "start",
    arguments: {
      task: taskArg,
      config: { useSampling: true, numCandidates: 7, topM: 2, beamWidth: 2, beamDepth: 2, minImprovement: 0.01 }
    }
  });
  const startPayload: any = parsePrimary<any>(startRes.content as ToolContent[]) || {};
  const sessionId: string = String(startPayload?.sessionId || "").trim();
  if (!sessionId) throw new Error("start did not return sessionId");

  // Round 1: one step
  const s1 = await client.callTool({ name: "step", arguments: { sessionId, overrideNumCandidates: 7 } });
  const p1: any = parsePrimary<any>(s1.content as ToolContent[]) || {};
  const candidates: Array<any> = Array.isArray(p1?.candidates) ? p1.candidates : [];
  const chosen: any = p1?.chosen;
  const pickHints: string[] = [];
  if (chosen?.proposal?.text && typeof chosen?.proposal?.howToVerify === "string") pickHints.push(chosen.proposal.text);
  for (const c of candidates) {
    if (pickHints.length >= 3) break;
    const t = c?.proposal?.text;
    const hv = c?.proposal?.howToVerify;
    if (typeof t === "string" && typeof hv === "string") {
      if (!pickHints.includes(t)) pickHints.push(t);
    }
  }

  // Round 2: one step with arbiter-provided hints
  const iters2 = Math.max(1, iterations - 1);
  for (let i = 0; i < iters2; i++) {
    await client.callTool({ name: "step", arguments: { sessionId, overrideNumCandidates: 7, addHints: pickHints } });
  }

  const sumRes = await client.callTool({ name: "summarize", arguments: { sessionId } });
  const summary = getText(sumRes.content as ToolContent[]) || "(no summary)";
  const stateRes = await client.callTool({ name: "get-state", arguments: { sessionId } });
  const ses: any = parsePrimary<any>(stateRes.content as ToolContent[]) || {};
  const out = { sessionId, summary, steps: ses?.state?.steps ?? [], hints: ses?.state?.hints ?? [], config: ses?.config };
  await writeFileSafe("arbiter-2round.json", JSON.stringify(out, null, 2));

  console.log("ARB_SUMMARY:", summary);
  if (Array.isArray(out.steps)) {
    console.log("ARB_STEPS (first 5):");
    for (const s of out.steps.slice(0, 5)) console.log("-", s.text);
  }
  if (Array.isArray(out.hints) && out.hints.length) {
    console.log("ARB_HINTS:");
    for (const h of out.hints.slice(-5)) console.log("-", h);
  }

  await client.close();
}

main().catch(err => {
  console.error(err?.stack || String(err));
  (globalThis as any).process?.exit?.(1);
});


