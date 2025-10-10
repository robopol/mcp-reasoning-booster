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

Call the `solve` tool once; it will start a session, run N iterations, and return a JSON result in the MCP response. This JSON is the primary output.

```json
{ "task": "your task", "iterations": 8, "config": { "useSampling": true, "numCandidates": 5, "topM": 2 } }
```

### Terminal demo (PowerShell and Bash)

- PowerShell (Windows):
```bash
cd mcp-reasoning-booster
npm run build
npx --yes tsx tests\demo_sampling.ts --task "Plan a 3-step experiment to test if X causes Y under constraint Z."
```

- Bash (macOS/Linux):
```bash
cd mcp-reasoning-booster
npm run build
npx tsx tests/demo_sampling.ts --task 'Plan a 3-step experiment to test if X causes Y under constraint Z.'
```

Notes:
- The demo script accepts only `--task` (no env vars needed). This avoids quoting issues.
- The MCP server returns the PRIMARY JSON inline; the demo also writes a copy to `demo-summary.json` via `outputPath`.

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
- Expected result (primary): the MCP response’s `content[0].text` contains a JSON string with (fields may vary slightly by tool):
```json
{
  "sessionId": "ses_xxx",
  "summary": "Summary: ...",
  "steps": [ { "index": 0, "text": "...", "rationale": "...", "howToVerify": "..." } ],
  "hints": ["..."],
  "config": { ... },
  "diagnostics": { "provider": "...", "lastModel": "..." },
  "arbiterPicks": ["..."],
  "lastRawResponse": "..."
}
```
- Optional server-side file output: If `outputPath` is provided, the server also writes the result to disk. `outputFormat`: "json" (default) or "text" (summary only). This is optional; clients should primarily read the JSON returned in the MCP response.

#### Where to read the result (MCP contract)
- On every `tools/call` for `solve`, the PRIMARY result is returned inline in the MCP response under `content[0].text` as a JSON string. Your agent MUST parse this JSON to proceed.
- Do not rely on console logs or non‑JSON text; always parse the JSON from the `content` array.
- When `outputPath` is provided, the server writes the SAME payload to the specified file, but your agent should still parse the inline JSON it already received.
- Typical shape of the parsed JSON:
  - `sessionId`: string
  - `summary`: short text summary
  - `steps`: array of steps `{ index, text, rationale, howToVerify?, expectedOutcomes?, score? }`
  - `hints`: promoted cross‑branch ideas (string[])
  - `config`: effective booster config
  - `diagnostics`: sampler info (e.g., provider, lastModel, rawSamples)
  - `arbiterPicks`: decisive sentences extracted from raw LLM prose (solve)
  - `lastRawResponse`: full raw text of the last LLM response (solve)

### Verification contract and VoI (new)

- Steps may include a structured `verification` block:
```json
{
  "text": "Weigh 4 vs 4.",
  "rationale": "Maximize info",
  "verification": {
    "kind": "weighing",
    "procedure": "Place coins A,B,C,D vs E,F,G,H",
    "outcomes": [
      { "label": "balance", "rule": "no difference", "stateUpdate": "narrow outside compared sets" },
      { "label": "left", "rule": "left heavier or right lighter" },
      { "label": "right", "rule": "right heavier or left lighter" }
    ],
    "cost": 1,
    "logFields": ["leftSet","rightSet","tilt"]
  }
}
```

- The verifier prioritizes steps with multiple distinguishable outcomes (information gain). We compute an entropy‑like IG and **Value‑of‑Information (VoI) = IG/(1+cost)**. Beam selection uses a VoI‑aware UCB.

### New config fields

- `voiAlpha` (default 0.5): weight of the VoI prior in UCB beam selection.
- `executeVerification` (default false): if true, the recommended `verification.outcomes[*].stateUpdate` and `logFields` are recorded in `state.uncertainty`.
- `samplingMaxTokens` (default 2000): max tokens per LLM response (raw). Increase if raw responses get truncated; reduce to save tokens.
- `llmMaxCalls` (default 8): hard budget of total LLM calls during a run.
- `resampleOnParseFailure` (default false): allows one stricter resample when parsing fails (use sparingly to control token spend).

