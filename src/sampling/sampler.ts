import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Sampler } from "../orchestrator.js";
import type { SamplerDiagnostics } from "../types.js";
import { loadSamplerConfig } from "../config.js";

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}

function safeExp(x: number): number {
  // avoid overflow
  if (x > 700) return Number.POSITIVE_INFINITY;
  if (x < -700) return 0;
  return Math.exp(x);
}

function computeEntropyFromTopLogprobs(top: any): number | undefined {
  // Accept either:
  // - array of { token, logprob } objects
  // - object map { token: logprob }
  let entries: Array<{ token: string; logprob: number }> = [];
  if (Array.isArray(top)) {
    entries = top
      .map((x: any) => ({ token: String(x?.token ?? ""), logprob: Number(x?.logprob) }))
      .filter(e => e.token && Number.isFinite(e.logprob));
  } else if (top && typeof top === "object") {
    entries = Object.entries(top)
      .map(([tok, lp]) => ({ token: String(tok), logprob: Number(lp) }))
      .filter(e => e.token && Number.isFinite(e.logprob));
  }
  if (entries.length === 0) return undefined;
  // Normalize in log-space
  const maxLp = Math.max(...entries.map(e => e.logprob));
  const ps = entries.map(e => safeExp(e.logprob - maxLp));
  const Z = ps.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(Z) || Z <= 0) return undefined;
  let H = 0;
  for (const p0 of ps) {
    const p = p0 / Z;
    if (p > 0) H += -p * Math.log(p);
  }
  return H; // nats
}

function extractLogprobsMetrics(choice: any, requestedTopK?: number): {
  tokenCount: number;
  avgTokenLogprob: number;
  perplexity: number;
  entropy?: number;
  topK?: number;
} | undefined {
  const lp = choice?.logprobs;
  if (!lp) return undefined;

  // OpenAI-style chat logprobs: { content: [{ token, logprob, top_logprobs: [...] }, ...] }
  const contentArr = lp?.content;
  if (Array.isArray(contentArr) && contentArr.length) {
    const toks = contentArr
      .map((x: any) => Number(x?.logprob))
      .filter((v: number) => Number.isFinite(v));
    if (toks.length === 0) return undefined;
    const avg = toks.reduce((a, b) => a + b, 0) / toks.length;
    const ppl = safeExp(-avg);

    // Optional entropy: average per-token entropy computed from top_logprobs
    const entropies: number[] = [];
    for (const x of contentArr) {
      const e = computeEntropyFromTopLogprobs(x?.top_logprobs);
      if (typeof e === "number" && Number.isFinite(e)) entropies.push(e);
    }
    const entropy = entropies.length ? (entropies.reduce((a, b) => a + b, 0) / entropies.length) : undefined;
    return { tokenCount: toks.length, avgTokenLogprob: avg, perplexity: ppl, entropy, topK: requestedTopK };
  }

  // Completions-style logprobs: { token_logprobs: number[], top_logprobs: object[] }
  const tokenLogprobs = lp?.token_logprobs;
  if (Array.isArray(tokenLogprobs) && tokenLogprobs.length) {
    const toks = tokenLogprobs.map(Number).filter((v: number) => Number.isFinite(v));
    if (toks.length === 0) return undefined;
    const avg = toks.reduce((a, b) => a + b, 0) / toks.length;
    const ppl = safeExp(-avg);
    const topList = lp?.top_logprobs;
    let entropy: number | undefined;
    if (Array.isArray(topList) && topList.length) {
      const entropies: number[] = [];
      for (const top of topList) {
        const e = computeEntropyFromTopLogprobs(top);
        if (typeof e === "number" && Number.isFinite(e)) entropies.push(e);
      }
      entropy = entropies.length ? (entropies.reduce((a, b) => a + b, 0) / entropies.length) : undefined;
    }
    return { tokenCount: toks.length, avgTokenLogprob: avg, perplexity: ppl, entropy, topK: requestedTopK };
  }

  return undefined;
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
  const wantLogprobs = cfg.logprobs === true;
  const topK = clampInt(cfg.topLogprobs, 0, 20, 5);
  try {
    if (diag) {
      diag.provider = "direct-openai";
      diag.totalCalls = (diag.totalCalls ?? 0) + 1;
      diag.lastModel = model;
      diag.lastPromptChars = prompt?.length;
    }
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
        ...(wantLogprobs ? { logprobs: true, top_logprobs: topK } : {}),
      }),
    });
    if (!res.ok) {
      if (diag) {
        diag.lastHttpStatus = res.status;
        diag.lastError = `OpenAI HTTP ${res.status}`;
        diag.lastErrorAt = new Date().toISOString();
      }
      return null;
    }
    const data: any = await res.json();
    const choice: any = data?.choices?.[0];
    const text: string | undefined = choice?.message?.content;
    const metrics = wantLogprobs ? extractLogprobsMetrics(choice, topK) : undefined;
    if (diag) {
      diag.lastResponseChars = text?.length;
      diag.lastOkAt = new Date().toISOString();
      if (metrics) {
        diag.lastTokenCount = metrics.tokenCount;
        diag.lastAvgTokenLogprob = metrics.avgTokenLogprob;
        diag.lastPerplexity = metrics.perplexity;
        diag.lastEntropy = metrics.entropy;
        diag.lastTopLogprobsK = metrics.topK;
      }
      diag.rawSamples = diag.rawSamples || [];
      diag.rawSamples.push({
        prompt,
        response: text,
        model,
        provider: diag.provider,
        at: new Date().toISOString(),
        ...(metrics ? { tokenCount: metrics.tokenCount, avgTokenLogprob: metrics.avgTokenLogprob, perplexity: metrics.perplexity, entropy: metrics.entropy } : {})
      });
    }
    return typeof text === "string" ? text : null;
  } catch (e: any) {
    if (diag) {
      diag.lastErrorAt = new Date().toISOString();
      diag.lastError = String(e?.message ?? e ?? "OpenAI error");
    }
    return null;
  }
}

