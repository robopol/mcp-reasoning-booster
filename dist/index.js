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
                max_tokens: Math.max(1, Math.min(4000, maxTokens)),
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
    // Qwen3-235B (Thinking) bežne vystupuje ako chat model; názvy sa môžu uvádzať ako "qwen2.5-72b-instruct" a pod.
    // Predvolene necháme možnosť nastaviť v configu; ak nie je, použijeme konzervatívny fallback:
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
                max_tokens: Math.max(1, Math.min(4000, maxTokens)),
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
    if (cfg.cerebrasApiKey) {
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
            if (result?.content?.type === "text" && typeof result.content.text === "string")
                return result.content.text;
            if (typeof result?.content === "string")
                return result.content;
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
    description: "Initialize a reasoning session and its scratchpad for a given task.",
    inputSchema: {
        type: "object",
        properties: {
            task: { type: "string", description: "Task or goal description" },
            config: {
                type: "object",
                properties: {
                    maxSteps: { type: "number" },
                    numCandidates: { type: "number" },
                    topM: { type: "number" },
                    allowBacktrack: { type: "boolean" },
                    wRules: { type: "number" },
                    wRedundancy: { type: "number" },
                    wConsistency: { type: "number" },
                    useSampling: { type: "boolean" },
                    samplingMaxTokens: { type: "number" },
                    minImprovement: { type: "number" },
                    beamWidth: { type: "number" },
                    beamDepth: { type: "number" }
                },
                additionalProperties: true
            }
        },
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
        const id = makeSessionId();
        const session = { id, state, config: merged, history: [] };
        sessions.set(id, session);
        return { content: [
                { type: "text", text: `sessionId: ${id}` },
                { type: "text", text: asJson({ sessionId: id, state, config: merged }) }
            ] };
    }
});
toolRegistry.set("step", {
    name: "step",
    description: "One iteration: Best-of-N, scoring and step application.",
    inputSchema: {
        type: "object",
        properties: {
            sessionId: { type: "string", description: "Session identifier from 'start'" },
            overrideNumCandidates: { type: "number" }
        },
        additionalProperties: false
    },
    handler: async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const overrideNumCandidates = args.overrideNumCandidates;
        const session = sessions.get(sessionId);
        if (!session)
            throw new Error(`Unknown sessionId: ${sessionId}`);
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
                { type: "text", text: `chosen: ${chosen.proposal.text}` },
                { type: "text", text: asJson({ chosen, candidates, state: newState }) }
            ] };
    }
});
// multi-step: run multiple iterations in one call
toolRegistry.set("multi-step", {
    name: "multi-step",
    description: "Run N iterations with optional budget overrides and return final state.",
    inputSchema: {
        type: "object",
        properties: {
            sessionId: { type: "string" },
            iterations: { type: "number" },
            overrideNumCandidates: { type: "number" }
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
    description: "Return the current scratchpad state for a session.",
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
    description: "Summarize the solution based on the scratchpad.",
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
        return { content: [{ type: "text", text: summary }] };
    }
});
// solve: one-shot (start -> N iterations -> summarize)
toolRegistry.set("solve", {
    name: "solve",
    description: "One-shot reasoning: start session, run N iterations, return summary and steps.",
    inputSchema: {
        type: "object",
        properties: {
            task: { type: "string" },
            iterations: { type: "number" },
            config: {
                type: "object",
                properties: {
                    maxSteps: { type: "number" },
                    numCandidates: { type: "number" },
                    topM: { type: "number" },
                    allowBacktrack: { type: "boolean" },
                    wRules: { type: "number" },
                    wRedundancy: { type: "number" },
                    wConsistency: { type: "number" },
                    useSampling: { type: "boolean" },
                    samplingMaxTokens: { type: "number" },
                    minImprovement: { type: "number" },
                    beamWidth: { type: "number" },
                    beamDepth: { type: "number" }
                },
                additionalProperties: true
            },
            outputPath: { type: "string" },
            outputFormat: { type: "string" } // "json" | "text"
        },
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
        const id = makeSessionId();
        const session = { id, state, config: merged, history: [], diagnostics: { totalCalls: 0 } };
        sessions.set(id, session);
        const sampler = merged.useSampling ? getSampler(session.diagnostics) : undefined;
        for (let i = 0; i < iterations; i++) {
            const verifier = createVerifier(merged);
            const { chosen, candidates, newState } = await runOneIteration(verifier, merged, session.state.task, session.state, sampler);
            session.state = newState;
            session.history.push({ chosen, candidates });
        }
        const summary = summarizeSolution(session.state);
        const payload = { sessionId: id, summary, steps: session.state.steps, config: merged, diagnostics: session.diagnostics };
        const outputPath = String(args.outputPath ?? "summary.json");
        const outputFormat = String(args.outputFormat ?? "json").toLowerCase();
        try {
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
        return { content: [{ type: "text", text: asJson(payload) }] };
    }
});
// MCP tools/list and tools/call handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Array.from(toolRegistry.values()).map(t => ({
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
