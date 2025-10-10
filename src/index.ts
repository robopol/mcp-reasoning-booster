import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFile } from "node:fs/promises";
import { resolve as pathResolve, join as pathJoin, isAbsolute as pathIsAbsolute } from "node:path";
import { DefaultConfig, ReasoningConfig, Session, State, SamplerDiagnostics } from "./types.js";
import { loadSamplerConfig } from "./config.js";
import { createVerifier } from "./verifier.js";
import { Sampler, initializeScratchpad, runOneIteration, summarizeSolution } from "./orchestrator.js";

function makeSessionId(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const server = new Server({ name: "reasoning-booster", version: "0.1.0" }, { capabilities: { tools: {} } });

const sessions = new Map<string, Session>();

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown>; handler: ToolHandler };

const toolRegistry = new Map<string, ToolDef>();

function extractArbiterPicks(diag?: SamplerDiagnostics): string[] {
  const picks: string[] = [];
  if (!diag?.rawSamples || diag.rawSamples.length === 0) return picks;
  const seen = new Set<string>();
  const lineRegex = /^(final\s*(step|answer)\s*:|answer\s*:|solution\s*:|therefore\b|thus\b|conclusion\s*:|result\s*:|the\s+date\s+is\b|the\s+counterfeit\s+is\b|counterfeit\s+coin\s+is\b|gcd\s*(?:is|=)\b)/i;
  for (const s of diag.rawSamples) {
    const resp = s?.response || "";
    if (!resp) continue;
    const lines = resp.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const ln of lines) {
      if (lineRegex.test(ln)) {
        const key = ln.toLowerCase();
        if (!seen.has(key)) { seen.add(key); picks.push(ln); }
      }
    }
    // Heuristic: also capture the last enumerated step if it contains a clear assertion
    const stepLines = lines.filter(l => /^step\s*\d+[:.)]/i.test(l));
    const last = stepLines[stepLines.length - 1];
    if (last && /(gcd\s*(?:is|=)|final|answer|solution|since\b|therefore\b|the\s+counterfeit\s+is\b)/i.test(last)) {
      const key = last.toLowerCase();
      if (!seen.has(key)) { seen.add(key); picks.push(last); }
    }
  }
  return picks.slice(0, 5);
}

function getLastRawResponse(diag?: SamplerDiagnostics): string | undefined {
  const rs = diag?.rawSamples;
  if (!rs || rs.length === 0) return undefined;
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i]?.response;
    if (typeof r === "string" && r.trim().length > 0) return r.trim();
  }
  return undefined;
}

function mergeHints(existing: string[] | undefined, extras: unknown): string[] {
  const out: string[] = Array.isArray(existing) ? existing.slice() : [];
  if (Array.isArray(extras)) {
    for (const v of extras) {
      if (typeof v === "string") {
        const t = v.trim();
        if (t && !out.includes(t)) out.push(t);
      }
    }
  }
  return out;
}

