import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFile } from "node:fs/promises";
import { resolve as pathResolve, join as pathJoin, isAbsolute as pathIsAbsolute } from "node:path";
import { DefaultConfig } from "./types.js";
import { loadSamplerConfig } from "./config.js";
import { createVerifier } from "./verifier.js";
import { initializeScratchpad, runOneIteration, summarizeSolution } from "./orchestrator.js";
function makeSessionId() {
    return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function asJson(value) {
    return JSON.stringify(value, null, 2);
}
const server = new Server({ name: "reasoning-booster", version: "0.1.0" }, { capabilities: { tools: {} } });
const sessions = new Map();
const toolRegistry = new Map();
function extractArbiterPicks(diag) {
    const picks = [];
    if (!diag?.rawSamples || diag.rawSamples.length === 0)
        return picks;
    const seen = new Set();
    const lineRegex = /^(final\s*(step|answer)\s*:|answer\s*:|solution\s*:|therefore\b|thus\b|conclusion\s*:|result\s*:|the\s+date\s+is\b|the\s+counterfeit\s+is\b|counterfeit\s+coin\s+is\b|gcd\s*(?:is|=)\b)/i;
    for (const s of diag.rawSamples) {
        const resp = s?.response || "";
        if (!resp)
            continue;
        const lines = resp.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const ln of lines) {
            if (lineRegex.test(ln)) {
                const key = ln.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    picks.push(ln);
                }
            }
        }
        // Heuristic: also capture the last enumerated step if it contains a clear assertion
        const stepLines = lines.filter(l => /^step\s*\d+[:.)]/i.test(l));
        const last = stepLines[stepLines.length - 1];
        if (last && /(gcd\s*(?:is|=)|final|answer|solution|since\b|therefore\b|the\s+counterfeit\s+is\b)/i.test(last)) {
            const key = last.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                picks.push(last);
            }
        }
    }
    return picks.slice(0, 5);
}
function getLastRawResponse(diag) {
    const rs = diag?.rawSamples;
    if (!rs || rs.length === 0)
        return undefined;
    for (let i = rs.length - 1; i >= 0; i--) {
        const r = rs[i]?.response;
        if (typeof r === "string" && r.trim().length > 0)
            return r.trim();
    }
    return undefined;
}
function mergeHints(existing, extras) {
    const out = Array.isArray(existing) ? existing.slice() : [];
    if (Array.isArray(extras)) {
        for (const v of extras) {
            if (typeof v === "string") {
                const t = v.trim();
                if (t && !out.includes(t))
                    out.push(t);
            }
        }
    }
    return out;
}
async function directOpenAISample(prompt, maxTokens, diag) {
    const cfg = loadSamplerConfig();
    const apiKey = cfg.openaiApiKey;
    if (!apiKey)
        return null;
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
        if (!res.ok)
            throw new Error(`OpenAI HTTP ${res.status}`);
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
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
    }
    catch (e) {
        if (diag)
            diag.lastErrorAt = new Date().toISOString();
        return null;
    }
}
async function directCerebrasSample(prompt, maxTokens, diag) {
    const cfg = loadSamplerConfig();
    const apiKey = cfg.cerebrasApiKey;
    if (!apiKey)
        return null;
    // Require explicit model from config/env/secrets; do not fallback to a hardcoded default to avoid unintended usage
    const model = cfg.cerebrasModel;
    if (!model)
        return null;
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
        if (!res.ok)
            throw new Error(`Cerebras HTTP ${res.status}`);
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
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
    }
    catch (e) {
        if (diag)
            diag.lastErrorAt = new Date().toISOString();
        return null;
    }
}
function getSampler(diag) {
    // Prefer direct HTTP sampling if API key exists; otherwise use MCP sampling if client supports it.
    const cfg = loadSamplerConfig();
    if (cfg.cerebrasApiKey && cfg.cerebrasModel) {
        return async (prompt, maxTokens = 800) => directCerebrasSample(prompt, maxTokens, diag);
    }
    if (cfg.openaiApiKey) {
        return async (prompt, maxTokens = 800) => directOpenAISample(prompt, maxTokens, diag);
    }
    return async (prompt, maxTokens = 800) => {
        try {
            const result = await server.createMessage({
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
            let textOut;
            if (result?.content?.type === "text" && typeof result.content.text === "string")
                textOut = result.content.text;
            else if (typeof result?.content === "string")
                textOut = result.content;
            // Strip <think>...</think> here to prevent swollen raw and truncation; still store original in diagnostics
            const cleaned = typeof textOut === "string" ? textOut.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : undefined;
            return cleaned ?? textOut ?? null;
            return null;
        }
        catch {
            if (diag)
                diag.lastErrorAt = new Date().toISOString();
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
                    samplingMaxTokens: { type: "number", description: "LLM max tokens per call", default: 2000 },
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
    handler: async (args) => {
        const task = String(args.task ?? "").trim();
        const cfg = args.config;
        if (!task)
            throw new Error("Missing 'task'");
        const merged = { ...DefaultConfig, ...(cfg ?? {}) };
        if (cfg?.useSampling === undefined) {
            // Priority: direct API keys > MCP sampling > off
            const samplerCfg = loadSamplerConfig();
            const hasKeys = !!(samplerCfg.cerebrasApiKey || samplerCfg.openaiApiKey);
            const caps = server.getClientCapabilities?.();
            if (hasKeys)
                merged.useSampling = true;
            else if (caps?.sampling)
                merged.useSampling = true;
        }
        const state = initializeScratchpad(task);
        state.hints = mergeHints(state.hints, args.seedHints);
        const id = makeSessionId();
        const session = { id, state, config: merged, history: [] };
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
    handler: async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const overrideNumCandidates = args.overrideNumCandidates;
        const addHints = args.addHints;
        const session = sessions.get(sessionId);
        if (!session)
            throw new Error(`Unknown sessionId: ${sessionId}`);
        // Merge arbiter-provided hints before generating candidates
        session.state.hints = mergeHints(session.state.hints, addHints);
        const cfg = {
            ...session.config,
            ...(overrideNumCandidates ? { numCandidates: overrideNumCandidates } : {})
        };
        const verifier = createVerifier(cfg);
        const sampler = session.config.useSampling ? getSampler(session.diagnostics ?? (session.diagnostics = { totalCalls: 0 })) : undefined;
        const { chosen, candidates, newState } = await runOneIteration(verifier, cfg, session.state.task, session.state, sampler);
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
    handler: async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const iterations = Number(args.iterations ?? 1);
        const overrideNumCandidates = args.overrideNumCandidates;
        const session = sessions.get(sessionId);
        if (!session)
            throw new Error(`Unknown sessionId: ${sessionId}`);
        const sampler = session.config.useSampling ? getSampler(session.diagnostics ?? (session.diagnostics = { totalCalls: 0 })) : undefined;
        // Merge arbiter-provided hints once for this batch
        session.state.hints = mergeHints(session.state.hints, args.addHints);
        for (let i = 0; i < iterations; i++) {
            const cfg = {
                ...session.config,
                ...(overrideNumCandidates ? { numCandidates: overrideNumCandidates } : {})
            };
            const verifier = createVerifier(cfg);
            const { chosen, candidates, newState } = await runOneIteration(verifier, cfg, session.state.task, session.state, sampler);
            session.state = newState;
            session.history.push({ chosen, candidates });
        }
        return { content: [{ type: "text", text: asJson({ state: session.state }) }] };
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
    handler: async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const session = sessions.get(sessionId);
        if (!session)
            throw new Error(`Unknown sessionId: ${sessionId}`);
        return { content: [{ type: "text", text: asJson(session) }] };
    }
});
toolRegistry.set("summarize", {
    name: "summarize",
    description: "Summarize the solution based on the scratchpad. PRIMARY content[0].text is JSON mirror { sessionId, summary }. content[1].text is human-readable summary for convenience.",
    inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        additionalProperties: false
    },
    handler: async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const session = sessions.get(sessionId);
        if (!session)
            throw new Error(`Unknown sessionId: ${sessionId}`);
        const summary = summarizeSolution(session.state);
        const jsonMirror = asJson({ sessionId, summary });
        return { content: [{ type: "text", text: jsonMirror }, { type: "text", text: summary }] };
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
                    samplingMaxTokens: { type: "number", description: "LLM max tokens per call", default: 2000 },
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
    handler: async (args) => {
        const task = String(args.task ?? "").trim();
        if (!task)
            throw new Error("Missing 'task'");
        const iterations = Number(args.iterations ?? 8);
        const cfg = args.config;
        const merged = { ...DefaultConfig, ...(cfg ?? {}) };
        if (cfg?.useSampling === undefined) {
            // Priority: direct API keys > MCP sampling > off
            const samplerCfg = loadSamplerConfig();
            const hasKeys = !!(samplerCfg.cerebrasApiKey || samplerCfg.openaiApiKey);
            const caps = server.getClientCapabilities?.();
            if (hasKeys)
                merged.useSampling = true;
            else if (caps?.sampling)
                merged.useSampling = true;
        }
        // init session
        const state = initializeScratchpad(task);
        state.hints = mergeHints(state.hints, args.seedHints);
        const id = makeSessionId();
        const session = { id, state, config: merged, history: [], diagnostics: { totalCalls: 0 } };
        sessions.set(id, session);
        const sampler = merged.useSampling ? getSampler(session.diagnostics) : undefined;
        const maxCalls = Math.max(0, merged.llmMaxCalls ?? 8);
        for (let i = 0; i < iterations; i++) {
            const verifier = createVerifier(merged);
            if (sampler && (session.diagnostics?.totalCalls ?? 0) >= maxCalls) {
                // Budget reached; continue with heuristic fallback by passing undefined sampler
                const { chosen, candidates, newState } = await runOneIteration(verifier, merged, session.state.task, session.state, undefined);
                session.state = newState;
                session.history.push({ chosen, candidates });
                continue;
            }
            const { chosen, candidates, newState } = await runOneIteration(verifier, merged, session.state.task, session.state, sampler);
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
        const outputPathRaw = args.outputPath;
        const outputFormat = String(args.outputFormat ?? "json").toLowerCase();
        if (typeof outputPathRaw === "string" && outputPathRaw.trim().length > 0) {
            try {
                const outputPath = outputPathRaw;
                const text = outputFormat === "text" ? summary : JSON.stringify(payload, null, 2);
                // Safe write: keep writes inside current working directory
                const cwd = process.cwd();
                const abs = pathIsAbsolute(outputPath) ? outputPath : pathResolve(cwd, outputPath);
                const safeBase = pathResolve(cwd);
                const safePath = abs.startsWith(safeBase) ? abs : pathResolve(safeBase, pathJoin(".", "summary.json"));
                await writeFile(safePath, text, { encoding: "utf8" });
            }
            catch {
                // ignore write errors, still return payload
            }
        }
        // Also include arbiterPicks as a separate text block for MCP clients that render multiple contents
        const content = [{ type: "text", text: asJson(payload) }];
        if (arbiterPicks.length) {
            content.push({ type: "text", text: `Arbiter picks:\n- ${arbiterPicks.join("\n- ")}` });
        }
        if (lastRaw) {
            content.push({ type: "text", text: `Raw LLM response (last):\n${lastRaw}` });
        }
        return { content };
    }
});
// solve-text: one-shot with plain text primary output (no JSON parsing needed)
toolRegistry.set("solve-text", {
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
    handler: async (args) => {
        const res = await toolRegistry.get("solve").handler({
            task: args.task,
            iterations: args.iterations,
            config: args.config,
            seedHints: args.seedHints,
            outputPath: args.outputPath,
            outputFormat: "text"
        });
        // Convert the JSON-first payload into a plain text summary primary content
        // The 'solve' tool already pushes summary text into additional contents; pick the summary
        const textBlocks = (res?.content || []).map((c) => (typeof c?.text === "string" ? c.text : ""));
        let summaryText = "";
        for (const t of textBlocks) {
            if (t && !t.trim().startsWith("{")) {
                summaryText = t;
                break;
            }
        }
        if (!summaryText) {
            // Fallback: synthesize from state if needed (rare path)
            try {
                const payload = JSON.parse(textBlocks[0] || "{}");
                summaryText = String(payload?.summary || "(no summary)");
            }
            catch {
                summaryText = "(no summary)";
            }
        }
        return { content: [{ type: "text", text: summaryText }] };
    }
});
// usage: return concise, copy/paste instructions as PRIMARY JSON
toolRegistry.set("usage", {
    name: "usage",
    description: "Call this first. Returns exact how-to (mcp.json, shell commands, examples). PRIMARY JSON is in content[0].text. Mock mode is for local testing only; do not use in production runs.",
    inputSchema: {
        type: "object",
        properties: {
            topic: { type: "string", description: "optional: 'quick' | 'full'" }
        },
        additionalProperties: false
    },
    handler: async (args) => {
        const payload = {
            intro: "Reasoning Booster MCP: parse JSON from content[0].text; file output via outputPath is optional.",
            contract: {
                primaryOutput: "JSON in content[0].text",
                parseNote: "Always JSON.parse the first text content.",
            },
            shellCommands: {
                powershell5: "Set-Location mcp-reasoning-booster; npm run build; npx --yes tsx tests\\demo_sampling.ts --sampling=mock --task \"<your task>\"",
                pwsh_or_cmd: "cd mcp-reasoning-booster && npm run build && npx --yes tsx tests\\demo_sampling.ts --sampling=mock --task \"<your task>\"",
                bash: "cd mcp-reasoning-booster && npm run build && npx tsx tests/demo_sampling.ts --sampling=mock --task '<your task>'"
            },
            clientConfig: {
                mcpServers: {
                    "reasoning-booster": {
                        command: "node",
                        args: ["./dist/index.js"],
                        cwd: "./mcp-reasoning-booster",
                        transport: "stdio"
                    }
                }
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
                },
                "solve-text": {
                    input: ["task (string)", "iterations? (number)", "config? (object)", "seedHints? (string[])", "outputPath? (string)"]
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
                minimalQuickstartNoSampling: {
                    name: "solve",
                    arguments: {
                        task: "Simple task (succinct).",
                        iterations: 6,
                        config: { useSampling: false, numCandidates: 3 }
                    }
                },
                multiRound: [
                    { name: "start", arguments: { task: "Hard problem (succinct).", config: { useSampling: true, numCandidates: 8, beamWidth: 2, beamDepth: 2 }, seedHints: ["Hint A", "Hint B"] } },
                    { name: "step", arguments: { sessionId: "ses_...", overrideNumCandidates: 8 } },
                    { name: "step", arguments: { sessionId: "ses_...", overrideNumCandidates: 8, addHints: ["Promoted Hint 1", "Promoted Hint 2"] } },
                    { name: "summarize", arguments: { sessionId: "ses_..." } }
                ],
                solveText: {
                    name: "solve-text",
                    arguments: {
                        task: "Return plain text summary without JSON parsing.",
                        iterations: 8,
                        config: { useSampling: false, numCandidates: 5 }
                    }
                }
            },
            notes: [
                "Prefer short, verifiable steps with how_to_verify.",
                "Hints should be 3–5 concise, reusable ideas; they propagate across branches.",
                "Use llmMaxCalls to cap token budget; increase samplingMaxTokens if truncation occurs.",
                "Secrets: put API keys into mcp-reasoning-booster/secrets.local.txt (or secrets.txt); environment variables are optional fallback.",
                "Mock note: --sampling=mock enables a local sampler for offline testing only. For real LLMs, omit this flag and ensure secrets are set."
            ]
        };
        return { content: [{ type: "text", text: asJson(payload) }] };
    }
});
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
    return { tools };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {});
    const def = toolRegistry.get(name);
    if (!def)
        throw new Error(`Unknown tool: ${name}`);
    const result = await def.handler(args);
    return result;
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Reasoning Booster MCP server running on stdio...");
}
main().catch((err) => {
    console.error("Server error:", err);
});
