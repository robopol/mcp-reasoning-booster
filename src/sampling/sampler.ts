import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Sampler } from "../orchestrator.js";
import type { SamplerDiagnostics } from "../types.js";
import { loadSamplerConfig } from "../config.js";

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

export function shouldEnableSampling(server: Server): boolean {
  const cfg = loadSamplerConfig();
  const hasCerebras = !!(cfg.cerebrasApiKey && cfg.cerebrasModel);
  const hasOpenAI = !!cfg.openaiApiKey;
  const hasKeys = hasCerebras || hasOpenAI;
  const caps = (server as any).getClientCapabilities?.();
  return hasKeys || !!caps?.sampling;
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
  } catch {
    if (diag) diag.lastErrorAt = new Date().toISOString();
    return null;
  }
}

async function directCerebrasSample(prompt: string, maxTokens: number, diag?: SamplerDiagnostics): Promise<string | null> {
  const cfg = loadSamplerConfig();
  const apiKey = cfg.cerebrasApiKey;
  if (!apiKey) return null;
  const model = cfg.cerebrasModel;
  if (!model) return null;
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
  } catch {
    if (diag) diag.lastErrorAt = new Date().toISOString();
    return null;
  }
}

function extractMcpText(result: any): string | undefined {
  if (result?.content?.type === "text" && typeof result.content.text === "string") return result.content.text as string;
  if (typeof result?.content === "string") return result.content as string;
  return undefined;
}

export function createSampler(server: Server, diag?: SamplerDiagnostics): Sampler | undefined {
  const cfg = loadSamplerConfig();

  if (cfg.cerebrasApiKey && cfg.cerebrasModel) {
    return async (prompt: string, maxTokens = 800) => directCerebrasSample(prompt, maxTokens, diag);
  }
  if (cfg.openaiApiKey) {
    return async (prompt: string, maxTokens = 800) => directOpenAISample(prompt, maxTokens, diag);
  }

  // Fall back to MCP sampling (client-provided)
  return async (prompt: string, maxTokens = 800) => {
    try {
      const result: any = await (server as any).createMessage({
        messages: [{ role: "user", content: { type: "text", text: prompt } }],
        maxTokens,
      });
      const respText = extractMcpText(result);
      if (diag) {
        diag.provider = "mcp";
        diag.totalCalls = (diag.totalCalls ?? 0) + 1;
        diag.lastPromptChars = typeof prompt === "string" ? prompt.length : undefined;
        diag.lastResponseChars = typeof respText === "string" ? respText.length : undefined;
        diag.lastModel = typeof result?.model === "string" ? result.model : undefined;
        diag.lastOkAt = new Date().toISOString();
        diag.rawSamples = diag.rawSamples || [];
        diag.rawSamples.push({ prompt, response: respText, model: diag.lastModel, provider: diag.provider, at: new Date().toISOString() });
      }
      const cleaned = typeof respText === "string" ? stripThinkBlocks(respText).trim() : undefined;
      return cleaned ?? respText ?? null;
    } catch {
      if (diag) diag.lastErrorAt = new Date().toISOString();
      return null;
    }
  };
}

