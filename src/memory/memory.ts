import type { State, StepProposal } from "../types.js";

export type MemoryKind = "default";

export type MemoryConfig = {
  kind?: MemoryKind;
  tabuSize?: number;
  maxFailures?: number;
};

export type MemoryState = {
  seenStateHashes: string[];
  tabu: string[];
  failures: Array<{ at: string; kind: string; fingerprint: string; detail?: string }>;
  lastStateHash?: string;
  recentStepFingerprints: string[];
};

export type RejectResult = { reject: boolean; reason?: string };

export interface MemoryEngine {
  kind: MemoryKind;
  initState(): MemoryState;
  hashState(state: State): string;
  fingerprintStep(text: string): string;
  fingerprintFailure(kind: string, detail?: string): string;
  shouldReject(mem: MemoryState, state: State, proposal: StepProposal): RejectResult;
  recordState(mem: MemoryState, stateHash: string): void;
  recordStep(mem: MemoryState, stepText: string): void;
  recordFailure(mem: MemoryState, kind: string, detail?: string): void;
  detectOscillation(mem: MemoryState): boolean;
}

function fnv1a32Hex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function normalizeText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createDefaultMemoryEngine(cfg?: MemoryConfig): MemoryEngine {
  const tabuSize = Math.max(0, Math.min(200, Number(cfg?.tabuSize ?? 40)));
  const maxFailures = Math.max(0, Math.min(500, Number(cfg?.maxFailures ?? 80)));

  const initState = (): MemoryState => ({
    seenStateHashes: [],
    tabu: [],
    failures: [],
    recentStepFingerprints: [],
  });

  const hashState = (state: State): string => {
    const steps = (state.steps || []).slice(-12).map(s => normalizeText(s.text)).filter(Boolean);
    const hints = (state.hints || []).slice(-8).map(h => normalizeText(h)).filter(Boolean);
    const payload = [
      "task=" + normalizeText(state.task),
      "steps=" + steps.join("\n"),
      "hints=" + hints.join("\n"),
    ].join("\n---\n");
    return fnv1a32Hex(payload);
  };

  const fingerprintStep = (text: string): string => {
    const n = normalizeText(text);
    return fnv1a32Hex(n);
  };

  const fingerprintFailure = (kind: string, detail?: string): string => {
    const s = `${normalizeText(kind)}|${normalizeText(detail ?? "")}`;
    return fnv1a32Hex(s);
  };

  const shouldReject = (mem: MemoryState, _state: State, proposal: StepProposal): RejectResult => {
    const fp = fingerprintStep(proposal.text);
    if (mem.tabu.includes(fp)) return { reject: true, reason: "tabu" };
    return { reject: false };
  };

  const recordState = (mem: MemoryState, stateHash: string): void => {
    mem.lastStateHash = stateHash;
    if (!mem.seenStateHashes.includes(stateHash)) {
      mem.seenStateHashes.push(stateHash);
      if (mem.seenStateHashes.length > 500) mem.seenStateHashes = mem.seenStateHashes.slice(-500);
    }
  };

  const recordStep = (mem: MemoryState, stepText: string): void => {
    const fp = fingerprintStep(stepText);
    mem.recentStepFingerprints.push(fp);
    if (mem.recentStepFingerprints.length > 12) mem.recentStepFingerprints = mem.recentStepFingerprints.slice(-12);
    if (tabuSize > 0) {
      mem.tabu.push(fp);
      if (mem.tabu.length > tabuSize) mem.tabu = mem.tabu.slice(-tabuSize);
    }
  };

  const recordFailure = (mem: MemoryState, kind: string, detail?: string): void => {
    const fp = fingerprintFailure(kind, detail);
    mem.failures.push({ at: new Date().toISOString(), kind, fingerprint: fp, detail });
    if (mem.failures.length > maxFailures) mem.failures = mem.failures.slice(-maxFailures);
  };

  const detectOscillation = (mem: MemoryState): boolean => {
    // Detect simple ABAB on last 4 committed step fingerprints
    const a = mem.recentStepFingerprints.slice(-4);
    if (a.length < 4) return false;
    return a[0] === a[2] && a[1] === a[3] && a[0] !== a[1];
  };

  return {
    kind: "default",
    initState,
    hashState,
    fingerprintStep,
    fingerprintFailure,
    shouldReject,
    recordState,
    recordStep,
    recordFailure,
    detectOscillation,
  };
}

