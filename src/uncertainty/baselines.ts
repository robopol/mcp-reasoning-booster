import { RollingWindow } from "./rollingWindow.js";

export type UncertaintyMetricName = "entropy" | "perplexity" | "avgTokenLogprob";

export type UncertaintyKey = {
  provider?: string;
  model?: string;
  topLogprobsK?: number;
  metric: UncertaintyMetricName;
};

function keyToString(k: UncertaintyKey): string {
  const prov = (k.provider || "unknown").trim() || "unknown";
  const model = (k.model || "unknown").trim() || "unknown";
  const topk = Number.isFinite(k.topLogprobsK as any) ? String(k.topLogprobsK) : "na";
  return `${prov}::${model}::topk=${topk}::${k.metric}`;
}

export type BaselineDecision = {
  ok: boolean;
  reason?: string;
  value: number;
  qHigh?: number;
  qSpike?: number;
  highThreshold?: number;
  spikeThreshold?: number;
  median?: number;
  mad?: number;
  n: number;
};

export class UncertaintyBaselines {
  private readonly maxWindow: number;
  private readonly series = new Map<string, RollingWindow>();

  constructor(maxWindow: number) {
    this.maxWindow = Math.max(32, Math.floor(maxWindow));
  }

  private getWindow(k: UncertaintyKey, windowSize?: number): RollingWindow {
    const id = keyToString(k);
    let w = this.series.get(id);
    if (!w) {
      w = new RollingWindow(windowSize ?? this.maxWindow);
      this.series.set(id, w);
    }
    return w;
  }

  observe(k: UncertaintyKey, value: number, windowSize?: number): void {
    this.getWindow(k, windowSize).push(value);
  }

  decideQuantile(
    k: UncertaintyKey,
    value: number,
    params: { minSamples: number; windowSize: number; highQuantile: number; spikeQuantile: number }
  ): BaselineDecision {
    const w = this.getWindow(k, params.windowSize);
    const st = w.stats();
    const n = st.count;
    if (n < Math.max(8, params.minSamples)) {
      return { ok: false, reason: "not_enough_samples", value, n };
    }
    const highThreshold = w.quantile(params.highQuantile);
    const spikeThreshold = w.quantile(params.spikeQuantile);
    return {
      ok: true,
      value,
      qHigh: params.highQuantile,
      qSpike: params.spikeQuantile,
      highThreshold,
      spikeThreshold,
      n,
    };
  }

  decideMadSpike(
    k: UncertaintyKey,
    value: number,
    params: { minSamples: number; windowSize: number; madK: number }
  ): BaselineDecision {
    const w = this.getWindow(k, params.windowSize);
    const st = w.stats();
    const n = st.count;
    if (n < Math.max(8, params.minSamples)) {
      return { ok: false, reason: "not_enough_samples", value, n };
    }
    const median = st.median;
    const mad = st.mad;
    if (!Number.isFinite(median as any) || !Number.isFinite(mad as any) || (mad as number) <= 1e-12) {
      return { ok: false, reason: "mad_unavailable", value, n, median, mad };
    }
    const spikeThreshold = (median as number) + Math.abs(params.madK) * (mad as number);
    return {
      ok: true,
      value,
      median,
      mad,
      spikeThreshold,
      n,
    };
  }
}

export const GlobalUncertaintyBaselines = new UncertaintyBaselines(256);