async function directCerebrasSample(prompt: string, maxTokens: number, diag?: SamplerDiagnostics): Promise<string | null> {
  const cfg = loadSamplerConfig();
  const apiKey = cfg.cerebrasApiKey;
  if (!apiKey) return null;
  const model = cfg.cerebrasModel;
  if (!model) return null;
  const wantLogprobs = cfg.logprobs === true;
  const topK = clampInt(cfg.topLogprobs, 0, 20, 5);
  try {
    const base = (cfg.cerebrasBaseUrl || "https://api.cerebras.ai/v1").replace(/\/$/, "");
    if (diag) {
      diag.provider = "cerebras";
      diag.totalCalls = (diag.totalCalls ?? 0) + 1;
      diag.lastModel = model;
      diag.lastPromptChars = prompt?.length;
    }
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
        ...(wantLogprobs ? { logprobs: true, top_logprobs: topK } : {}),
      }),
    });
    if (!res.ok) {
      let msg = `Cerebras HTTP ${res.status}`;
      try {
        const body = await res.text();
        if (body && body.trim()) msg = `${msg}: ${body.slice(0, 500)}`;
      } catch {}
      if (diag) {
        diag.lastHttpStatus = res.status;
        diag.lastError = msg;
        diag.lastErrorAt = new Date().toISOString();
      }
      return null;
    }
    const data: any = await res.json();
    const choice: any = data?.choices?.[0];
    const text: string | undefined = choice?.message?.content;
    const metrics = wantLogprobs ? extractLogprobsMetrics(choice, topK) : undefined;
    if (diag) {
      diag.lastResponseChars = text?.length;
      diag.lastOkAt = new Date().toISOString();
      if (metrics) {
        diag.lastTokenCount = metrics.tokenCount;
        diag.lastAvgTokenLogprob = metrics.avgTokenLogprob;
        diag.lastPerplexity = metrics.perplexity;
        diag.lastEntropy = metrics.entropy;
        diag.lastTopLogprobsK = metrics.topK;
      }
      diag.rawSamples = diag.rawSamples || [];
      diag.rawSamples.push({
        prompt,
        response: text,
        model,
        provider: diag.provider,
        at: new Date().toISOString(),
        ...(metrics ? { tokenCount: metrics.tokenCount, avgTokenLogprob: metrics.avgTokenLogprob, perplexity: metrics.perplexity, entropy: metrics.entropy } : {})
      });
    }
    return typeof text === "string" ? text : null;
  } catch (e: any) {
    if (diag) {
      diag.lastErrorAt = new Date().toISOString();
      diag.lastError = String(e?.message ?? e ?? "Cerebras error");
    }
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

