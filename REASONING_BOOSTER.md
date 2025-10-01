## Reasoning Booster: domain‑agnostic MCP server for structured, verifiable thinking

Purpose: provide Large Language Models a structured way to “think” without changing model weights. The booster acts as a thin orchestration layer: it forces small, local, verifiable steps; uses redundancy and scoring; applies metacontrol; and returns a concise summary. It is implemented as a Model Context Protocol (MCP) server in TypeScript.

### 1) Pipeline overview
- Inference/runtime:
  - Orchestrator manages iterations, budget and search.
  - LLM proposes small candidate steps (optional, via MCP sampling or direct HTTP providers; otherwise diversified heuristics).
  - Verifier scores candidates with simple domain‑agnostic heuristics.
  - Best‑of‑N or short beam chooses a step to apply to the scratchpad.
  - Metacontrol detects stagnation/loops and backtracks or perturbs if needed.
  - Finalization produces a brief summary grounded in the performed steps.

### 2) Components
- Orchestrator:
  - Generates K candidates per iteration.
  - Scores, selects, applies; maintains state and history.
  - Supports short beam search and stagnation threshold control.
- Structured scratchpad (state):
  - Keeps task, ordered steps with rationales and scores, timestamps.
- Step generator (LLM or fallback):
  - Prompts the model to return exactly K JSON items `{ text, rationale }`.
  - If the model replies in prose, a prose→JSON parser extracts bullet/numbered list steps.
  - If no sampling is available, falls back to diversified heuristic templates.
- Verifier (heuristic):
  - Penalizes vagueness and redundancy; rewards short, local and consistent steps.
  - Weighted scores: `wRules`, `wRedundancy`, `wConsistency` → `totalScore`.
- Search and choice:
  - Best‑of‑N; optional shallow beam across Top‑M heads for a few depths.
- Metacontrol:
  - Detects repeated/looping steps; guards with `minImprovement` threshold; optional backtrack.

### 3) MCP server implementation (TypeScript)
- SDK: `@modelcontextprotocol/sdk` (stdio server).
- Transport: stdio (works across MCP‑capable CLIs and apps).
- Tools exposed:
  - `start`: initialize session and scratchpad
  - `step`: run one iteration (generate → score → apply → meta)
  - `multi-step`: run N iterations in a single call
  - `get-state`: return current session state
  - `summarize`: produce brief summary from state
  - `solve`: one‑shot (start → N iterations → summarize) with optional file output

#### Provider selection order (automatic)
The server auto‑decides how to generate candidates:
1) Direct HTTP providers (preferred if keys are present)
   - Keys are loaded from `mcp-reasoning-booster/secrets.local.txt` (or `secrets.txt`) and env.
   - Supported now: Cerebras (recommended default) and OpenAI.
   - Example (`secrets.local.txt`):
     ```
     CEREBRAS_API_KEY=...
     CEREBRAS_MODEL=qwen-3-235b-a22b-thinking-2507
     CEREBRAS_BASE_URL=https://api.cerebras.ai/v1

     # optional
     OPENAI_API_KEY=...
     OPENAI_MODEL=gpt-4o-mini
     OPENAI_BASE_URL=https://api.openai.com/v1
     ```
   - Diagnostics will show `provider: "cerebras" | "direct-openai"` and the model id.
2) MCP sampling (no keys, but client exposes `sampling` capability)
   - The server calls `createMessage` via the client; diagnostics show `provider: "mcp"` and the client’s model.
3) Heuristic fallback (no keys and no MCP sampling)
   - Diversified, domain‑agnostic templates are used to ensure progress.

### 4) Orchestrator details
- Candidate generation prompt:
  - Requests “exactly K items” in pure JSON: `[{ "text": "...", "rationale": "..." }]`.
  - Enforces short (≤200 chars) and verifiable steps.
- Robust parsing:
  - First, attempts strict JSON parse.
  - If it fails, `parseProseToProposals` extracts steps from bullet/numbered lists in the prose.
  - If still empty, switches to heuristic candidates.
- Scoring and selection:
  - Verifier computes partial scores and weighted `totalScore`.
  - Prefers a candidate that differs from the previous step to avoid repetition.
