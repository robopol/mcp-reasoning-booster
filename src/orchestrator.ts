import { ReasoningConfig, ScoredStep, State, StepProposal, Verifier } from "./types.js";

export type Sampler = (prompt: string, maxTokens?: number) => Promise<string | null>;

function parseProseToProposals(text: string, k: number): StepProposal[] {
  if (!text) return [];
  const items: StepProposal[] = [];
  const actionRegex = /\b(weigh|place|swap|move|label|assign|record|check|verify|measure|observe|compare|balance|tilt|test|draw|pick|set|apply|mark|note|split|group|rule|count)\b/i;
  const isPlaceholder = (s: string) => /^(text:|the\s+step\s+description|what\s+to\s+weigh|what\s+to\s+check|how[_\s-]*to[_\s-]*verify|rationale:)/i.test(s.trim());

  // Try JSON-like arrays embedded in prose
  try {
    const s = text.indexOf("[");
    const e = text.lastIndexOf("]");
    if (s >= 0 && e > s) {
      const arr = JSON.parse(text.slice(s, e + 1)) as Array<any>;
      for (const o of arr) {
        if (typeof o?.text === "string") items.push({ text: o.text.trim(), rationale: String(o?.rationale ?? "").trim(), howToVerify: typeof o?.how_to_verify === "string" ? o.how_to_verify.trim() : undefined });
      }
      if (items.length) return items.slice(0, k);
    }
  } catch {}

  // Structured "Text:/Rationale:/How_to_verify:" blocks
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const t = block.match(/\bText:\s*(.+)/i);
    const r = block.match(/\bRationale:\s*(.+)/i);
    const hv = block.match(/\bHow[_\s-]*to[_\s-]*verify:\s*(.+)/i);
    const textVal = t?.[1]?.trim();
    if (textVal && !isPlaceholder(textVal) && textVal.length <= 200 && actionRegex.test(textVal)) {
      items.push({
        text: textVal,
        rationale: (r?.[1]?.trim() ?? "Parsed from prose"),
        howToVerify: hv?.[1]?.trim(),
      });
      if (items.length >= k) return items.slice(0, k);
    }
  }

  // Bulleted/numbered + capture following Rationale/How to verify lines until next bullet/blank
  const lines = text.split(/\r?\n/);
  const bulletRegex = /^\s*[-*\d]+[.)]?\s+(.*)$/;

  let current: StepProposal | null = null;
  const flushCurrent = () => {
    if (!current) return;
    const t = (current.text || "").trim();
    if (t && t.length <= 200 && actionRegex.test(t)) {
      if (!items.find(it => it.text === t)) items.push({
        text: t,
        rationale: (current.rationale || "Parsed from prose").trim(),
        howToVerify: current.howToVerify?.trim(),
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.trim() ?? "";
    if (!raw) { flushCurrent(); continue; }

    const m = raw.match(bulletRegex);
    if (m && typeof m[1] === "string") {
      // New bullet starts -> flush previous
      flushCurrent();
      const candidate = m[1].trim();
      if (isPlaceholder(candidate)) continue;
      // store, action filter will be applied on flush
      current = { text: candidate, rationale: "Parsed from prose" };
      continue;
    }

    // Continuations
    const hv = raw.match(/^(how[_\s-]*to[_\s-]*verify)\s*[:\-]\s*(.+)$/i);
    if (hv && current) {
      const val = typeof hv[2] === "string" ? hv[2].trim() : (typeof hv[1] === "string" ? hv[1].trim() : "");
      if (val) current.howToVerify = val;
      continue;
    }
    const r = raw.match(/^(rationale)\s*[:\-]\s*(.+)$/i);
    if (r && current) {
      const val = typeof r[2] === "string" ? r[2].trim() : (typeof r[1] === "string" ? r[1].trim() : "");
      if (val) current.rationale = val;
      continue;
    }

    // If plain line with action words and current exists, consider appending
    if (current && actionRegex.test(raw)) {
      const combined = `${current.text} ${raw}`.trim();
      current.text = combined.length <= 220 ? combined : current.text;
    }
  }
  flushCurrent();

  return items.slice(0, k);
}

// --- Helpers for novelty/meta filtering and diversity ---
function simpleTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (inter === 0) ? 0 : inter / new Set([...a, ...b]).size;
}

function looksMeta(text: string): boolean {
  return /^(we\s+are|standard approach|each step must|we must|the task|important:)/i.test(text.trim());
}

function isTooSimilarToHistory(state: State, text: string, threshold = 0.8): boolean {
  const t = simpleTokens(text);
  for (const s of state.steps) {
    const sim = jaccard(simpleTokens(s.text), t);
    if (sim >= threshold) return true;
  }
  return false;
}

function dedupeBySimilarity(items: StepProposal[], threshold = 0.92): StepProposal[] {
  const kept: StepProposal[] = [];
  for (const it of items) {
    const t = simpleTokens(it.text);
    let ok = true;
    for (const ex of kept) {
      const sim = jaccard(simpleTokens(ex.text), t);
      if (sim >= threshold) { ok = false; break; }
    }
    if (ok) kept.push(it);
  }
  return kept;
}

function filterAndRankProposals(state: State, proposals: StepProposal[], limit: number): StepProposal[] {
  // Basic hygiene: remove meta/boilerplate and overlong, and steps identical to history
  const cleaned = proposals.filter(p => {
    const txt = (p.text || "").trim();
    if (!txt || txt.length > 400) return false;
    if (looksMeta(txt)) return false;
    return true;
  }).filter(p => !isTooSimilarToHistory(state, p.text, 0.9));

  // Prefer those with howToVerify
  cleaned.sort((a, b) => {
    const av = a.howToVerify && a.howToVerify.trim().length > 0 ? 1 : 0;
    const bv = b.howToVerify && b.howToVerify.trim().length > 0 ? 1 : 0;
    if (av !== bv) return bv - av;
    // shorter is slightly preferred (local action)
    return (a.text.length - b.text.length);
  });

  // Deduplicate by similarity for diversity
  const diverse = dedupeBySimilarity(cleaned, 0.9);
  return diverse.slice(0, Math.max(1, limit));
}

function stripThinkingBlocks(text: string): string {
  // Remove Qwen/Cerebras <think>...</think> blocks and similar tags
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

// --- Domain-sensitive heuristic fallback (still universal-first) ---
function isWeighingTask(task: string): boolean {
  return /(\bweigh|\bbalance|\bscale|\bpan\b|\bcoins?\b)/i.test(task);
}

function buildLabelSetFromTask(task: string): string[] {
  // Prefer 1..12 if task mentions 12, else A..L
  const has12 = /\b12\b/.test(task);
  if (has12) return Array.from({ length: 12 }, (_, i) => String(i + 1));
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  return letters.slice(0, 12);
}

function joinGroup(coins: string[]): string {
  return coins.join(",");
}

function generateWeighingFallback(task: string, k: number): StepProposal[] {
  const labels = buildLabelSetFromTask(task);
  const L = (n: number) => labels.slice(0, Math.min(labels.length, n));
  const steps: StepProposal[] = [];
  // 4v4 (if possible)
  if (labels.length >= 8) {
    const left = joinGroup(labels.slice(0, 4));
    const right = joinGroup(labels.slice(4, 8));
    steps.push({
      text: `Weigh ${left} vs ${right}.`,
      rationale: "Maximize first-cut information; isolates remaining set.",
      howToVerify: "If balanced→suspects in remaining; if left tilts→left heavier or right lighter; if right tilts→right heavier or left lighter.",
    });
  }
  // 3v3 alternative
  if (labels.length >= 6) {
    const left = joinGroup(labels.slice(0, 3));
    const right = joinGroup(labels.slice(3, 6));
    steps.push({
      text: `Weigh ${left} vs ${right}.`,
      rationale: "Non-4v4 alternative; narrower focus for quick branching.",
      howToVerify: "Balance→suspects outside; tilt→heavier side has heavy suspect or opposite side light suspect.",
    });
  }
  // 2v2
  if (labels.length >= 4) {
    const left = joinGroup(labels.slice(0, 2));
    const right = joinGroup(labels.slice(2, 4));
    steps.push({
      text: `Weigh ${left} vs ${right}.`,
      rationale: "Small, local test when suspects are narrowed.",
      howToVerify: "Balance→exclude these four; tilt→map heavier vs lighter hypothesis to sides.",
    });
  }
  // 1v1
  if (labels.length >= 2) {
    const left = labels[0]!;
    const right = labels[1]!;
    steps.push({
      text: `Weigh ${left} vs ${right}.`,
      rationale: "Atomic check to decide between two suspects.",
      howToVerify: "Balance→both genuine; tilt→tilted side indicates heavier or lighter suspect accordingly.",
    });
  }
  // Label/record step (helps universality but concrete)
  steps.push({
    text: `Label items ${joinGroup(L(12))} for tracking and record outcomes.`,
    rationale: "Ensure consistent references across branches.",
    howToVerify: "Count labels→no duplicates/missing; logs include outcome for each weighing.",
  });
  return steps.slice(0, Math.max(1, k));
}

function generateGenericActionableFallback(task: string, k: number): StepProposal[] {
  const steps: StepProposal[] = [
    {
      text: "Define one measurable subgoal and the success criterion.",
      rationale: "Keeps the next move concrete and testable.",
      howToVerify: "Criterion is binary/measurable and tied to task terms.",
    },
    {
      text: "Design a quick experiment that isolates one factor.",
      rationale: "Single-variable change increases information gain.",
      howToVerify: "Only one variable changes; capture before/after metric.",
    },
    {
      text: "Compare two small alternatives; pick one by a clear rule.",
      rationale: "Forces a decision boundary with evidence.",
      howToVerify: "Rule computed on both options produces a strict winner.",
    },
    {
      text: "Check a constraint/assumption blocking progress.",
      rationale: "Invalid assumptions stall reasoning.",
      howToVerify: "Find concrete counterexample or confirm with a minimal test.",
    },
    {
      text: "Record the outcome and update the suspect/option set.",
      rationale: "State update prevents loops and ambiguity.",
      howToVerify: "State delta lists removals/additions with reason.",
    },
  ];
  return steps.slice(0, Math.max(1, k));
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

  // 1) Try code-fenced JSON blocks (```...```), prefer the last one
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
        .map((o: any) => ({
          text: o.text.trim(),
          rationale: String(o?.rationale ?? "").trim(),
          howToVerify: typeof o?.how_to_verify === "string" ? o.how_to_verify.trim() : undefined,
        }));
      if (items.length) return items.slice(0, k);
    }
  }

  // 2) Try the last JSON array delimited by [ ... ] found in the text
  // Find the last ']' and then search back for the nearest '['; iterate backwards
  let endIdx = cleaned.lastIndexOf(']');
  while (endIdx >= 0) {
    let startIdx = cleaned.lastIndexOf('[', endIdx);
    while (startIdx >= 0) {
      const slice = cleaned.slice(startIdx, endIdx + 1);
      const arr = tryParseJsonArray(slice);
      if (arr && arr.length) {
        const items: StepProposal[] = arr
          .filter((o: any) => typeof o?.text === "string" && o.text.trim().length > 0)
          .map((o: any) => ({
            text: o.text.trim(),
            rationale: String(o?.rationale ?? "").trim(),
            howToVerify: typeof o?.how_to_verify === "string" ? o.how_to_verify.trim() : undefined,
          }));
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
    `Return exactly ${numCandidates} items as pure JSON with fields: [{"text": "...", "rationale": "...", "how_to_verify": "..."}] and NO other text. Each step must be <= 200 characters and include how_to_verify as a concrete check. Avoid meta phrases (e.g., "standard approach", "each step must"). Propose alternatives, not repeats of recent steps.`,
  ].join("\n\n");

  try {
    const raw = await sampler(prompt, maxTokens ?? 800);
    if (!raw) throw new Error("Empty LLM response");
    // 1) Try robust extraction preferring the last JSON block
    let robust = extractProposalsFromRaw(raw, numCandidates * 2);
    if (robust.length > 0) {
      robust = filterAndRankProposals(state, robust, numCandidates);
      if (robust.length >= Math.ceil(numCandidates / 2)) return robust;
    }
    // 2) Simple legacy parser (fallback)
    const jsonStart = raw.indexOf("[");
    const jsonEnd = raw.lastIndexOf("]");
    const jsonText = jsonStart >= 0 && jsonEnd >= 0 ? raw.slice(jsonStart, jsonEnd + 1) : raw;
    const parsed = JSON.parse(jsonText) as Array<{ text: string; rationale?: string; how_to_verify?: string }>;
    let proposals: StepProposal[] = parsed
      .filter(o => typeof o?.text === "string" && o.text.trim().length > 0)
      .map(o => ({ text: o.text.trim(), rationale: (o.rationale ?? "").trim(), howToVerify: (o as any)?.how_to_verify ? String((o as any).how_to_verify).trim() : undefined }));
    proposals = filterAndRankProposals(state, proposals, numCandidates);
    if (proposals.length > 0) return proposals.slice(0, numCandidates);
  } catch {
    // Try to parse the same response (no re-sampling) as prose
    try {
      // We do not have access to the first raw here; re-querying would double token usage.
      // Therefore, we perform a minimal second attempt only if sampler returns quickly.
      const strictPrompt = [
        prompt,
        "\n\nConstraints:",
        `- Output exactly ${numCandidates} JSON items; no meta explanations.`,
        "- Each item must be novel vs recent steps and include how_to_verify.",
        "- If unclear, propose alternative layouts/branches rather than repeating.",
      ].join("\n");
      const raw2 = await sampler(strictPrompt, Math.max(200, Math.floor((maxTokens ?? 800) / 3)));
      let proposals = extractProposalsFromRaw(raw2 ?? "", numCandidates * 2);
      if (proposals.length === 0) proposals = parseProseToProposals(raw2 ?? "", numCandidates * 2);
      proposals = filterAndRankProposals(state, proposals, numCandidates);
      if (proposals.length > 0) return proposals.slice(0, numCandidates);
    } catch {
      // ignore and fall through
    }
  }

  // Heuristic fallback: domain-sensitive first, then generic
  const domainFallback = isWeighingTask(task)
    ? generateWeighingFallback(task, numCandidates)
    : generateGenericActionableFallback(task, numCandidates);
  return domainFallback;
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
      { index: nextIndex, text: chosen.proposal.text, rationale: chosen.proposal.rationale, howToVerify: chosen.proposal.howToVerify, score: chosen.score },
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