- Policy for agents:
  - Prefer `solve` (one shot). If more refinement is needed, optionally call `step` with `{ "sessionId": "...", "overrideNumCandidates": 7 }` then `summarize`.
  - If client does not support sampling, omit `useSampling`; server falls back to heuristic proposals.
  - On stagnation, increase `iterations` to 12 or `numCandidates` to 7–9.

### Multi-round (sessions) + arbiter hints (new)

- Start a session and seed initial hints chosen by the arbiter:
```json
{
  "name": "start",
  "arguments": {
    "task": "Decompose product launch plan into validated next actions.",
    "config": { "useSampling": true, "numCandidates": 7, "topM": 2, "beamWidth": 2, "beamDepth": 2 },
    "seedHints": [
      "Define one measurable subgoal and the success criterion.",
      "Design a quick experiment that isolates one factor."
    ]
  }
}
```

- Run multiple iterations and promote new hints between rounds:
```json
{
  "name": "multi-step",
  "arguments": {
    "sessionId": "ses_...",
    "iterations": 3,
    "overrideNumCandidates": 7,
    "addHints": [
      "Compare two small alternatives; pick one by a clear rule.",
      "Record the outcome and update the option set."
    ]
  }
}
```

- One‑shot with initial hints (no manual stepping):
```json
{
  "name": "solve",
  "arguments": {
    "task": "Plan a household monthly budget...",
    "iterations": 10,
    "config": { "useSampling": true, "numCandidates": 7, "topM": 2 },
    "seedHints": ["Categorize fixed vs variable costs", "Set savings goal first"],
    "outputPath": "./summary.json",
    "outputFormat": "json"
  }
}
```

- Terminal demo (multi‑round):
```bash
npx --yes tsx tests\demo_sampling.ts --multi-round --task "Plan a 3-step experiment to test if X causes Y under constraint Z."
```

### Cheat‑sheet for AI agents (copy/paste)

- Primary output: Always parse the JSON string from the MCP response `content[0].text`. File saving via `outputPath` is optional.
- Strong models: increase `numCandidates`, `samplingMaxTokens`; enable a short beam. Use `llmMaxCalls` to cap budget.
- Hints: Provide `seedHints` at start; provide `addHints` between rounds with 3–5 concise, verifiable ideas (each should include a concrete `how_to_verify`).

- One‑shot (preferred when you do not need manual steering):
```json
{
  "name": "solve",
  "arguments": {
    "task": "Hard problem (succinct).",
    "iterations": 10,
    "config": { "useSampling": true, "numCandidates": 8, "beamWidth": 2, "beamDepth": 2, "samplingMaxTokens": 3000, "minImprovement": 0.02, "llmMaxCalls": 16 },
    "seedHints": ["Define one measurable subgoal and the success criterion.", "Design a quick experiment that isolates one factor."],
    "outputPath": "./summary.json",
    "outputFormat": "json"
  }
}
```

- Multi‑round (you act as the arbiter):
```json
{ "name": "start", "arguments": { "task": "Hard problem (succinct).", "config": { "useSampling": true, "numCandidates": 8, "beamWidth": 2, "beamDepth": 2 }, "seedHints": ["Hint A","Hint B"] } }
{ "name": "step",  "arguments": { "sessionId": "ses_...", "overrideNumCandidates": 8 } }
{ "name": "step",  "arguments": { "sessionId": "ses_...", "overrideNumCandidates": 8, "addHints": ["Promoted Hint 1","Promoted Hint 2"] } }
{ "name": "summarize", "arguments": { "sessionId": "ses_..." } }
```

- Reading results (what to extract from JSON):
  - `steps`: applied steps with text/rationale/howToVerify/score.
  - `hints`: globally promoted ideas to prefer across branches.
  - `diagnostics`: provider/model info and sampling metadata.
  - When using `solve`, the payload may include `arbiterPicks` (decisive sentences from raw LLM prose) and `lastRawResponse` for full auditing.

### Using stronger advisors (providers)

- Put keys into `mcp-reasoning-booster/secrets.local.txt` (or environment):
```
CEREBRAS_API_KEY=...
CEREBRAS_MODEL=qwen2.5-72b-instruct
CEREBRAS_BASE_URL=https://api.cerebras.ai/v1
# Optional OpenAI
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```
- Suggested config for strong models: `numCandidates: 7–9`, `samplingMaxTokens: 2000–4000`, `beamWidth: 2`, `beamDepth: 2`, `minImprovement: 0.01–0.03`, `llmMaxCalls: 12–24`, `voiAlpha: 0.5–0.8`.
- You can run separate sessions with different providers and merge their best ideas into the next session’s `seedHints`.

