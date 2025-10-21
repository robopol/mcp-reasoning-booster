## Reasoning Booster MCP (concise, production-ready)

Reasoning Booster is an MCP server that implements a universal "reasoning booster" pipeline: it iteratively generates candidate micro‑steps (via LLM sampling — MCP or direct HTTP; if no keys are present, it uses diversified heuristics), scores them with a verifier, applies the best step, and finally returns a concise summary. The booster is an idea generator; the arbiter (your AI/agent) composes the final answer from the produced steps.

What it provides:
- Micro‑steps (≤ 200 chars) with `rationale` and `how_to_verify`; optional `verification.outcomes` (VoI/IG).
- Scoring: brevity/concreteness, information gain (entropy), novelty vs. history, consistency; a short VoI‑aware beam.
- Diagnostics: `provider`, `lastModel`, `rawSamples` — audit of whether LLM/MCP/heuristics were used.
- Robust parsing: JSON extraction, `<think>…</think>` stripping, heuristic fallback when raw output is weak.
- Session tools (`start`, `step`, `multi-step`, `summarize`, `solve`); the primary result is always in `content[0].text` (JSON).

### Install
```bash
cd mcp-reasoning-booster
npm install && npm run build
```

### MCP client configuration (mcp.json)
Add the server under your MCP-enabled client config. The exact file location depends on your client (see its docs). A portable shape:

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

Notes:
- Prefer absolute or workspace-relative `cwd` (example assumes the repo root contains `mcp-reasoning-booster/`).
- API keys are read from `mcp-reasoning-booster/secrets.local.txt` or `secrets.txt` (preferred). You do not need to place keys in `mcp.json`.
- Optional fallback: environment variables `OPENAI_API_KEY`, `OPENAI_MODEL`, `CEREBRAS_API_KEY`, `CEREBRAS_MODEL`, `OPENAI_BASE_URL`, `CEREBRAS_BASE_URL` are supported if present.

### Tooling contract (parse-first)
- Primary output is always JSON in `content[0].text`.
- Tools and inputs:
  - `solve`: `{ task, iterations?, config?, seedHints?, outputPath?, outputFormat? }`
    - Returns JSON: `{ sessionId, summary, steps, hints, config, diagnostics, arbiterPicks, lastRawResponse }` (always includes `arbiterPicks` and `lastRawResponse`)
  - `start`: `{ task, config?, seedHints? }` → `{ sessionId, state, config }`
  - `step`: `{ sessionId, overrideNumCandidates?, addHints? }` → `{ chosen, candidates, state }`
  - `multi-step`: `{ sessionId, iterations, overrideNumCandidates?, addHints? }` → `{ state }`
  - `get-state`: `{ sessionId }` → full session object (JSON)
  - `summarize`: `{ sessionId }` → `content[0].text` is JSON `{ sessionId, summary }`, `content[1].text` is human-readable text
  - `solve-text`: `{ task, iterations?, config?, seedHints?, outputPath? }` → primary output is plain text summary

Client rule: always JSON.parse the first text content; additional text blocks are only for convenience.

### Quickstart (one-shot)
Call `solve` once and parse JSON from `content[0].text`:
```json
{ "name": "solve", "arguments": { "task": "your task", "iterations": 8, "config": { "useSampling": true, "numCandidates": 5 } } }
```
If you pass `outputPath`, the same payload is also written to disk; otherwise no files are written.

Plain text (no JSON parsing) via `solve-text`:
```json
{ "name": "solve-text", "arguments": { "task": "your task", "iterations": 8, "config": { "useSampling": true, "numCandidates": 5 } } }
```

### Sampling priority
1) Direct HTTP (Cerebras/OpenAI) if API keys are present
2) MCP sampling (client exposes `sampling`)
3) Heuristic fallback (no LLM)

Notes:
- Cerebras requires BOTH `CEREBRAS_API_KEY` and `CEREBRAS_MODEL`; no hardcoded model fallback.

### Recommended settings
- Strong models: `numCandidates: 7–9`, `samplingMaxTokens: 2000–4000`, `beamWidth: 2`, `beamDepth: 2`, `llmMaxCalls: 12–24`, `voiAlpha: 0.5–0.8`
- Control budget: cap `llmMaxCalls`; if stagnating, increase `iterations` or `numCandidates`

### Demo
```bash
npx --yes tsx tests/demo_sampling.ts --task "Plan a 3-step experiment to test if X causes Y under constraint Z."
```

### Secrets file format
Create `mcp-reasoning-booster/secrets.local.txt`:
```
CEREBRAS_API_KEY=...
CEREBRAS_MODEL=qwen-3-235b-a22b-thinking-2507
CEREBRAS_BASE_URL=https://api.cerebras.ai/v1
# Optional OpenAI
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

### Run from shell (OS-specific)

- Windows PowerShell 5.x (production, real LLM):
```powershell
Set-Location mcp-reasoning-booster; npm run build; npx --yes tsx tests\demo_sampling.ts --task "Your task here"
```

- PowerShell 7+ (pwsh) or cmd.exe (production, real LLM):
```bash
cd mcp-reasoning-booster && npm run build && npx --yes tsx tests\demo_sampling.ts --task "Your task here"
```

- Bash (macOS/Linux) (production, real LLM):
```bash
cd mcp-reasoning-booster && npm run build && npx tsx tests/demo_sampling.ts --task 'Your task here'
```

- Windows PowerShell 5.x (mock, offline test only):
```powershell
Set-Location mcp-reasoning-booster; npm run build; npx --yes tsx tests\demo_sampling.ts --sampling=mock --task "Plan a tiny A/B test to choose CTA color with a measurable metric"
```

- PowerShell 7+ (pwsh) or cmd.exe (mock):
```bash
cd mcp-reasoning-booster && npm run build && npx --yes tsx tests\demo_sampling.ts --sampling=mock --task "Plan a tiny A/B test to choose CTA color with a measurable metric"
```

- Bash (macOS/Linux) (mock):
```bash
cd mcp-reasoning-booster && npm run build && npx tsx tests/demo_sampling.ts --sampling=mock --task 'Plan a tiny A/B test to choose CTA color with a measurable metric'
```

### Usage tool (for AI clients)
- First call `usage` to get copy/paste how‑to, `mcp.json` template, OS shell commands, and examples.
- `usage` returns its PRIMARY payload as JSON in `content[0].text`.

