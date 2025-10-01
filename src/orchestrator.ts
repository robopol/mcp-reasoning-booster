import { ReasoningConfig, ScoredStep, State, StepProposal, Verifier } from "./types.js";

export type Sampler = (prompt: string, maxTokens?: number) => Promise<string | null>;

function parseProseToProposals(text: string, k: number): StepProposal[] {
  if (!text) return [];
  const items: StepProposal[] = [];
  // Try JSON-like arrays embedded in prose
  try {
    const s = text.indexOf("[");
    const e = text.lastIndexOf("]");
    if (s >= 0 && e > s) {
      const arr = JSON.parse(text.slice(s, e + 1)) as Array<any>;
      for (const o of arr) {
        if (typeof o?.text === "string") items.push({ text: o.text.trim(), rationale: String(o?.rationale ?? "").trim() });
      }
      if (items.length) return items.slice(0, k);
    }
  } catch {}
  // Bulleted or numbered lists
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^[-*\d]+[.)]?\s+(.*)$/);
    const candidate = ((m && typeof m[1] === "string") ? m[1] : line).trim();
    if (!candidate) continue;
    if (/^rationale[:\-]?/i.test(candidate)) continue;
    if (candidate.length > 200) continue;
    if (items.find(it => it.text === candidate)) continue;
    items.push({ text: candidate, rationale: "Parsed from prose" });
    if (items.length >= k) break;
  }
  return items;
}

function stripThinkingBlocks(text: string): string {
  // Odstráni Qwen/Cerebras <think>...</think> bloky a podobné tagy
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function tryParseJsonArray(raw: string): Array<any> | null {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

function extractProposalsFromRaw(raw: string, k: number): StepProposal[] {
  if (!raw) return [];
  const cleaned = stripThinkingBlocks(raw);

  // 1) Skús code-fence bloky s JSONom (```...```), preferuj posledný
  const fenceRegex = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  const fenced: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(cleaned)) !== null) fenced.push((m[1] ?? ""));
  for (let i = fenced.length - 1; i >= 0; i--) {
    const candidate = fenced[i] ?? "";
    const arr = tryParseJsonArray(candidate.trim());
    if (arr && arr.length) {
      const items: StepProposal[] = arr
        .filter((o: any) => typeof o?.text === "string" && o.text.trim().length > 0)
        .map((o: any) => ({ text: o.text.trim(), rationale: String(o?.rationale ?? "").trim() }));
      if (items.length) return items.slice(0, k);
    }
  }

  // 2) Skús posledný JSON zoznam hranatých zátvoriek v texte
  // Nájdeme poslednú ']' a hľadáme najbližšiu '[' pred ňou; iterujeme späť
  let endIdx = cleaned.lastIndexOf(']');
  while (endIdx >= 0) {
    let startIdx = cleaned.lastIndexOf('[', endIdx);
    while (startIdx >= 0) {
      const slice = cleaned.slice(startIdx, endIdx + 1);
      const arr = tryParseJsonArray(slice);
      if (arr && arr.length) {
        const items: StepProposal[] = arr
          .filter((o: any) => typeof o?.text === "string" && o.text.trim().length > 0)
          .map((o: any) => ({ text: o.text.trim(), rationale: String(o?.rationale ?? "").trim() }));
        if (items.length) return items.slice(0, k);
      }
      startIdx = cleaned.lastIndexOf('[', startIdx - 1);
    }
    endIdx = cleaned.lastIndexOf(']', endIdx - 1);
  }

  return [];
}

export function initializeScratchpad(task: string): State {
  return {
    task,
    steps: [],
    createdAt: new Date().toISOString(),
  };
}

