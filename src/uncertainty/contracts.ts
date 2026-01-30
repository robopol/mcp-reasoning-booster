import type { ReasoningConfig, SamplerDiagnostics, ScoredStep, State } from "../types.js";

export type RoutingDecision = {
  slowLane: boolean;
  reasons: string[];
  overrides?: Partial<ReasoningConfig>;
};

export type RoutingInputs = {
  task: string;
  state: State;
  config: ReasoningConfig;
  scored: ScoredStep[];
  top: ScoredStep[];
  chosen: ScoredStep;
  diagnostics?: SamplerDiagnostics;
};

export interface UncertaintyRouter {
  decide(input: RoutingInputs): RoutingDecision;
}

