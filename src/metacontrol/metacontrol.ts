import type { ReasoningConfig, ScoredStep, State } from "../types.js";
import type { MemoryEngine } from "../memory/memory.js";

export type MetacontrolKind = "default";

export interface MetacontrolDecision {
  useSlowLane: boolean;
  backtrack: boolean;
  reason: string;
}

export interface MetacontrolEngine {
  kind: MetacontrolKind;
  decide(params: {
    config: ReasoningConfig;
    state: State;
    chosen: ScoredStep;
    previousScore?: number;
    memory?: { engine: MemoryEngine; state: any };
  }): MetacontrolDecision;
}

export function createDefaultMetacontrol(): MetacontrolEngine {
  return {
    kind: "default",
    decide: ({ config, state, chosen, previousScore, memory }) => {
      const prev = typeof previousScore === "number" ? previousScore : (state.steps[state.steps.length - 1]?.score?.totalScore ?? 0);
      const delta = chosen.score.totalScore - prev;
      const stagnating = typeof config.minImprovement === "number" ? delta < config.minImprovement : false;
      const oscillating = memory?.engine?.detectOscillation?.(memory.state) ?? false;
      const useSlowLane = (config.beamWidth ?? 1) > 1 && (stagnating || oscillating);
      // backtrack decision is left to orchestrator/commit stage (loop detection) by default
      return {
        useSlowLane,
        backtrack: false,
        reason: useSlowLane ? (oscillating ? "oscillation" : "stagnation") : "fast",
      };
    },
  };
}

