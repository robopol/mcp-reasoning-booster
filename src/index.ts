import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Session } from "./types.js";
import { registerTools } from "./server/registerTools.js";
import type { ToolDef } from "./server/toolRegistry.js";

const server = new Server({ name: "reasoning-booster", version: "0.1.0" }, { capabilities: { tools: {} } });
const sessions = new Map<string, Session>();
const toolRegistry = new Map<string, ToolDef>();

registerTools({ server, toolRegistry, sessions });

// MCP tools/list and tools/call handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const list = Array.from(toolRegistry.values());
  // Ensure 'usage' appears first for immediate discoverability
  list.sort((a, b) => (a.name === "usage" ? -1 : (b.name === "usage" ? 1 : 0)));
  const tools = list.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
  return { tools } as any;
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const def = toolRegistry.get(name);
  if (!def) throw new Error(`Unknown tool: ${name}`);
  const result = await def.handler(args);
  return result as any;
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Reasoning Booster MCP server running on stdio...");
}

main().catch((err) => {
  console.error("Server error:", err);
});

