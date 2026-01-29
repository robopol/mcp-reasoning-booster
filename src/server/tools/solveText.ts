import type { ToolDef } from "../toolRegistry.js";

export function makeSolveTextTool(params: { toolRegistry: Map<string, ToolDef> }): ToolDef {
  const { toolRegistry } = params;

  return {
    name: "solve-text",
    description: "One-shot reasoning with plain text primary output. content[0].text is the human-readable summary.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task or goal description (required)" },
        iterations: { type: "number", description: "How many iterations to run", default: 8 },
        config: { type: "object" },
        seedHints: { type: "array", items: { type: "string" } },
        outputPath: { type: "string", description: "Optional file path to save the text summary" }
      },
      required: ["task"],
      additionalProperties: false
    },
    handler: async (args: Record<string, unknown>) => {
      const solve = toolRegistry.get("solve");
      if (!solve) throw new Error("Missing tool: solve");
      const res = await solve.handler({
        task: (args as any).task,
        iterations: (args as any).iterations,
        config: (args as any).config,
        seedHints: (args as any).seedHints,
        outputPath: (args as any).outputPath,
        outputFormat: "text"
      });
      const textBlocks = (res?.content || []).map((c: any) => (typeof c?.text === "string" ? c.text : ""));
      let summaryText = "";
      for (const t of textBlocks) {
        if (t && !t.trim().startsWith("{")) { summaryText = t; break; }
      }
      if (!summaryText) {
        try {
          const payload = JSON.parse(textBlocks[0] || "{}");
          summaryText = String(payload?.summary || "(no summary)");
        } catch { summaryText = "(no summary)"; }
      }
      return { content: [ { type: "text", text: summaryText } ] };
    }
  };
}