### Arbiter workflow recipe for hard tasks

1) Start with concise task + `seedHints` (2–3 crisp, verifiable ideas).
2) Run one `step`; as the arbiter, pick 3–5 best candidates that have a concrete `how_to_verify` and clear information gain.
3) Provide them as `addHints` for the next `step` or `multi-step` call to propagate across branches.
4) Repeat until you reach a unique conclusion or a decisive test; the last step may be a "Final step:". If not, synthesize the final answer from the best steps.

### Troubleshooting quick checks

- If responses are truncated: increase `samplingMaxTokens` (e.g., 3000) and keep prompts concise.
- If steps are too meta or repetitive: lower `numCandidates` or raise `minImprovement`; promote better hints (`addHints`).
- If budget is tight: reduce `iterations` and set `llmMaxCalls` to a safe cap; rely more on `seedHints`/`addHints`.

### Provider selection order (automatic)

The server chooses how to generate candidates in this priority order:

1) Direct HTTP (API keys present) – preferred
   - Put keys into `secrets.local.txt` (or `secrets.txt`) in `mcp-reasoning-booster/`:
     ````
     # Cerebras
     CEREBRAS_API_KEY=...
     CEREBRAS_MODEL=qwen2.5-72b-instruct
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

Tool call payload (what MCP clients send under the hood). Read the returned JSON from the MCP response; file saving is optional and controlled by `outputPath`:

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

## How to use as an AI agent (arbiter workflow)

The booster is an idea generator, not the final answer. The AI agent (you) is the arbiter: you read the JSON output, select and compose the best micro‑steps, and produce the final solution.

### What the booster provides
- **Micro‑steps**: short, actionable suggestions (<= 200 chars) with rationale and optional `how_to_verify`.
- **Scoring**: heuristic scores for step quality (information gain, novelty vs. history, weak consistency). Treat scores as signals, not ground truth.
- **Diagnostics**: proof that an LLM was called when available (`diagnostics.provider`, `lastModel`, `rawSamples`).
- **Robust parsing**: prose‑to‑JSON extraction and `<think>...</think>` removal; if JSON is poor, fallback heuristics still return useful, verifiable steps.

### Your workflow (recommended)
1) Call `solve` with a clear task and a small number of iterations (e.g., 6–10). Optionally set `numCandidates` 5–7.
2) Parse the returned JSON; look at `steps` and `diagnostics`.
3) Pick 1–2 best steps (you decide), prefer those with concrete `how_to_verify` and clear information gain. Ignore placeholders/meta.
4) Apply the chosen ideas in your own reasoning; if helpful, call `step` to get the next set of ideas, or re‑`solve` with a refined task.
5) Synthesize the final answer yourself. The booster is a generator of ideas; you compose and conclude.

### How to read steps
- **text**: must be an actionable micro‑step, domain‑agnostic (e.g., "Weigh 1,2,3 vs 4,5,6", "Design a quick experiment that isolates one factor", "Check a blocking constraint").
- **how_to_verify** (preferred): a concrete, local check (e.g., an outcome rule, a measurement, a pass/fail criterion).
- **rationale**: brief “why now”.
- **score.totalScore**: use as a hint; you can still pick a lower‑scored idea if it is better for your specific task.

### Tuning for different models
- Weak models (e.g., small Qwen): keep `numCandidates` modest (3–5), rely on fallback heuristics; you remain strict on content (discard meta/boilerplate).
- Strong models (e.g., GPT‑5 high): raise `numCandidates` (7–9), optionally enable a short beam (`beamWidth: 2`, `beamDepth: 2`) and set `minImprovement` > 0 to avoid stagnation.

