import type { SamplerDiagnostics } from "../../types.js";

export function makeSessionId(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function mergeHints(existing: string[] | undefined, extras: unknown): string[] {
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

export function extractArbiterPicks(diag?: SamplerDiagnostics): string[] {
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
    const stepLines = lines.filter(l => /^step\s*\d+[:.)]/i.test(l));
    const last = stepLines[stepLines.length - 1];
    if (last && /(gcd\s*(?:is|=)|final|answer|solution|since\b|therefore\b|the\s+counterfeit\s+is\b)/i.test(last)) {
      const key = last.toLowerCase();
      if (!seen.has(key)) { seen.add(key); picks.push(last); }
    }
  }
  return picks.slice(0, 5);
}

export function getLastRawResponse(diag?: SamplerDiagnostics): string | undefined {
  const rs = diag?.rawSamples;
  if (!rs || rs.length === 0) return undefined;
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i]?.response;
    if (typeof r === "string" && r.trim().length > 0) return r.trim();
  }
  return undefined;
}

