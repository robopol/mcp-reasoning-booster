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
  llmMaxCalls?: number; // hard budget for total LLM calls within a session/run
  resampleOnParseFailure?: boolean; // if true, allows one extra resample when parsing fails
  voiAlpha?: number; // [0..1] weight for VoI prior/smoothing in beam selection
  executeVerification?: boolean; // if true, record verification outcomes/notes into state.uncertainty
}

export interface ExpectedOutcome {
  label: string;
  note?: string;
}

export interface VerificationSpec {
  kind?: "weighing" | "check" | "compare" | "measure" | "test";
  procedure?: string;
  outcomes?: Array<{
    label: string;
    rule?: string;
    stateUpdate?: string;
    prob?: number;
  }>;
  cost?: number;
  logFields?: string[];
}

export interface StepProposal {
  text: string;
  rationale: string;
  howToVerify?: string;
  expectedOutcomes?: ExpectedOutcome[];
  verification?: VerificationSpec;
}

export interface StepScoreParts {
  rulesScore: number;
  redundancyScore: number;
  consistencyScore: number;
  totalScore: number;
  entropyBoost?: number;
  voi?: number;
  cost?: number;
}

export interface ScoredStep {
  proposal: StepProposal;
  score: StepScoreParts;
}

export interface StateStepEntry {
  index: number;
  text: string;
  rationale: string;
  howToVerify?: string;
  expectedOutcomes?: ExpectedOutcome[];
  score?: StepScoreParts;
  voi?: number;
  ig?: number;
  cost?: number;
}

export interface State {
  task: string;
  steps: StateStepEntry[];
  createdAt: string;
  hints?: string[];
  uncertainty?: {
    hypotheses?: string[];
    eliminated?: string[];
    notes?: string[];
  };
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
  samplingMaxTokens: 2000,
  minImprovement: 0.01,
  beamWidth: 1,
  beamDepth: 2,
  llmMaxCalls: 8,
  resampleOnParseFailure: false,
  voiAlpha: 0.5,
  executeVerification: false,
};


