export type ToolHandler = (
  args: Record<string, unknown>
) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
};

