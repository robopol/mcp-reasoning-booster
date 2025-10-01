import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolContent = { type: string; [k: string]: unknown };

function tryExtractJson<T>(content: ToolContent[]): T | null {
  for (const c of content) {
    if (c.type === "text" && typeof (c as any).text === "string") {
      const t = (c as any).text as string;
      const start = t.indexOf("{");
      const end = t.lastIndexOf("}");
      if (start >= 0 && end > start) {
        const slice = t.slice(start, end + 1);
        try { return JSON.parse(slice) as T; } catch {}
      }
      try { return JSON.parse(t) as T; } catch {}
    }
  }
  return null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run() {
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
  const client = new Client({ name: "rb-quality", version: "0.1.0" }, { capabilities: { tools: {}, prompts: {}, resources: {}, sampling: {} } });
  await client.connect(transport);

  // Tools presence
  const tools = await client.listTools();
  const names = new Set(tools.tools.map(t => t.name));
  assert(names.has("start") && names.has("step") && names.has("get-state") && names.has("summarize"), "Quality: required tools missing");

  // Start session with explicit config
  const start = await client.callTool({ name: "start", arguments: { task: "Quality test task", config: { numCandidates: 5, topM: 2, allowBacktrack: false } } });
  const startJson = tryExtractJson<{ sessionId: string } & Record<string, unknown>>(start.content as ToolContent[]);
  assert(startJson && typeof (startJson as any).sessionId === "string", "Quality: missing sessionId");
  const sessionId = (startJson as any).sessionId as string;

  const iterations = 8;
  let prevChosenText: string | undefined;
  let duplicateCount = 0;
  let chosenTopCount = 0;
  let orderOkCount = 0;
  let lengthOkCount = 0;

  for (let i = 0; i < iterations; i++) {
    const stepRes = await client.callTool({ name: "step", arguments: { sessionId } });
    const data = tryExtractJson<any>(stepRes.content as ToolContent[]);
    assert(data && data.chosen && Array.isArray(data.candidates), `Quality: invalid step JSON at iter ${i}`);

    const chosen = data.chosen;
    const candidates = data.candidates as Array<any>;

    // candidate list length == topM (2)
    assert(candidates.length === 2, `Quality: expected 2 candidates, got ${candidates.length} at iter ${i}`);

    // ensure ordered by totalScore desc
    if (candidates[0].score.totalScore >= candidates[1].score.totalScore) orderOkCount++;

    // ensure chosen equals top-1
    if (
      chosen.proposal.text === candidates[0].proposal.text &&
      Math.abs(chosen.score.totalScore - candidates[0].score.totalScore) < 1e-9
    ) {
      chosenTopCount++;
    }

    // length bound
    if (typeof chosen.proposal.text === "string" && chosen.proposal.text.length <= 400) lengthOkCount++;

    // duplicates with previous chosen text
    if (prevChosenText && prevChosenText.trim() === String(chosen.proposal.text).trim()) duplicateCount++;
    prevChosenText = String(chosen.proposal.text);
  }

  // Validate aggregate metrics
  assert(orderOkCount === iterations, `Quality: ordering failed in ${iterations - orderOkCount} iterations`);
  assert(chosenTopCount === iterations, `Quality: chosen not top-1 in ${iterations - chosenTopCount} iterations`);
  assert(lengthOkCount === iterations, `Quality: length bound failed in ${iterations - lengthOkCount} iterations`);
  // allow at most 50% exact duplicate rate
  assert(duplicateCount <= Math.floor(iterations / 2), `Quality: too many duplicate chosen steps (${duplicateCount}/${iterations})`);

  // State and summarize checks
  const stateRes = await client.callTool({ name: "get-state", arguments: { sessionId } });
  const stateJson = tryExtractJson<any>(stateRes.content as ToolContent[]);
  assert(stateJson && stateJson.state && Array.isArray(stateJson.state.steps), "Quality: invalid state JSON structure");
  assert(stateJson.state.steps.length >= iterations, "Quality: state.steps length lower than iterations");

  const sumRes = await client.callTool({ name: "summarize", arguments: { sessionId } });
  const summaryText = (sumRes.content.find(c => (c as any).type === "text") as any)?.text as string | undefined;
  assert(summaryText && summaryText.toLowerCase().includes("summary:"), "Quality: summarize lacks expected prefix");

  await client.close();
  if (typeof (transport as any).close === "function") await (transport as any).close();
}

run().catch(err => {
  console.error(err?.stack || String(err));
  (globalThis as any).process?.exit?.(1);
});