async function directOpenAISample(prompt: string, maxTokens: number, diag?: SamplerDiagnostics): Promise<string | null> {
  const cfg = loadSamplerConfig();
  const apiKey = cfg.openaiApiKey;
  if (!apiKey) return null;
  const model = cfg.openaiModel || "gpt-4o-mini";
  try {
    const res = await fetch(cfg.openaiBaseUrl || "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: Math.max(1, Math.min(16000, maxTokens)),
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    const data: any = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (diag) {
      diag.provider = "direct-openai";
      diag.totalCalls = (diag.totalCalls ?? 0) + 1;
      diag.lastPromptChars = prompt?.length;
      diag.lastResponseChars = text?.length;
      diag.lastModel = model;
      diag.lastOkAt = new Date().toISOString();
      diag.rawSamples = diag.rawSamples || [];
      diag.rawSamples.push({ prompt, response: text, model, provider: diag.provider, at: new Date().toISOString() });
    }
    return typeof text === "string" ? text : null;
  } catch (e) {
    if (diag) diag.lastErrorAt = new Date().toISOString();
    return null;
  }
}

async function directCerebrasSample(prompt: string, maxTokens: number, diag?: SamplerDiagnostics): Promise<string | null> {
  const cfg = loadSamplerConfig();
  const apiKey = cfg.cerebrasApiKey;
  if (!apiKey) return null;
  // Qwen3-235B (Thinking) commonly appears as a chat model; model naming may vary (e.g., "qwen2.5-72b-instruct").
  // We allow configuring the model via config; if missing, use a conservative fallback:
  const model = cfg.cerebrasModel || "qwen2.5-72b-instruct";
  try {
    const base = (cfg.cerebrasBaseUrl || "https://api.cerebras.ai/v1").replace(/\/$/, "");
    const res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: Math.max(1, Math.min(16000, maxTokens)),
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(`Cerebras HTTP ${res.status}`);
    const data: any = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (diag) {
      diag.provider = "cerebras";
      diag.totalCalls = (diag.totalCalls ?? 0) + 1;
      diag.lastPromptChars = prompt?.length;
      diag.lastResponseChars = text?.length;
      diag.lastModel = model;
      diag.lastOkAt = new Date().toISOString();
      diag.rawSamples = diag.rawSamples || [];
      diag.rawSamples.push({ prompt, response: text, model, provider: diag.provider, at: new Date().toISOString() });
    }
    return typeof text === "string" ? text : null;
  } catch (e) {
    if (diag) diag.lastErrorAt = new Date().toISOString();
    return null;
  }
}

function getSampler(diag?: SamplerDiagnostics): Sampler | undefined {
  // Prefer direct HTTP sampling if API key exists; otherwise use MCP sampling if client supports it.
  const cfg = loadSamplerConfig();
  if (cfg.cerebrasApiKey) {
    return async (prompt: string, maxTokens = 800) => directCerebrasSample(prompt, maxTokens, diag);
  }
  if (cfg.openaiApiKey) {
    return async (prompt: string, maxTokens = 800) => directOpenAISample(prompt, maxTokens, diag);
  }
  return async (prompt: string, maxTokens = 800) => {
    try {
      const result: any = await (server as any).createMessage({
        messages: [
          { role: "user", content: { type: "text", text: prompt } }
        ],
        maxTokens,
      });
      if (diag) {
        diag.provider = "mcp";
        diag.totalCalls = (diag.totalCalls ?? 0) + 1;
        diag.lastPromptChars = typeof prompt === "string" ? prompt.length : undefined;
        const respText = result?.content?.type === "text" ? result?.content?.text : (typeof result?.content === "string" ? result.content : undefined);
        diag.lastResponseChars = typeof respText === "string" ? respText.length : undefined;
        diag.lastModel = typeof result?.model === "string" ? result.model : undefined;
        diag.lastOkAt = new Date().toISOString();
        diag.rawSamples = diag.rawSamples || [];
        diag.rawSamples.push({ prompt, response: typeof respText === "string" ? respText : undefined, model: diag.lastModel, provider: diag.provider, at: new Date().toISOString() });
      }
      let textOut: string | undefined;
      if (result?.content?.type === "text" && typeof result.content.text === "string") textOut = result.content.text as string;
      else if (typeof result?.content === "string") textOut = result.content as string;
      // Strip <think>...</think> here to prevent swollen raw and truncation; still store original in diagnostics
      const cleaned = typeof textOut === "string" ? textOut.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : undefined;
      return cleaned ?? textOut ?? null;
      return null;
    } catch {
      if (diag) diag.lastErrorAt = new Date().toISOString();
      return null;
    }
  };
}

// Tools registration (JSON Schema + handler)
toolRegistry.set("start", {
  name: "start",
  description: "Initialize a reasoning session and its scratchpad for a given task. PRIMARY JSON is in content[0].text; agent MUST parse it. Supports optional seedHints to pre-populate cross-branch ideas.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task or goal description (required)" },
      config: {
        type: "object",
        properties: {
          maxSteps: { type: "number", description: "Max steps to keep in scratchpad", default: 16 },
          numCandidates: { type: "number", description: "Candidates per iteration", default: 5 },
          topM: { type: "number", description: "Top-M kept for selection/beam", default: 2 },
          allowBacktrack: { type: "boolean", description: "Allow backtrack on loops/stagnation", default: true },
          wRules: { type: "number", description: "Weight: rules score", default: 0.6 },
          wRedundancy: { type: "number", description: "Weight: redundancy/novelty", default: 0.25 },
          wConsistency: { type: "number", description: "Weight: consistency", default: 0.15 },
          useSampling: { type: "boolean", description: "Enable LLM sampling (auto if keys/capabilities)", default: undefined },
          samplingMaxTokens: { type: "number", description: "LLM max tokens per call", default: 800 },
          minImprovement: { type: "number", description: "Min score delta to avoid stagnation", default: 0.01 },
          beamWidth: { type: "number", description: "Shallow beam width", default: 1 },
          beamDepth: { type: "number", description: "Shallow beam depth", default: 2 },
          llmMaxCalls: { type: "number", description: "Hard budget of LLM calls", default: 8 },
          resampleOnParseFailure: { type: "boolean", description: "Make a second stricter request if parse fails", default: false },
          voiAlpha: { type: "number", description: "Weight of VoI prior in beam selection", default: 0.5 },
          executeVerification: { type: "boolean", description: "If true, record verification notes into state.uncertainty", default: false }
        },
        additionalProperties: true
      },
      seedHints: { type: "array", description: "Initial hints to seed into state.hints", items: { type: "string" } }
    },
    required: ["task"],
    additionalProperties: false
  },
  handler: async (args: Record<string, unknown>) => {
    const task = String((args as any).task ?? "").trim();
    const cfg = (args as any).config as Partial<ReasoningConfig> | undefined;
    if (!task) throw new Error("Missing 'task'");
    const merged: ReasoningConfig = { ...DefaultConfig, ...(cfg ?? {}) };
    if (cfg?.useSampling === undefined) {
      // Priority: direct API keys > MCP sampling > off
      const samplerCfg = loadSamplerConfig();
      const hasKeys = !!(samplerCfg.cerebrasApiKey || samplerCfg.openaiApiKey);
      const caps = (server as any).getClientCapabilities?.();
      if (hasKeys) merged.useSampling = true; else if (caps?.sampling) merged.useSampling = true;
    }
    const state: State = initializeScratchpad(task);
    state.hints = mergeHints(state.hints, (args as any).seedHints);
    const id = makeSessionId();
    const session: Session = { id, state, config: merged, history: [] };
    sessions.set(id, session);
    return { content: [
      { type: "text", text: asJson({ sessionId: id, state, config: merged }) },
      { type: "text", text: `sessionId: ${id}` }
    ] };
  }
});

