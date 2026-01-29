import type { SessionStore } from "../../state/sessionStore.js";
import type { ToolDef } from "../toolRegistry.js";
import { asJson } from "../utils/common.js";

export function makeGetStateTool(params: { sessionStore: SessionStore }): ToolDef {
  const { sessionStore } = params;

  return {
    name: "get-state",
    description: "Return the current scratchpad state for a session. Result: PRIMARY JSON is in content[0].text.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      additionalProperties: false
    },
    handler: async (args: Record<string, unknown>) => {
      const sessionId = String((args as any).sessionId ?? "");
      const session = sessionStore.get(sessionId);
      if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);
      return { content: [ { type: "text", text: asJson(session) } ] };
    }
  };
}

