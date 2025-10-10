import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
// Note: Avoid importing node:process to keep types simple for Pylance.
// Minimal dynamic import for writing raw preview without type dependencies
async function writeFileSafe(path: string, data: string) {
  try {
    const fsMod: any = await (new Function("return import('fs')")());
    if (fsMod?.promises?.writeFile) {
      await fsMod.promises.writeFile(path, data, { encoding: "utf8" });
    }
  } catch {}
}

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
    const match = text?.match(/(?:Output|Return)\s+exactly\s+(\d+)/i);
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

  // One-shot solve (simplest demo) or multi-round session demo
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
  function hasFlag(flag: string): boolean {
    const argv: string[] = ((globalThis as any).process?.argv ?? []) as string[];
    return argv.includes(flag);
  }
  const taskArg = getArg("--task");
  const taskEnv = (globalThis as any).process?.env?.TASK as string | undefined;
  const showRaw = hasFlag("--show-raw") || (((globalThis as any).process?.env?.SHOW_RAW as string | undefined) === "1");
  const task = (taskArg && taskArg.trim().length > 0)
    ? taskArg
    : (taskEnv && taskEnv.trim().length > 0)
      ? taskEnv
      : "Plan a household monthly budget: categorize expenses, set savings goal, prioritize essentials, reduce discretionary spending, create step-by-step actions";
  const multi = hasFlag("--multi-round");
  if (!multi) {
    const res = await client.callTool({
      name: "solve",
      arguments: {
        task,
        iterations: 10,
        config: { useSampling: true, numCandidates: 7, topM: 2, beamWidth: 2, beamDepth: 2, minImprovement: 0.01 },
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
    // Arbiter-first: show raw and picks
    if (Array.isArray(payload?.arbiterPicks) && payload.arbiterPicks.length) {
      console.log("Arbiter picks:");
      for (const p of payload.arbiterPicks) console.log("-", p);
    }
    if (typeof payload?.lastRawResponse === "string" && payload.lastRawResponse.length) {
      await writeFileSafe("demo-raw.txt", payload.lastRawResponse);
      const preview = payload.lastRawResponse.slice(0, 1200);
      console.log("RAW (preview 1200 chars):\n" + preview + (payload.lastRawResponse.length > 1200 ? "\n... (see demo-raw.txt for full)" : ""));
      if (showRaw && payload.lastRawResponse.length > 1200) {
        console.log("RAW (full):\n" + payload.lastRawResponse);
      }
    }
  } else {
    // Multi-round demo with arbiter-managed hints
    const seedHints = [
      "Define one measurable subgoal and the success criterion.",
      "Design a quick experiment that isolates one factor."
    ];
    const addHints = [
      "Compare two small alternatives; pick one by a clear rule.",
      "Record the outcome and update the option set."
    ];
    const iterationsArg = getArg("--iterations");
    const iterations = Math.max(1, Number(iterationsArg ?? 3));

    const startRes = await client.callTool({
      name: "start",
      arguments: {
        task,
        config: { useSampling: true, numCandidates: 7, topM: 2, beamWidth: 2, beamDepth: 2, minImprovement: 0.01 },
        seedHints
      }
    });
    const startPayload: any = extractJson<any>(startRes.content as ToolContent[]) || {};
    const sessionId: string = String(startPayload?.sessionId || "").trim();
    if (!sessionId) throw new Error("start did not return sessionId");

    await client.callTool({
      name: "multi-step",
      arguments: { sessionId, iterations, overrideNumCandidates: 7, addHints }
    });

    const stateRes = await client.callTool({ name: "get-state", arguments: { sessionId } });
    const sessionPayload: any = extractJson<any>(stateRes.content as ToolContent[]) || {};
    const state = sessionPayload?.state || {};
    const hints: string[] = Array.isArray(state?.hints) ? state.hints : [];

    const sumRes = await client.callTool({ name: "summarize", arguments: { sessionId } });
    const summary = getText(sumRes.content as ToolContent[]) || "(no summary)";

    const payload = { sessionId, summary, steps: Array.isArray(state?.steps) ? state.steps : [], hints, config: sessionPayload?.config };
    await writeFileSafe("demo-summary.json", JSON.stringify(payload, null, 2));

    console.log("SUMMARY:", summary);
    if (Array.isArray(payload.steps) && payload.steps.length) {
      console.log("STEPS (first 5):");
      for (const s of payload.steps.slice(0, 5)) console.log("-", s.text);
    }
    if (hints.length) {
      console.log("HINTS:");
      for (const h of hints.slice(-5)) console.log("-", h);
    }
  }

  await client.close();
}

run().catch(err => {
  console.error(err?.stack || String(err));
  (globalThis as any).process?.exit?.(1);
});