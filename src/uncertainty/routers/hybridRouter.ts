import type { ReasoningConfig, SamplerDiagnostics, ScoredStep } from "../../types.js";
import { GlobalUncertaintyBaselines } from "../baselines.js";
import type { RoutingDecision, RoutingInputs, UncertaintyRouter } from "../contracts.js";

function safeNum(x: unknown): number | undefined {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function scoreTie(top: ScoredStep[], delta: number): boolean {
  if (top.length < 2) return false;
  const a = top[0]?.score?.totalScore ?? 0;
  const b = top[1]?.score?.totalScore ?? 0;
  return Math.abs(a - b) <= Math.max(0, delta);
}

function baselineKey(diag: SamplerDiagnostics | undefined, metric: "entropy" | "perplexity" | "avgTokenLogprob") {
  return {
    provider: diag?.provider,
    model: diag?.lastModel,
    topLogprobsK: diag?.lastTopLogprobsK,
    metric,
  } as const;
}

export class HybridUncertaintyRouter implements UncertaintyRouter {
  decide(input: RoutingInputs): RoutingDecision {
    const cfg = input.config.uncertaintyRouting;
    if (!cfg?.enabled) return { slowLane: false, reasons: [] };
    if (cfg.routerKind === "off") return { slowLane: false, reasons: [] };

    const reasons: string[] = [];
    const diag = input.diagnostics;

    // Score tie = ambiguity in heuristic judge selection
    const tieDelta = cfg.scoreTieDelta ?? 0.02;
    const isTie = scoreTie(input.top, tieDelta);
    if (isTie) reasons.push(`score_tie<=${tieDelta}`);

    // Observe uncertainty metrics into rolling baselines (relative, model-specific)
    const windowSize = cfg.windowSize ?? 256;
    const minSamples = cfg.minSamples ?? 32;
    const highQ = cfg.highQuantile ?? 0.9;
    const spikeQ = cfg.spikeQuantile ?? 0.97;
    const madK = cfg.madK ?? 3.5;

    const ent = safeNum(diag?.lastEntropy);
    const ppl = safeNum(diag?.lastPerplexity);
    // For logprob, convert to nonconformity: larger = more uncertain
    const nll = ((): number | undefined => {
      const lp = safeNum(diag?.lastAvgTokenLogprob);
      return typeof lp === "number" ? -lp : undefined;
    })();

    const qReasons: string[] = [];
    const spikeReasons: string[] = [];

    if (typeof ent === "number") {
      GlobalUncertaintyBaselines.observe(baselineKey(diag, "entropy"), ent, windowSize);
      const q = GlobalUncertaintyBaselines.decideQuantile(baselineKey(diag, "entropy"), ent, { minSamples, windowSize, highQuantile: highQ, spikeQuantile: spikeQ });
      if (q.ok) {
        if (typeof q.highThreshold === "number" && ent >= q.highThreshold) qReasons.push(`entropy>=q${Math.round(highQ * 100)}`);
        if (typeof q.spikeThreshold === "number" && ent >= q.spikeThreshold) spikeReasons.push(`entropy>=q${Math.round(spikeQ * 100)}`);
      }
      const m = GlobalUncertaintyBaselines.decideMadSpike(baselineKey(diag, "entropy"), ent, { minSamples, windowSize, madK });
      if (m.ok && typeof m.spikeThreshold === "number" && ent >= m.spikeThreshold) spikeReasons.push(`entropy>=median+${madK}mad`);
    }

    if (typeof ppl === "number") {
      GlobalUncertaintyBaselines.observe(baselineKey(diag, "perplexity"), ppl, windowSize);
      const q = GlobalUncertaintyBaselines.decideQuantile(baselineKey(diag, "perplexity"), ppl, { minSamples, windowSize, highQuantile: highQ, spikeQuantile: spikeQ });
      if (q.ok) {
        if (typeof q.highThreshold === "number" && ppl >= q.highThreshold) qReasons.push(`perplexity>=q${Math.round(highQ * 100)}`);
        if (typeof q.spikeThreshold === "number" && ppl >= q.spikeThreshold) spikeReasons.push(`perplexity>=q${Math.round(spikeQ * 100)}`);
      }
      const m = GlobalUncertaintyBaselines.decideMadSpike(baselineKey(diag, "perplexity"), ppl, { minSamples, windowSize, madK });
      if (m.ok && typeof m.spikeThreshold === "number" && ppl >= m.spikeThreshold) spikeReasons.push(`perplexity>=median+${madK}mad`);
    }

    if (typeof nll === "number") {
      GlobalUncertaintyBaselines.observe(baselineKey(diag, "avgTokenLogprob"), nll, windowSize);
      const q = GlobalUncertaintyBaselines.decideQuantile(baselineKey(diag, "avgTokenLogprob"), nll, { minSamples, windowSize, highQuantile: highQ, spikeQuantile: spikeQ });
      if (q.ok) {
        if (typeof q.highThreshold === "number" && nll >= q.highThreshold) qReasons.push(`-avgLogprob>=q${Math.round(highQ * 100)}`);
        if (typeof q.spikeThreshold === "number" && nll >= q.spikeThreshold) spikeReasons.push(`-avgLogprob>=q${Math.round(spikeQ * 100)}`);
      }
      const m = GlobalUncertaintyBaselines.decideMadSpike(baselineKey(diag, "avgTokenLogprob"), nll, { minSamples, windowSize, madK });
      if (m.ok && typeof m.spikeThreshold === "number" && nll >= m.spikeThreshold) spikeReasons.push(`-avgLogprob>=median+${madK}mad`);
    }

    reasons.push(...qReasons.map(r => `high:${r}`));
    reasons.push(...spikeReasons.map(r => `spike:${r}`));

    // Decide Slow Lane:
    // - any "spike" -> Slow
    // - or ("high" + score tie) -> Slow
    const hasSpike = spikeReasons.length > 0;
    const hasHigh = qReasons.length > 0;
    const slowLane = hasSpike || (hasHigh && isTie);

    const overrides: Partial<ReasoningConfig> | undefined = slowLane ? {
      beamWidth: Math.max(input.config.beamWidth ?? 1, cfg.slowLaneBeamWidth ?? 2),
      beamDepth: Math.max(input.config.beamDepth ?? 1, cfg.slowLaneBeamDepth ?? 2),
      numCandidates: Math.max(1, Math.ceil((input.config.numCandidates ?? 5) * (cfg.slowLaneNumCandidatesMultiplier ?? 1.5))),
    } : undefined;

    return { slowLane, reasons, overrides };
  }
}