### Beam search and cross‑branch idea sharing (hints)
- The booster can run a short beam. Budget is distributed via UCB (Upper Confidence Bound): branches with better cumulative score get more expansions while still exploring others.
- Cross‑branch sharing: when a branch generates high‑scoring, verifiable micro‑steps (with `how_to_verify`), they are promoted into `state.hints`. Other branches get a slight score boost if their candidates overlap with these hints, encouraging reuse of proven sub‑ideas without forcing convergence.
- Hints are capped (recent ~20) and deduplicated by similarity to keep diversity.
- Effect in practice: good local tests propagate across branches; weak or meta steps don’t spread.

### Provider selection and running without keys
- The server auto‑selects provider. See “Provider selection order (automatic)” above.
  - With keys (Cerebras/OpenAI): direct HTTP.
  - Without keys but MCP client supports sampling: uses client’s model via MCP.
  - Otherwise: heuristic fallback still returns concrete, verifiable steps.

### When output isn’t clean JSON
- The server strips `<think>` blocks and extracts the last JSON block if present.
- If only prose is returned, it parses numbered/bulleted lists into steps and captures `how_to_verify` when possible.
- If content is still weak, heuristics generate diversified, domain‑agnostic actions with verification hooks.

### Quality guardrails used by the booster
- JSON‑first request with explicit fields; meta‑phrases are discouraged and filtered.
- Preference for novelty vs. history; deduplication and loop/stagnation checks.
- Bonus for steps with `how_to_verify`; length bounds to keep actions small/local.

### Minimal examples (agent‑side usage)
- **One‑shot idea generation**
```json
{
  "name": "solve",
  "arguments": {
    "task": "Plan a 3-step experiment to test if X causes Y under constraint Z.",
    "iterations": 8,
    "config": { "numCandidates": 5 },
    "outputPath": "./summary.json",
    "outputFormat": "json"
  }
}
```
Then, from `steps`, pick 1–2 with the clearest `how_to_verify` to drive your answer.

- **Refine with multi‑step** (optional)
  - Start with `start` → use returned `sessionId`.
  - Call `multi-step` with `{ iterations: 3, overrideNumCandidates: 7 }`.
  - `summarize` to get a concise recap; you still decide the final solution.

### Practical selection tips (as the arbiter)
- Prefer steps that: increase information quickly, isolate one factor, or provide a crisp decision rule.
- Downrank steps that: restate the task, are vague, or duplicate previous steps.
- Use `diagnostics.rawSamples` if you need to audit what the model actually saw and returned.

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
  - input: `{ task: string, config?: { ... }, seedHints?: string[] }`
  - returns: `sessionId` plus initial `state` and effective `config`
- **step**: run one iteration (Best‑of‑N → scoring → apply → meta‑control)
  - input: `{ sessionId: string, overrideNumCandidates?: number, addHints?: string[] }`
  - returns: `chosen`, `candidates` and updated `state`
- **get-state**: return the current session state
  - input: `{ sessionId: string }`
- **summarize**: produce a short summary from the scratchpad
  - input: `{ sessionId: string }`
 - **multi-step**: run multiple iterations in a single call
  - input: `{ sessionId: string, iterations: number, overrideNumCandidates?: number, addHints?: string[] }`
 - **solve**: one-shot run (start → N iterations → summarize)
  - input: `{ task: string, iterations?: number, config?: { ... }, seedHints?: string[] }`
 - **usage**: quick how‑to/contract as JSON (copy/paste)
  - input: `{ topic?: string }`
  - returns: concise contract, tool map, and examples in PRIMARY JSON

### API map (at a glance)

| Tool        | Inputs                                                                                 | Primary output (parse JSON from `content[0].text`)                 |
|-------------|-----------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| start       | `{ task, config?, seedHints? }`                                                         | `{ sessionId, state, config }`                                     |
| step        | `{ sessionId, overrideNumCandidates?, addHints? }`                                      | `{ chosen, candidates, state }`                                    |
| multi-step  | `{ sessionId, iterations, overrideNumCandidates?, addHints? }`                          | `{ state }`                                                         |
| get-state   | `{ sessionId }`                                                                         | full session object (JSON)                                         |
| summarize   | `{ sessionId }`                                                                         | plain text summary (note: summary is not JSON)                     |
| solve       | `{ task, iterations?, config?, seedHints?, outputPath?, outputFormat? }`                | `{ sessionId, summary, steps, hints, config, diagnostics, ... }`   |
| usage       | `{ topic? }`                                                                            | quick how‑to JSON (contract + tool examples)                       |

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