toolRegistry.set("step", {
  name: "step",
  description: "One iteration: Best-of-N, scoring and step application. PRIMARY JSON is in content[0].text (chosen, candidates, state). Supports addHints to propagate arbiter-selected ideas before this step.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session identifier from 'start'" },
      overrideNumCandidates: { type: "number" },
      addHints: { type: "array", description: "Hints to merge into state.hints before this step", items: { type: "string" } }
    },
    additionalProperties: false
  },
  handler: async (args: Record<string, unknown>) => {
    const sessionId = String((args as any).sessionId ?? "");
    const overrideNumCandidates = (args as any).overrideNumCandidates as number | undefined;
    const addHints = (args as any).addHints as unknown;
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);
    // Merge arbiter-provided hints before generating candidates
    session.state.hints = mergeHints(session.state.hints, addHints);
    const cfg: ReasoningConfig = {
      ...session.config,
      ...(overrideNumCandidates ? { numCandidates: overrideNumCandidates } : {})
    };
    const verifier = createVerifier(cfg);
    const sampler = session.config.useSampling ? getSampler(session.diagnostics ?? (session.diagnostics = { totalCalls: 0 })) : undefined;
    const { chosen, candidates, newState } = await runOneIteration(
      verifier,
      cfg,
      session.state.task,
      session.state,
      sampler
    );
    session.state = newState;
    session.history.push({ chosen, candidates });
    return { content: [
      { type: "text", text: asJson({ chosen, candidates, state: newState }) },
      { type: "text", text: `chosen: ${chosen.proposal.text}` }
    ] };
  }
});
// multi-step: run multiple iterations in one call
toolRegistry.set("multi-step", {
  name: "multi-step",
  description: "Run N iterations with optional budget overrides and return final state. PRIMARY JSON is in content[0].text (state). Supports addHints to seed hints for all iterations in this call.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      iterations: { type: "number" },
      overrideNumCandidates: { type: "number" },
      addHints: { type: "array", description: "Hints to merge into state.hints before iterations", items: { type: "string" } }
    },
    additionalProperties: false
  },
  handler: async (args: Record<string, unknown>) => {
    const sessionId = String((args as any).sessionId ?? "");
    const iterations = Number((args as any).iterations ?? 1);
    const overrideNumCandidates = (args as any).overrideNumCandidates as number | undefined;
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);
    const sampler = session.config.useSampling ? getSampler(session.diagnostics ?? (session.diagnostics = { totalCalls: 0 })) : undefined;
    // Merge arbiter-provided hints once for this batch
    session.state.hints = mergeHints(session.state.hints, (args as any).addHints);
    for (let i = 0; i < iterations; i++) {
      const cfg: ReasoningConfig = {
        ...session.config,
        ...(overrideNumCandidates ? { numCandidates: overrideNumCandidates } : {})
      };
      const verifier = createVerifier(cfg);
      const { chosen, candidates, newState } = await runOneIteration(
        verifier,
        cfg,
        session.state.task,
        session.state,
        sampler
      );
      session.state = newState;
      session.history.push({ chosen, candidates });
    }
    return { content: [ { type: "text", text: asJson({ state: session.state }) } ] };
  }
});

