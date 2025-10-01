## Reasoning Booster MCP Server

An MCP server that implements a minimal, domain‑agnostic "reasoning booster" pipeline: it iteratively generates candidate micro‑steps (optional LLM sampling via MCP; otherwise diversified fallbacks), scores them with a verifier, applies the best step, and finally returns a concise summary.

### Installation

```bash
cd mcp-reasoning-booster
npm install
npm run build
```

### Development

```bash
npm run dev
```

### Quickstart (one-shot)

Call the `solve` tool once; it will start a session, run N iterations, and return a summary plus steps:

```json
{ "task": "your task", "iterations": 8, "config": { "useSampling": true, "numCandidates": 5, "topM": 2 } }
```

### AI usage (for MCP-enabled agents)

- Server: `reasoning-booster` (stdio)
- Primary tool: `solve`
- Call shape (tools/call):
```json
{
  "name": "solve",
  "arguments": {
    "task": "your task here",
    "iterations": 8,
    "config": { "useSampling": true, "numCandidates": 5, "topM": 2 },
    "outputPath": "./summary.json",
    "outputFormat": "json"
  }
}
```
- Expected result: `content[0].text` is a JSON string with:
```json
{ "sessionId": "ses_xxx", "summary": "Summary: ...", "steps": [ { "index": 0, "text": "..." } ], "config": { ... } }
```
- Optional server-side output:
  - If `outputPath` is provided, the server will also write the result to disk.
  - `outputFormat`: "json" (default) or "text" (summary only).
- Policy for agents:
  - Prefer `solve` (one shot). If more refinement is needed, optionally call `step` with `{ "sessionId": "...", "overrideNumCandidates": 7 }` then `summarize`.
  - If client does not support sampling, omit `useSampling`; server falls back to heuristic proposals.
  - On stagnation, increase `iterations` to 12 or `numCandidates` to 7–9.

### Provider selection order (automatic)

The server chooses how to generate candidates in this priority order:

1) Direct HTTP (API keys present) – preferred
   - Put keys into `secrets.local.txt` (or `secrets.txt`) in `mcp-reasoning-booster/`:
     ````
     # Cerebras
     CEREBRAS_API_KEY=...
     CEREBRAS_MODEL=qwen-3-235b-a22b-thinking-2507
     CEREBRAS_BASE_URL=https://api.cerebras.ai/v1

     # (Optional) OpenAI
     OPENAI_API_KEY=...
     OPENAI_MODEL=gpt-4o-mini
     OPENAI_BASE_URL=https://api.openai.com/v1
     ````
   - If any API key is present, server uses that provider and sets `diagnostics.provider` accordingly.

2) MCP Sampling (no keys, client supports sampling)
   - If the MCP client advertises `sampling`, server calls `createMessage` via client.
   - Output shows `diagnostics.provider: "mcp"` and the client’s model.

3) Heuristic fallback (no keys, no sampling)
   - Diversified heuristic steps without external models.

No extra flags needed: `solve` auto‑enables sampling if keys exist or client supports sampling.

### MCP client integration

Example configuration (in an MCP‑compatible client):

```json
{
  "mcpServers": {
    "reasoning-booster": {
      "command": "node",
      "args": ["./dist/index.js"],
      "cwd": "${workspaceFolder}/mcp-reasoning-booster"
    }
  }
}
```

#### Universal MCP client setup (CLI‑agnostic)

Most MCP clients (Claude CLI/Desktop, other MCP‑enabled CLIs) accept a JSON config with a `mcpServers` map. Add our server like this:

```json
{
  "mcpServers": {
    "reasoning-booster": {
      "command": "node",
      "args": ["./dist/index.js"],
      "cwd": "./mcp-reasoning-booster",
      "transport": "stdio"
    }
  }
}
```

- Place/path depends on your client (see its docs). The shape above is portable across MCP clients.
- Server auto‑selects provider: API keys (from `secrets.local.txt`/env) > MCP sampling (client’s model) > heuristic fallback.

Tool call payload (what MCP clients send under the hood):

```json
{
  "name": "solve",
  "arguments": {
    "task": "your concrete task",
    "iterations": 8,
    "outputPath": "./summary.json",
    "outputFormat": "json"
  }
}
```

If your CLI supports direct "tools/call", pass the payload above; otherwise ask the CLI agent to call tool `solve` with those arguments.

#### Claude CLI/Desktop (MCP sampling)

If you use Claude CLI/Desktop with MCP enabled, add the server to its config so the client exposes the sampling capability to our server.

Example `claude.config.json` (path depends on platform):

```json
{
  "mcpServers": {
    "reasoning-booster": {
      "command": "node",
      "args": ["./dist/index.js"],
      "cwd": "./mcp-reasoning-booster"
    }
  }
}
```

How to use inside Claude chat/session:

- Ask Claude to call the `solve` tool with your task. The client will route the request via MCP and our server will use MCP sampling (no API keys needed). You should see `diagnostics.provider: "mcp"` and the client’s model in the JSON output.

Minimal tool call payload (what the client sends under the hood):

```json
{
  "name": "solve",
  "arguments": {
    "task": "your concrete task",
    "iterations": 8,
    "outputPath": "./summary.json",
    "outputFormat": "json"
  }
}
```

### Tools

- **start**: initialize a session
  - input: `{ task: string, config?: { maxSteps?, numCandidates?, topM?, allowBacktrack?, wRules?, wRedundancy?, wConsistency?, useSampling?, samplingMaxTokens? } }`
  - returns: `sessionId` plus initial `state` and effective `config`
- **step**: run one iteration (Best‑of‑N → scoring → apply → meta‑control)
  - input: `{ sessionId: string, overrideNumCandidates?: number }`
  - returns: `chosen`, `candidates` and updated `state`
- **get-state**: return the current session state
  - input: `{ sessionId: string }`
- **summarize**: produce a short summary from the scratchpad
  - input: `{ sessionId: string }`
 - **multi-step**: run multiple iterations in a single call
  - input: `{ sessionId: string, iterations: number, overrideNumCandidates?: number }`
 - **solve**: one-shot run (start → N iterations → summarize)
  - input: `{ task: string, iterations?: number, config?: { ...same as start } }`

### Notes

- Candidate generation uses LLM sampling via MCP if available; otherwise it falls back to diversified heuristic templates.

### Configuration tips

- `useSampling=true` enables LLM sampling through MCP. Keep responses JSON‑only as required by the prompt.
- `minImprovement` (e.g. 0.01) enables stagnation control; if the best candidate does not improve the score, a shallow beam can be tried.
- `beamWidth` and `beamDepth` control a small beam search that compares a few short branches by cumulative score.
- The verifier implements domain‑agnostic heuristics (length, vagueness, redundancy, weak consistency). Weights are configurable.
- State is in‑memory and ephemeral. The server exposes the `tools` capability over stdio.

### Tests

- Smoke test (basic end‑to‑end):
```bash
npm run smoke
```
Validates tool registration, one‑step iteration loop and summary.

- Quality test (stronger checks):
```bash
npm run quality
```
Checks ordering by `totalScore`, that the chosen step equals Top‑1, enforces length bounds, limits duplicate chosen steps across iterations, and ensures monotonic growth of `state.steps` (with `allowBacktrack=false`).

### Possible extensions

- Enable MCP sampling to generate steps with a model
- Short beam search within a fixed budget
- Persistent session storage (file/DB)
- Richer verifier and PRM integration