export async function generateCandidateSteps(
  task: string,
  state: State,
  numCandidates: number,
  sampler?: Sampler,
  maxTokens?: number
): Promise<StepProposal[]> {
  if (!sampler) {
    // Fallback heuristic proposals without LLM with diversification
    const templates: string[] = [
      "Identify one concrete subgoal derived from the task.",
      "State a small check/measurement to validate progress.",
      "Split the problem into two smaller actions and pick one.",
      "Clarify assumptions/constraints blocking the next step.",
      "Pick a next action doable in <15 minutes.",
    ];
    const base = templates.length === 0 ? 0 : state.steps.length % templates.length;
    return Array.from({ length: numCandidates }, (_, i) => ({
      text: templates[(base + i) % templates.length]!,
      rationale: "Heuristic diversified proposal without LLM",
    }));
  }

  const lastFew = state.steps.slice(-3).map((s) => `${s.index + 1}. ${s.text}`).join("\n");
  const prompt = [
    "You are the Reasoning Booster. Generate small, local, verifiable next steps for the task.",
    "Task:",
    task,
    "Recent steps:",
    lastFew || "(none)",
    `Return exactly ${numCandidates} items as pure JSON: [{"text": "...", "rationale": "..."}], with no other text. Steps must be short (<= 200 characters).`,
  ].join("\n\n");

  try {
    const raw = await sampler(prompt, maxTokens ?? 800);
    if (!raw) throw new Error("Empty LLM response");
    // 1) Skús robustnú extrakciu s preferenciou posledného JSONu
    const robust = extractProposalsFromRaw(raw, numCandidates);
    if (robust.length > 0) return robust;
    // 2) Pôvodný jednoduchý parser (fallback)
    const jsonStart = raw.indexOf("[");
    const jsonEnd = raw.lastIndexOf("]");
    const jsonText = jsonStart >= 0 && jsonEnd >= 0 ? raw.slice(jsonStart, jsonEnd + 1) : raw;
    const parsed = JSON.parse(jsonText) as Array<{ text: string; rationale?: string }>;
    const proposals: StepProposal[] = parsed
      .filter(o => typeof o?.text === "string" && o.text.trim().length > 0)
      .map(o => ({ text: o.text.trim(), rationale: (o.rationale ?? "").trim() }));
    if (proposals.length > 0) return proposals.slice(0, numCandidates);
  } catch {
    // Try to parse the same response (no re-sampling) as prose
    try {
      // We do not have access to the first raw here; re-querying would double token usage.
      // Therefore, we perform a minimal second attempt only if sampler returns quickly.
      const raw2 = await sampler(prompt, (maxTokens ?? 800) / 4);
      const proposals = extractProposalsFromRaw(raw2 ?? "", numCandidates).length
        ? extractProposalsFromRaw(raw2 ?? "", numCandidates)
        : parseProseToProposals(raw2 ?? "", numCandidates);
      if (proposals.length > 0) return proposals.slice(0, numCandidates);
    } catch {
      // ignore and fall through
    }
  }

  const templates: string[] = [
    "Introduce a small, reversible change and observe impact.",
    "Check a local constraint or assumption implied by the task.",
    "Simplify the goal or split it into two subgoals.",
    "Compare two equivalent formulations and choose one.",
    "Consider a quick test to rule out an invalid path.",
  ];
  const base = templates.length === 0 ? 0 : state.steps.length % templates.length;
  return Array.from({ length: numCandidates }, (_, i) => ({
    text: templates[(base + i) % templates.length]!,
    rationale: "Fallback diversified proposal (JSON parse failed)",
  }));
}

export function scoreCandidates(
  verifier: Verifier,
  task: string,
  state: State,
  proposals: StepProposal[]
): ScoredStep[] {
  return proposals.map(p => ({
    proposal: p,
    score: verifier.scoreStep(task, state, p),
  })).sort((a, b) => b.score.totalScore - a.score.totalScore);
}

export function applyStep(state: State, chosen: ScoredStep): State {
  const nextIndex = state.steps.length;
  return {
    ...state,
    steps: [
      ...state.steps,
      { index: nextIndex, text: chosen.proposal.text, rationale: chosen.proposal.rationale, score: chosen.score },
    ],
  };
}