toolRegistry.set("get-state", {
  name: "get-state",
  description: "Return the current scratchpad state for a session. Result: PRIMARY JSON is in content[0].text.",
  inputSchema: {
    type: "object",
    properties: { sessionId: { type: "string" } },
    additionalProperties: false
  },
  handler: async (args: Record<string, unknown>) => {
    const sessionId = String((args as any).sessionId ?? "");
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);
    return { content: [ { type: "text", text: asJson(session) } ] };
  }
});

toolRegistry.set("summarize", {
  name: "summarize",
  description: "Summarize the solution based on the scratchpad. Result: content[0].text is plain text summary.",
  inputSchema: {
    type: "object",
    properties: { sessionId: { type: "string" } },
    additionalProperties: false
  },
  handler: async (args: Record<string, unknown>) => {
    const sessionId = String((args as any).sessionId ?? "");
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);
    const summary = summarizeSolution(session.state);
    return { content: [ { type: "text", text: summary } ] };
  }
});

// solve: one-shot (start -> N iterations -> summarize)
toolRegistry.set("solve", {
  name: "solve",
  description: "One-shot reasoning: start session, run N iterations, return summary and steps. PRIMARY JSON is in content[0].text; agent MUST parse. Supports seedHints. Optional file save via outputPath.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task or goal description (required)" },
      iterations: { type: "number", description: "How many iterations to run", default: 8 },
      config: {
        type: "object",
        properties: {
          maxSteps: { type: "number", description: "Max steps to keep in scratchpad", default: 16 },
          numCandidates: { type: "number", description: "Candidates per iteration", default: 5 },
          topM: { type: "number", description: "Top-M kept for selection/beam", default: 2 },
          allowBacktrack: { type: "boolean", description: "Allow backtrack on loops/stagnation", default: true },
          wRules: { type: "number", description: "Weight: rules score", default: 0.6 },
          wRedundancy: { type: "number", description: "Weight: redundancy/novelty", default: 0.25 },
          wConsistency: { type: "number", description: "Weight: consistency", default: 0.15 },
          useSampling: { type: "boolean", description: "Enable LLM sampling (auto if keys/capabilities)", default: undefined },
          samplingMaxTokens: { type: "number", description: "LLM max tokens per call", default: 800 },
          minImprovement: { type: "number", description: "Min score delta to avoid stagnation", default: 0.01 },
          beamWidth: { type: "number", description: "Shallow beam width", default: 1 },
          beamDepth: { type: "number", description: "Shallow beam depth", default: 2 },
          llmMaxCalls: { type: "number", description: "Hard budget of LLM calls", default: 8 },
          resampleOnParseFailure: { type: "boolean", description: "Make a second stricter request if parse fails", default: false },
          voiAlpha: { type: "number", description: "Weight of VoI prior in beam selection", default: 0.5 },
          executeVerification: { type: "boolean", description: "If true, record verification notes into state.uncertainty", default: false }
        },
        additionalProperties: true
      },
      seedHints: { type: "array", description: "Initial hints to seed into state.hints", items: { type: "string" } },
      outputPath: { type: "string", description: "Optional file path to save the same JSON/text payload" },
      outputFormat: { type: "string", description: "json (default) | text (summary only)", default: "json" } // "json" | "text"
    },
    required: ["task"],
    additionalProperties: false
  },
  handler: async (args: Record<string, unknown>) => {
    const task = String((args as any).task ?? "").trim();
    if (!task) throw new Error("Missing 'task'");
    const iterations = Number((args as any).iterations ?? 8);
    const cfg = (args as any).config as Partial<ReasoningConfig> | undefined;
    const merged: ReasoningConfig = { ...DefaultConfig, ...(cfg ?? {}) };
    if (cfg?.useSampling === undefined) {
      // Priority: direct API keys > MCP sampling > off
      const samplerCfg = loadSamplerConfig();
      const hasKeys = !!(samplerCfg.cerebrasApiKey || samplerCfg.openaiApiKey);
      const caps = (server as any).getClientCapabilities?.();
      if (hasKeys) merged.useSampling = true; else if (caps?.sampling) merged.useSampling = true;
    }

    // init session
    const state: State = initializeScratchpad(task);
    state.hints = mergeHints(state.hints, (args as any).seedHints);
    const id = makeSessionId();
    const session: Session = { id, state, config: merged, history: [], diagnostics: { totalCalls: 0 } };
    sessions.set(id, session);

    const sampler = merged.useSampling ? getSampler(session.diagnostics!) : undefined;
    const maxCalls = Math.max(0, merged.llmMaxCalls ?? 8);
    for (let i = 0; i < iterations; i++) {
      const verifier = createVerifier(merged);
      if (sampler && (session.diagnostics?.totalCalls ?? 0) >= maxCalls) {
        // Budget reached; continue with heuristic fallback by passing undefined sampler
        const { chosen, candidates, newState } = await runOneIteration(
          verifier,
          merged,
          session.state.task,
          session.state,
          undefined
        );
        session.state = newState;
        session.history.push({ chosen, candidates });
        continue;
      }
      const { chosen, candidates, newState } = await runOneIteration(
        verifier,
        merged,
        session.state.task,
        session.state,
        sampler
      );
      session.state = newState;
      session.history.push({ chosen, candidates });
    }
    const summary = summarizeSolution(session.state);
    const arbiterPicks = extractArbiterPicks(session.diagnostics);
    const lastRaw = getLastRawResponse(session.diagnostics);
    const enrichedSummary = arbiterPicks.length
      ? `${summary}\n\nArbiter picks (from raw LLM prose):\n- ${arbiterPicks.join("\n- ")}`
      : summary;
    const payload = { sessionId: id, summary: enrichedSummary, arbiterPicks, lastRawResponse: lastRaw, steps: session.state.steps, hints: session.state.hints, config: merged, diagnostics: session.diagnostics };

    const outputPath = String((args as any).outputPath ?? "summary.json");
    const outputFormat = String((args as any).outputFormat ?? "json").toLowerCase();
    try {
      const text = outputFormat === "text" ? summary : JSON.stringify(payload, null, 2);
      // Safe write: keep writes inside current working directory
      const cwd = process.cwd();
      const abs = pathIsAbsolute(outputPath) ? outputPath : pathResolve(cwd, outputPath);
      const safeBase = pathResolve(cwd);
      const safePath = abs.startsWith(safeBase) ? abs : pathResolve(safeBase, pathJoin(".", "summary.json"));
      await writeFile(safePath, text, { encoding: "utf8" });
    } catch {
      // ignore write errors, still return payload
    }

    // Also include arbiterPicks as a separate text block for MCP clients that render multiple contents
    const content: Array<{ type: "text"; text: string }> = [ { type: "text", text: asJson(payload) } ];
    if (arbiterPicks.length) {
      content.push({ type: "text", text: `Arbiter picks:\n- ${arbiterPicks.join("\n- ")}` });
    }
    if (lastRaw) {
      content.push({ type: "text", text: `Raw LLM response (last):\n${lastRaw}` });
    }
    return { content };
  }
});