- Stagnation control:
  - `minImprovement` guards against selecting a step that does not improve score vs. last step.
  - If enabled and no improvement, shallow beam search can be tried (`beamWidth`, `beamDepth`).
- Metacontrol:
  - Loop/stagnation detection; optional `allowBacktrack` to drop last step.
- Summary:
  - Builds a concise summary from the last distinct 3–5 steps plus the original task.

### 5) Verifier (heuristic, domain‑agnostic)
- Favors:
  - Short, concrete, local actions that can be checked off.
  - Non‑redundant steps that build on recent context.
- Penalizes:
  - Vague or meta statements (e.g., “think harder”, “consider possibilities”).
  - Duplicates and overly long instructions.
- Weights are configurable (`wRules`, `wRedundancy`, `wConsistency`).

### 6) Tools and I/O shapes
- `start`
  - input: `{ task: string, config?: { maxSteps?, numCandidates?, topM?, allowBacktrack?, wRules?, wRedundancy?, wConsistency?, useSampling?, samplingMaxTokens?, minImprovement?, beamWidth?, beamDepth? } }`
  - output: `sessionId`, initial `state`, effective `config`
- `step`
  - input: `{ sessionId: string, overrideNumCandidates?: number }`
  - output: `{ chosen, candidates, state }`
- `multi-step`
  - input: `{ sessionId: string, iterations: number, overrideNumCandidates?: number }`
  - output: `{ state }`
- `get-state`
  - input: `{ sessionId: string }`
  - output: full `session`
- `summarize`
  - input: `{ sessionId: string }`
  - output: text summary
- `solve` (recommended)
  - input: `{ task: string, iterations?: number, config?: { ... }, outputPath?: string, outputFormat?: "json" | "text" }`
  - behavior: start → run N iterations → summarize; if `outputPath` is provided, also writes the result to disk.

### 7) Output format (JSON)
`solve` returns and can write a JSON payload such as:
```json
{
  "sessionId": "ses_xxx",
  "summary": "Summary:...",
  "steps": [
    { "index": 0, "text": "...", "rationale": "...", "score": { "rulesScore": 0.45, "redundancyScore": 0.10, "consistencyScore": 0.05, "totalScore": 0.30 } }
  ],
  "config": { "numCandidates": 5, "topM": 2, "minImprovement": 0.01, "beamWidth": 1, "beamDepth": 2 },
  "diagnostics": {
    "provider": "cerebras|mcp|direct-openai",
    "totalCalls": 12,
    "lastModel": "qwen-3-235b-a22b-thinking-2507",
    "lastPromptChars": 595,
    "lastResponseChars": 3592,
    "lastOkAt": "2025-10-01T12:40:32.502Z",
    "rawSamples": [ { "prompt": "...", "response": "...", "model": "...", "provider": "...", "at": "..." } ]
  }
}
```

### 8) Configuration and keys
- Files:
  - `mcp-reasoning-booster/secrets.local.txt` (preferred for local dev)
  - `mcp-reasoning-booster/secrets.txt` (generic fallback)
  - `mcp-reasoning-booster/config.local.json` or `config.json` (optional, structured override)
- Environment variables are also respected (e.g., `CEREBRAS_API_KEY`, `OPENAI_API_KEY`).
- Selection order is automatic (keys > MCP sampling > heuristics); no extra flags are needed.

### 9) MCP client setup (universal)
- Add the server to your MCP client config (CLI‑agnostic):
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
- Claude CLI/Desktop: the same `mcpServers` shape applies; the client will expose `sampling` to the server.
- Cursor (example) can use `.cursor/mcp.json` with an equivalent entry.

### 10) Quickstart
```bash
cd mcp-reasoning-booster
npm install
npm run build

# Optional: put keys into secrets.local.txt (see above)

# Call via your MCP client by invoking tool "solve" with:
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

### 11) Tests
- Smoke:
```bash
npm run smoke
```
- Quality:
```bash
npm run quality
```
- Demo (one‑shot with file output):
```bash
npm run demo
```

### 12) Design principles
- Prefer small, verifiable, local steps; avoid vague meta‑instructions.
- Enforce JSON‑only responses from the model; recover from prose via parser.
- Track diagnostics to prove actual model calls and aid debugging.
- Keep the orchestrator universal (no domain‑specific templates or assumptions).