export function isStagnating(state: State): boolean {
  const steps = state.steps;
  const lastIdx = steps.length - 1;
  const last = steps[lastIdx];
  const prev = steps[lastIdx - 1];
  if (!last || !prev) return false;
  const a = last.text.trim();
  const b = prev.text.trim();
  return a === b;
}

export function isLooping(state: State): boolean {
  const seen = new Set<string>();
  for (const s of state.steps) {
    if (seen.has(s.text)) return true;
    seen.add(s.text);
  }
  return false;
}

export function backtrack(state: State): State {
  if (state.steps.length === 0) return state;
  return { ...state, steps: state.steps.slice(0, -1) };
}

export function summarizeSolution(state: State): string {
  const lastDistinct: string[] = [];
  for (let i = state.steps.length - 1; i >= 0 && lastDistinct.length < 5; i--) {
    const step = state.steps[i];
    if (!step) continue;
    const t = (step.text ?? "").toString().trim();
    if (t && !lastDistinct.includes(t)) lastDistinct.push(t);
  }
  lastDistinct.reverse();
  const header = `Task: ${state.task}`;
  const bullets = lastDistinct.length ? lastDistinct.map(s => `- ${s}`).join("\n") : "- (no steps)";
  return `Summary:\n${header}\n${bullets}`;
}

export async function runOneIteration(
  verifier: Verifier,
  config: ReasoningConfig,
  task: string,
  state: State,
  sampler?: Sampler
): Promise<{ chosen: ScoredStep; candidates: ScoredStep[]; newState: State }> {
  const proposals = await generateCandidateSteps(
    task,
    state,
    config.numCandidates,
    sampler,
    config.samplingMaxTokens
  );
  const scored = scoreCandidates(verifier, task, state, proposals);
  const top = scored.slice(0, Math.max(1, config.topM));
  if (top.length === 0) {
    throw new Error("No candidate steps generated");
  }
  let chosen = (top.find(c => c.proposal.text.trim() !== (state.steps[state.steps.length - 1]?.text.trim())) ?? top[0])!;

  // Stagnation control by score improvement threshold (optional)
  if (typeof config.minImprovement === "number" && state.steps.length > 0) {
    const prevScore = state.steps[state.steps.length - 1]?.score?.totalScore ?? 0;
    if (chosen.score.totalScore - prevScore < config.minImprovement) {
      // If below threshold and beam is enabled, try shallow beam exploration
      if ((config.beamWidth ?? 1) > 1) {
        chosen = await shallowBeam(verifier, config, task, state, top, sampler);
      }
    }
  }

  let nextState = applyStep(state, chosen);

  if (isStagnating(nextState) || isLooping(nextState)) {
    if (config.allowBacktrack) nextState = backtrack(nextState);
  }

  return { chosen, candidates: top, newState: nextState };
}

async function shallowBeam(
  verifier: Verifier,
  config: ReasoningConfig,
  task: string,
  state: State,
  top: ScoredStep[],
  sampler?: Sampler
): Promise<ScoredStep> {
  const width = Math.max(1, config.beamWidth ?? 1);
  const depth = Math.max(1, config.beamDepth ?? 1);
  const branches = top.slice(0, width);

  let best: { score: number; head: ScoredStep } | null = null;
  for (const head of branches) {
    let branchState = applyStep(state, head);
    let cumulative = head.score.totalScore;
    for (let d = 1; d < depth; d++) {
      const proposals = await generateCandidateSteps(
        task,
        branchState,
        config.numCandidates,
        sampler,
        config.samplingMaxTokens
      );
      const scored = scoreCandidates(verifier, task, branchState, proposals);
      const next = scored[0]!;
      cumulative += next.score.totalScore;
      branchState = applyStep(branchState, next);
    }
    if (!best || cumulative > best.score) best = { score: cumulative, head };
  }
  return (best?.head ?? top[0])!;
}


