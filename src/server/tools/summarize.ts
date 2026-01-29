import type { SessionStore } from "../../state/sessionStore.js";
import { summarizeSolution } from "../../orchestrator.js";
import type { ToolDef } from "../toolRegistry.js";
import { asJson } from "../utils/common.js";

export function makeSummarizeTool(params: { sessionStore: SessionStore }): ToolDef {
  const { sessionStore } = params;

  return {
    name: "summarize",
    description: "Summarize the solution based on the scratchpad. PRIMARY content[0].text is JSON mirror { sessionId, summary }. content[1].text is human-readable summary for convenience.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      additionalProperties: false
    },
    handler: async (args: Record<string, unknown>) => {
      const sessionId = String((args as any).sessionId ?? "");
      const session = sessionStore.get(sessionId);
      if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);
      const summary = summarizeSolution(session.state);
      const jsonMirror = asJson({ sessionId, summary });
      return { content: [ { type: "text", text: jsonMirror }, { type: "text", text: summary } ] };
    }
  };
}