// usage: return concise, copy/paste instructions as PRIMARY JSON
toolRegistry.set("usage", {
  name: "usage",
  description: "Return a concise how-to (copy/paste) for using this MCP server. PRIMARY JSON is in content[0].text.",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "optional: 'quick' | 'full'" }
    },
    additionalProperties: false
  },
  handler: async (args: Record<string, unknown>) => {
    const payload = {
      intro: "Reasoning Booster MCP: parse JSON from content[0].text; file output via outputPath is optional.",
      contract: {
        primaryOutput: "JSON in content[0].text",
        parseNote: "Always JSON.parse the first text content.",
      },
      tools: {
        start: {
          input: ["task (string)", "config? (object)", "seedHints? (string[])"]
        },
        step: {
          input: ["sessionId (string)", "overrideNumCandidates? (number)", "addHints? (string[])"]
        },
        "multi-step": {
          input: ["sessionId (string)", "iterations (number)", "overrideNumCandidates? (number)", "addHints? (string[])"]
        },
        summarize: { input: ["sessionId (string)"] },
        "get-state": { input: ["sessionId (string)"] },
        solve: {
          input: ["task (string)", "iterations? (number)", "config? (object)", "seedHints? (string[])", "outputPath? (string)", "outputFormat? ('json'|'text')"]
        }
      },
      examples: {
        solve: {
          name: "solve",
          arguments: {
            task: "Hard problem (succinct).",
            iterations: 10,
            config: { useSampling: true, numCandidates: 8, beamWidth: 2, beamDepth: 2, samplingMaxTokens: 3000 },
            seedHints: ["Define one measurable subgoal and the success criterion.", "Design a quick experiment that isolates one factor."],
            outputPath: "./summary.json",
            outputFormat: "json"
          }
        },
        multiRound: [
          { name: "start", arguments: { task: "Hard problem (succinct).", config: { useSampling: true, numCandidates: 8, beamWidth: 2, beamDepth: 2 }, seedHints: ["Hint A","Hint B"] } },
          { name: "step",  arguments: { sessionId: "ses_...", overrideNumCandidates: 8 } },
          { name: "step",  arguments: { sessionId: "ses_...", overrideNumCandidates: 8, addHints: ["Promoted Hint 1","Promoted Hint 2"] } },
          { name: "summarize", arguments: { sessionId: "ses_..." } }
        ]
      },
      notes: [
        "Prefer short, verifiable steps with how_to_verify.",
        "Hints should be 3–5 concise, reusable ideas; they propagate across branches.",
        "Use llmMaxCalls to cap token budget; increase samplingMaxTokens if truncation occurs."
      ]
    };
    return { content: [ { type: "text", text: asJson(payload) } ] };
  }
});

// MCP tools/list and tools/call handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = Array.from(toolRegistry.values()).map(t => ({
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