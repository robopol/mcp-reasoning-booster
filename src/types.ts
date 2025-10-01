export interface ReasoningConfig {
  maxSteps: number;
  numCandidates: number;
  topM: number;
  allowBacktrack: boolean;
  wRules: number;
  wRedundancy: number;
  wConsistency: number;
  useSampling?: boolean;
  samplingMaxTokens?: number;
  minImprovement?: number;
  beamWidth?: number;
  beamDepth?: number;
}

export interface StepProposal {
  text: string;
  rationale: string;
}

export interface StepScoreParts {
  rulesScore: number;
  redundancyScore: number;
  consistencyScore: number;
  totalScore: number;
}

export interface ScoredStep {
  proposal: StepProposal;
  score: StepScoreParts;
}

export interface StateStepEntry {
  index: number;
  text: string;
  rationale: string;
  score?: StepScoreParts;
}

export interface State {
  task: string;
  steps: StateStepEntry[];
  createdAt: string;
}

export interface Session {
  id: string;
  state: State;
  config: ReasoningConfig;
  history: Array<{ chosen: ScoredStep; candidates: ScoredStep[] }>;
  diagnostics?: SamplerDiagnostics;
}

export interface Verifier {
  scoreStep: (task: string, state: State, proposal: StepProposal) => StepScoreParts;
}

export interface SamplerDiagnostics {
  totalCalls: number;
  lastPromptChars?: number;
  lastResponseChars?: number;
  lastModel?: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  provider?: string; // "mcp" | "direct-openai" | "direct-anthropic" | other
  rawSamples?: Array<{
    prompt: string;
    response?: string;
    model?: string;
    provider?: string;
    at: string;
  }>;
}

export const DefaultConfig: ReasoningConfig = {
  maxSteps: 16,
  numCandidates: 5,
  topM: 2,
  allowBacktrack: true,
  wRules: 0.6,
  wRedundancy: 0.25,
  wConsistency: 0.15,
  useSampling: false,
  samplingMaxTokens: 800,
  minImprovement: 0.01,
  beamWidth: 1,
  beamDepth: 2,
};


