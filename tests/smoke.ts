import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolContent = { type: "text"; text: string } | { type: string; [k: string]: unknown };

function extractJson<T>(content: ToolContent[]): T | null {
  for (const c of content) {
    if ((c as any).type === "text") {
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

async function run() {
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
  const client = new Client({ name: "rb-smoke", version: "0.1.0" }, { capabilities: { tools: {}, prompts: {}, resources: {}, sampling: {} } });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = new Set(tools.tools.map(t => t.name));
  if (!names.has("start") || !names.has("step") || !names.has("get-state") || !names.has("summarize")) {
    throw new Error("Smoke: required tools are missing");
  }

  const start = await client.callTool({ name: "start", arguments: { task: "Test task: simple reasoning", config: { numCandidates: 4 } } });
  const startJson = extractJson<{ sessionId: string } & Record<string, unknown>>(start.content as ToolContent[]);
  if (!startJson || typeof (startJson as any).sessionId !== "string") {
    throw new Error("Smoke: cannot extract sessionId from start result");
  }
  const sessionId = (startJson as any).sessionId as string;

  for (let i = 0; i < 3; i++) {
    const stepRes = await client.callTool({ name: "step", arguments: { sessionId } });
    if (!Array.isArray(stepRes.content) || stepRes.content.length === 0) {
      throw new Error("Smoke: step returned empty content");
    }
  }

  const stateRes = await client.callTool({ name: "get-state", arguments: { sessionId } });
  const stateJson = extractJson<{ state: { steps: Array<unknown> } }>(stateRes.content as ToolContent[]);
  if (!stateJson || typeof stateJson !== "object" || !stateJson.state || !Array.isArray(stateJson.state.steps)) {
    throw new Error("Smoke: invalid state JSON");
  }
  if (stateJson.state.steps.length < 1) {
    throw new Error("Smoke: expected at least 1 step in state");
  }

  const sumRes = await client.callTool({ name: "summarize", arguments: { sessionId } });
  const summaryText = (sumRes.content.find(c => (c as any).type === "text") as any)?.text as string | undefined;
  if (!summaryText || !summaryText.toLowerCase().includes("summary:")) {
    throw new Error("Smoke: summarize did not return expected summary prefix");
  }

  // Ensure clean shutdown so child server process exits
  await client.close();
  if (typeof (transport as any).close === "function") {
    await (transport as any).close();
  }
}

run().catch(err => {
  console.error(err?.stack || String(err));
  (globalThis as any).process?.exit?.(1);
});


