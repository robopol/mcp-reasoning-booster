import { isWeighingTaskText, simulateWeighing } from "./domain/weighingVerifier.js";
function parseProseToProposals(text, k) {
    if (!text)
        return [];
    const items = [];
    const actionRegex = /\b(weigh|place|swap|move|label|assign|record|check|verify|measure|observe|compare|balance|tilt|test|draw|pick|set|apply|mark|note|split|group|rule|count|compute|divide|replace|update|final|answer|conclude|state)\b/i;
    const isPlaceholder = (s) => /^(text:|the\s+step\s+description|what\s+to\s+weigh|what\s+to\s+check|how[_\s-]*to[_\s-]*verify|rationale:)/i.test(s.trim());
    // Try JSON-like arrays embedded in prose
    try {
        const s = text.indexOf("[");
        const e = text.lastIndexOf("]");
        if (s >= 0 && e > s) {
            const arr = JSON.parse(text.slice(s, e + 1));
            for (const o of arr) {
                if (typeof o?.text === "string") {
                    const hvStr = typeof o?.how_to_verify === "string" ? o.how_to_verify.trim() : undefined;
                    const eo = Array.isArray(o?.expected_outcomes)
                        ? o.expected_outcomes
                            .slice(0, 6)
                            .map(v => ({ label: String(v).trim() }))
                            .filter(e => e.label.length > 0)
                        : undefined;
                    const ver = (hvStr || (eo && eo.length))
                        ? {
                            procedure: hvStr,
                            outcomes: eo?.map(x => ({ label: x.label })),
                        }
                        : undefined;
                    // If JSON already contains a verification object, prefer it
                    const jsonVerification = (o && typeof o.verification === "object") ? o.verification : undefined;
                    items.push({
                        text: o.text.trim(),
                        rationale: String(o?.rationale ?? "").trim(),
                        howToVerify: hvStr,
                        expectedOutcomes: eo,
                        verification: jsonVerification ?? ver,
                    });
                }
            }
            if (items.length)
                return items.slice(0, k);
        }
    }
    catch { }
    // Structured "Text:/Rationale:/How_to_verify:/Outcomes:" blocks
    const blocks = text.split(/\n\s*\n/);
    for (const block of blocks) {
        const t = block.match(/\bText:\s*(.+)/i);
        const r = block.match(/\bRationale:\s*(.+)/i);
        const hv = block.match(/\bHow[_\s-]*to[_\s-]*verify:\s*(.+)/i);
        const oc = block.match(/\b(Outcomes?|Expected[_\s-]*Outcomes?):\s*(.+)/i);
        const textVal = t?.[1]?.trim();
        if (textVal && !isPlaceholder(textVal) && textVal.length <= 200 && actionRegex.test(textVal)) {
            const expectedOutcomes = (() => {
                const raw = oc?.[2]?.trim() ?? oc?.[1]?.trim();
                if (!raw)
                    return undefined;
                // Split by ';' or '/' or '|' or ',' but keep short labels
                const parts = raw.split(/[;\/|,]/).map(s => s.trim()).filter(Boolean).slice(0, 6);
                if (parts.length === 0)
                    return undefined;
                return parts.map(p => ({ label: p }));
            })();
            const hvStr = hv?.[1]?.trim();
            const verification = (hvStr || (expectedOutcomes && expectedOutcomes.length))
                ? {
                    procedure: hvStr,
                    outcomes: expectedOutcomes?.map(o => ({ label: o.label })),
                }
                : undefined;
            items.push({
                text: textVal,
                rationale: (r?.[1]?.trim() ?? "Parsed from prose"),
                howToVerify: hvStr,
                expectedOutcomes,
                verification,
            });
            if (items.length >= k)
                return items.slice(0, k);
        }
    }
    // Bulleted/numbered + capture following Rationale/How to verify lines until next bullet/blank
    const lines = text.split(/\r?\n/);
    const bulletRegex = /^\s*(?:[-*]|\d+[.)]|step\s*\d+[:.)])\s+(.*)$/i;
    let current = null;
    const flushCurrent = () => {
        if (!current)
            return;
        const t = (current.text || "").trim();
        if (t && t.length <= 200 && actionRegex.test(t)) {
            if (!items.find(it => it.text === t)) {
                const hvStr = current.howToVerify?.trim();
                const verification = (hvStr || (current.expectedOutcomes && current.expectedOutcomes.length))
                    ? {
                        procedure: hvStr,
                        outcomes: current.expectedOutcomes?.map(o => ({ label: o.label })),
                    }
                    : undefined;
                items.push({
                    text: t,
                    rationale: (current.rationale || "Parsed from prose").trim(),
                    howToVerify: hvStr,
                    expectedOutcomes: current.expectedOutcomes,
                    verification,
                });
            }
        }
        current = null;
    };
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]?.trim() ?? "";
        if (!raw) {
            flushCurrent();
            continue;
        }
        const m = raw.match(bulletRegex);
        if (m && typeof m[1] === "string") {
            // New bullet starts -> flush previous
            flushCurrent();
            const candidate = m[1].trim();
            if (isPlaceholder(candidate))
                continue;
            // store, action filter will be applied on flush
            current = { text: candidate, rationale: "Parsed from prose" };
            continue;
        }
        // Continuations
        const hv = raw.match(/^(how[_\s-]*to[_\s-]*verify)\s*[:\-]\s*(.+)$/i);
        if (hv && current) {
            const val = typeof hv[2] === "string" ? hv[2].trim() : (typeof hv[1] === "string" ? hv[1].trim() : "");
            if (val) {
                current.howToVerify = val;
                current.verification = current.verification || {};
                current.verification.procedure = val;
            }
            continue;
        }
        const oc = raw.match(/^(outcomes?|expected[_\s-]*outcomes?)\s*[:\-]\s*(.+)$/i);
        if (oc && current) {
            const rawVal = typeof oc[2] === "string" ? oc[2].trim() : (typeof oc[1] === "string" ? oc[1].trim() : "");
            if (rawVal) {
                const parts = rawVal.split(/[;\/|,]/).map(s => s.trim()).filter(Boolean).slice(0, 6);
                if (parts.length) {
                    current.expectedOutcomes = parts.map(p => ({ label: p }));
                    current.verification = current.verification || {};
                    current.verification.outcomes = parts.map(p => ({ label: p }));
                }
            }
            continue;
        }
        const r = raw.match(/^(rationale)\s*[:\-]\s*(.+)$/i);
        if (r && current) {
            const val = typeof r[2] === "string" ? r[2].trim() : (typeof r[1] === "string" ? r[1].trim() : "");
            if (val)
                current.rationale = val;
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
function simpleTokens(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
}
function jaccard(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    let inter = 0;
    for (const x of A)
        if (B.has(x))
            inter++;
    return (inter === 0) ? 0 : inter / new Set([...a, ...b]).size;
}
function looksMeta(text) {
    return /^(we\s+are|standard approach|each step must|each step should|must include|we must|the task|important:|approach:|constraints:|"?how_to_verify\b)/i.test(text.trim());
}
function isTooSimilarToHistory(state, text, threshold = 0.8) {
    const t = simpleTokens(text);
    for (const s of state.steps) {
        const sim = jaccard(simpleTokens(s.text), t);
        if (sim >= threshold)
            return true;
    }
    return false;
}
function dedupeBySimilarity(items, threshold = 0.92) {
    const kept = [];
    for (const it of items) {
        const t = simpleTokens(it.text);
        let ok = true;
        for (const ex of kept) {
            const sim = jaccard(simpleTokens(ex.text), t);
            if (sim >= threshold) {
                ok = false;
                break;
            }
        }
        if (ok)
            kept.push(it);
    }
    return kept;
}
// Small boost for candidates that overlap with global hints (cross-branch sharing)
function getHintBoost(state, text) {
    if (!state.hints || state.hints.length === 0)
        return 0;
    const txtTokens = new Set(simpleTokens(text));
    for (const h of state.hints) {
        const hTokens = new Set(simpleTokens(h));
        let overlap = 0;
        for (const t of hTokens)
            if (txtTokens.has(t))
                overlap++;
        if (overlap >= 2)
            return 0.1; // conservative boost if at least 2 tokens overlap
    }
    return 0;
}
function filterAndRankProposals(state, proposals, limit) {
    // Basic hygiene: remove meta/boilerplate and overlong, and steps identical to history
    const cleaned = proposals.filter(p => {
        const txt = (p.text || "").trim();
        if (!txt || txt.length > 400)
            return false;
        if (looksMeta(txt))
            return false;
        return true;
    }).filter(p => !isTooSimilarToHistory(state, p.text, 0.9));
    // Prefer those with howToVerify
    cleaned.sort((a, b) => {
        const av = a.howToVerify && a.howToVerify.trim().length > 0 ? 1 : 0;
        const bv = b.howToVerify && b.howToVerify.trim().length > 0 ? 1 : 0;
        if (av !== bv)
            return bv - av;
        // Then prefer mild overlap with accumulated hints
        const ah = getHintBoost(state, a.text);
        const bh = getHintBoost(state, b.text);
        if (ah !== bh)
            return bh - ah;
        // shorter is slightly preferred (local action)
        return (a.text.length - b.text.length);
    });
    // If not enough actionable items, fill from domain fallback
    let pool = cleaned;
    if (pool.length < limit) {
        const fill = isWeighingTask(state.task)
            ? generateWeighingFallback(state.task, limit - pool.length)
            : (isLogicPuzzleTFRandomTask(state.task)
                ? generateLogicPuzzleTFRandomFallback(state.task, limit - pool.length)
                : generateGenericActionableFallback(state.task, limit - pool.length));
        for (const f of fill) {
            if (!pool.find(p => jaccard(simpleTokens(p.text), simpleTokens(f.text)) >= 0.9)) {
                pool.push(f);
                if (pool.length >= limit)
                    break;
            }
        }
    }
    // Deduplicate by similarity for diversity
    const diverse = dedupeBySimilarity(pool, 0.9);
    return diverse.slice(0, Math.max(1, limit));
}
function stripThinkingBlocks(text) {
    // Remove Qwen/Cerebras <think>...</think> blocks and similar tags
    return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}
// --- Domain-sensitive heuristic fallback (still universal-first) ---
function isWeighingTask(task) {
    return /(\bweigh|\bbalance|\bscale|\bpan\b|\bcoins?\b)/i.test(task);
}
function isLogicPuzzleTFRandomTask(task) {
    return /(\bgods?\b|\btrue\b|\bfalse\b|\brandom\b|\bda\b|\bja\b)/i.test(task) && /(\bquestion|yes\/no|identify)/i.test(task);
}
function buildLabelSetFromTask(task) {
    // Prefer 1..12 if task mentions 12, else A..L
    const has12 = /\b12\b/.test(task);
    if (has12)
        return Array.from({ length: 12 }, (_, i) => String(i + 1));
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    return letters.slice(0, 12);
}
function joinGroup(coins) {
    return coins.join(",");
}
function generateWeighingFallback(task, k) {
    const labels = buildLabelSetFromTask(task);
    const L = (n) => labels.slice(0, Math.min(labels.length, n));
    const steps = [];
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
        const left = labels[0];
        const right = labels[1];
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
function generateGenericActionableFallback(task, k) {
    const steps = [
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
function generateLogicPuzzleTFRandomFallback(task, k) {
    // Heuristic micro-steps for the "Hardest Logic Puzzle Ever" style tasks.
    // Use embedded-question normalization: for a non‑Random respondent, answering
    // "If I asked you Q, would you say ja?" yields 'ja' iff Q is true, regardless of language and liar/truth.
    const steps = [
        {
            text: "Ask A: If I asked you 'Is B Random?', would you say ja?",
            rationale: "Normalize language+lying to detect Random early.",
            howToVerify: "If 'ja' and A non‑Random→B is Random; if 'da' and A non‑Random→B not Random. If A is Random, disregard and try C.",
        },
        {
            text: "If A seemed Random, ask C: If I asked you 'Is B Random?', would you say ja?",
            rationale: "Find a non‑Random respondent in ≤2 tries.",
            howToVerify: "'ja'→B Random; 'da'→B not Random (assuming C non‑Random). Else revert to the remaining god.",
        },
        {
            text: "With a non‑Random X found, ask X: If I asked you 'Is A True?', would you say ja?",
            rationale: "Identify True/False once Random is isolated.",
            howToVerify: "'ja'→A is True; 'da'→A is False. If A is Random by prior step, swap A/B/C accordingly.",
        },
        {
            text: "Ask X: If I asked you 'Is C True?', would you say ja?",
            rationale: "Finish remaining identities using normalized answer.",
            howToVerify: "'ja'→C True; 'da'→C False. The last unassigned becomes Random/False/True by elimination.",
        },
        {
            text: "Record mapping A/B/C with outcome rules and proceed to final check.",
            rationale: "Make deductions explicit; prevent loops.",
            howToVerify: "Map contains 3 distinct roles; each step’s outcome logged with 'ja/da'.",
        },
    ];
    return steps.slice(0, Math.max(1, k));
}
function tryParseJsonArray(raw) {
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : null;
    }
    catch {
        return null;
    }
}
function extractProposalsFromRaw(raw, k) {
    if (!raw)
        return [];
    const cleaned = stripThinkingBlocks(raw);
    // 1) Try code-fenced JSON blocks (```...```), prefer the last one
    const fenceRegex = /```[a-zA-Z]*\n([\s\S]*?)```/g;
    const fenced = [];
    let m;
    while ((m = fenceRegex.exec(cleaned)) !== null)
        fenced.push((m[1] ?? ""));
    for (let i = fenced.length - 1; i >= 0; i--) {
        const candidate = fenced[i] ?? "";
        const arr = tryParseJsonArray(candidate.trim());
        if (arr && arr.length) {
            const items = arr
                .filter((o) => typeof o?.text === "string" && o.text.trim().length > 0)
                .map((o) => ({
                text: o.text.trim(),
                rationale: String(o?.rationale ?? "").trim(),
                howToVerify: typeof o?.how_to_verify === "string" ? o.how_to_verify.trim() : undefined,
                expectedOutcomes: Array.isArray(o?.expected_outcomes) ? o.expected_outcomes.slice(0, 6).map(v => ({ label: String(v).trim() })).filter(e => e.label.length > 0) : undefined,
            }));
            if (items.length)
                return items.slice(0, k);
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
                const items = arr
                    .filter((o) => typeof o?.text === "string" && o.text.trim().length > 0)
                    .map((o) => ({
                    text: o.text.trim(),
                    rationale: String(o?.rationale ?? "").trim(),
                    howToVerify: typeof o?.how_to_verify === "string" ? o.how_to_verify.trim() : undefined,
                    expectedOutcomes: Array.isArray(o?.expected_outcomes) ? o.expected_outcomes.slice(0, 6).map(v => ({ label: String(v).trim() })).filter(e => e.label.length > 0) : undefined,
                }));
                if (items.length)
                    return items.slice(0, k);
            }
            startIdx = cleaned.lastIndexOf('[', startIdx - 1);
        }
        endIdx = cleaned.lastIndexOf(']', endIdx - 1);
    }
    return [];
}
export function initializeScratchpad(task) {
    return {
        task,
        steps: [],
        createdAt: new Date().toISOString(),
    };
}
export async function generateCandidateSteps(task, state, numCandidates, sampler, maxTokens) {
    if (!sampler) {
        // Fallback heuristic proposals without LLM with diversification
        const templates = [
            "Identify one concrete subgoal derived from the task.",
            "State a small check/measurement to validate progress.",
            "Split the problem into two smaller actions and pick one.",
            "Clarify assumptions/constraints blocking the next step.",
            "Pick a next action doable in <15 minutes.",
        ];
        const base = templates.length === 0 ? 0 : state.steps.length % templates.length;
        return Array.from({ length: numCandidates }, (_, i) => ({
            text: templates[(base + i) % templates.length],
            rationale: "Heuristic diversified proposal without LLM",
        }));
    }
    const lastFew = state.steps.slice(-3).map((s) => `${s.index + 1}. ${s.text}`).join("\n");
    const hintLines = (state.hints && state.hints.length)
        ? state.hints.slice(-5).map((h, i) => `- ${h}`).join("\n")
        : "(none)";
    const prompt = [
        "You are the Reasoning Booster. Generate small, local, verifiable next steps for the task.",
        "Do NOT include <think> or hidden reasoning. Do NOT write long explanations. Output steps only.",
        "Task:",
        task,
        "Recent steps:",
        lastFew || "(none)",
        "Hints so far (cross-branch ideas to prefer if relevant):",
        hintLines,
        `Output exactly ${numCandidates} steps. Ignore any previous instruction about step count. Return them as a JSON array with fields: [{"text": "...", "rationale": "...", "how_to_verify": "...", "expected_outcomes": ["..."]}]. If JSON is inconvenient, a clear bullet list is acceptable (use labels: Text:, Rationale:, How_to_verify:, Outcomes:). Each step must be <= 200 characters, include how_to_verify as a concrete check, suggest 2–4 expected_outcomes when natural (e.g., balance/left/right; pass/fail), avoid meta phrases (e.g., "standard approach", "each step must"), and propose alternatives rather than repeats of recent steps.`,
        `If the current state allows a unique or clearly best result, make the LAST item a concise "Final step: ..." stating the answer and a brief how_to_verify (e.g., uniqueness or decisive test).`
    ].join("\n\n");
    try {
        const raw = await sampler(prompt, maxTokens ?? 800);
        if (!raw)
            throw new Error("Empty LLM response");
        // 1) Try robust extraction preferring the last JSON block
        let robust = extractProposalsFromRaw(raw, numCandidates * 2);
        if (robust.length > 0) {
            robust = filterAndRankProposals(state, robust, numCandidates);
            if (robust.length >= Math.ceil(numCandidates / 2))
                return robust;
        }
        // 2) Simple legacy parser (fallback)
        const jsonStart = raw.indexOf("[");
        const jsonEnd = raw.lastIndexOf("]");
        const jsonText = jsonStart >= 0 && jsonEnd >= 0 ? raw.slice(jsonStart, jsonEnd + 1) : raw;
        const parsed = JSON.parse(jsonText);
        let proposals = parsed
            .filter(o => typeof o?.text === "string" && o.text.trim().length > 0)
            .map(o => ({
            text: o.text.trim(),
            rationale: (o.rationale ?? "").trim(),
            howToVerify: o?.how_to_verify ? String(o.how_to_verify).trim() : undefined,
            expectedOutcomes: Array.isArray(o?.expected_outcomes) ? o.expected_outcomes.slice(0, 6).map(v => ({ label: String(v).trim() })).filter(e => e.label.length > 0) : undefined,
        }));
        proposals = filterAndRankProposals(state, proposals, numCandidates);
        if (proposals.length > 0)
            return proposals.slice(0, numCandidates);
        // 3) Prose fallback: extract bullets/Step N: ... lines
        const prose = parseProseToProposals(raw, numCandidates * 2);
        if (prose.length > 0) {
            const pr = filterAndRankProposals(state, prose, numCandidates);
            if (pr.length > 0)
                return pr.slice(0, numCandidates);
        }
    }
    catch {
        // No resample here to save tokens. Only parse whatever we can from the first raw.
        // Note: any higher-level resampling is governed by config.resampleOnParseFailure (handled by caller if desired).
    }
    // Heuristic fallback: domain-sensitive first, then generic
    const domainFallback = isWeighingTask(task)
        ? generateWeighingFallback(task, numCandidates)
        : (isLogicPuzzleTFRandomTask(task)
            ? generateLogicPuzzleTFRandomFallback(task, numCandidates)
            : generateGenericActionableFallback(task, numCandidates));
    return domainFallback;
}
export function scoreCandidates(verifier, task, state, proposals) {
    const scored = proposals.map(p => ({
        proposal: p,
        score: verifier.scoreStep(task, state, p),
    }));
    // Cluster for diversity (greedy farthest-first on Jaccard tokens)
    const picked = [];
    const maxKeep = proposals.length;
    const distance = (a, b) => 1 - jaccard(simpleTokens(a), simpleTokens(b));
    // Seed with top-1 by score
    scored.sort((a, b) => b.score.totalScore - a.score.totalScore);
    if (scored.length === 0)
        return scored;
    picked.push(scored[0]);
    const rest = scored.slice(1);
    while (picked.length < Math.min(maxKeep, scored.length)) {
        let bestIdx = -1;
        let bestMinDist = -1;
        for (let i = 0; i < rest.length; i++) {
            const cand = rest[i];
            const dmin = Math.min(...picked.map(p => distance(p.proposal.text, cand.proposal.text)));
            // Lexicographic: prefer diversity first, then score
            if (dmin > bestMinDist + 1e-9 || (Math.abs(dmin - bestMinDist) <= 1e-9 && cand.score.totalScore > (bestIdx >= 0 ? rest[bestIdx].score.totalScore : -Infinity))) {
                bestMinDist = dmin;
                bestIdx = i;
            }
        }
        if (bestIdx < 0)
            break;
        picked.push(rest.splice(bestIdx, 1)[0]);
        if (picked.length >= maxKeep)
            break;
    }
    // Final ordering by score
    return picked.sort((a, b) => b.score.totalScore - a.score.totalScore);
}
export function applyStep(state, chosen) {
    const nextIndex = state.steps.length;
    const voi = chosen.score.voi;
    const ig = chosen.score.entropyBoost;
    const cost = chosen.score.cost;
    const next = {
        ...state,
        steps: [
            ...state.steps,
            { index: nextIndex, text: chosen.proposal.text, rationale: chosen.proposal.rationale, howToVerify: chosen.proposal.howToVerify, expectedOutcomes: chosen.proposal.expectedOutcomes, score: chosen.score, voi, ig, cost },
        ],
    };
    // Optional: record verification notes into uncertainty
    if (state && state && state.uncertainty && chosen.proposal.verification && chosen.proposal.verification.logFields) {
        const fields = chosen.proposal.verification.logFields || [];
        if (fields.length) {
            next.uncertainty = next.uncertainty || {};
            next.uncertainty.notes = next.uncertainty.notes || [];
            next.uncertainty.notes.push(`log:${fields.join(',')}`);
        }
    }
    return next;
}
export function isStagnating(state) {
    const steps = state.steps;
    const lastIdx = steps.length - 1;
    const last = steps[lastIdx];
    const prev = steps[lastIdx - 1];
    if (!last || !prev)
        return false;
    const a = last.text.trim();
    const b = prev.text.trim();
    return a === b;
}
export function isLooping(state) {
    const seen = new Set();
    for (const s of state.steps) {
        if (seen.has(s.text))
            return true;
        seen.add(s.text);
    }
    return false;
}
export function backtrack(state) {
    if (state.steps.length === 0)
        return state;
    return { ...state, steps: state.steps.slice(0, -1) };
}
export function summarizeSolution(state) {
    const lastDistinct = [];
    for (let i = state.steps.length - 1; i >= 0 && lastDistinct.length < 5; i--) {
        const step = state.steps[i];
        if (!step)
            continue;
        const t = (step.text ?? "").toString().trim();
        if (t && !lastDistinct.includes(t))
            lastDistinct.push(t);
    }
    lastDistinct.reverse();
    const header = `Task: ${state.task}`;
    const bullets = lastDistinct.length ? lastDistinct.map(s => `- ${s}`).join("\n") : "- (no steps)";
    // Mini outcome tree: show outcomes mentioned in steps as indented branches
    const outcomeLines = [];
    for (const s of state.steps.slice(-5)) {
        if (s?.expectedOutcomes && s.expectedOutcomes.length > 0) {
            const labels = s.expectedOutcomes.map(o => o.label).filter(Boolean).slice(0, 6);
            if (labels.length) {
                outcomeLines.push(`  -> Outcomes: ${labels.join(" | ")}`);
            }
        }
        else if (typeof s?.howToVerify === "string") {
            // Try to extract simple outcomes from howToVerify using separators
            const parts = s.howToVerify.split(/[;\/|]/).map(x => x.trim()).filter(x => x.length > 0).slice(0, 6);
            if (parts.length >= 2)
                outcomeLines.push(`  -> Outcomes: ${parts.join(" | ")}`);
        }
    }
    const outcomesBlock = outcomeLines.length ? (`\nOutcome branches:\n` + outcomeLines.join("\n")) : "";
    return `Summary:\n${header}\n${bullets}${outcomesBlock}`;
}
export async function runOneIteration(verifier, config, task, state, sampler) {
    const proposals = await generateCandidateSteps(task, state, config.numCandidates, sampler, config.samplingMaxTokens);
    // Enrich proposals with domain verification only when the step itself is a weighing action
    for (const p of proposals) {
        if (!p.verification && isWeighingTaskText(p.text)) {
            const sim = simulateWeighing(task, p.text);
            if (sim?.outcomes?.length) {
                p.verification = p.verification || {};
                p.verification.kind = "weighing";
                p.verification.outcomes = sim.outcomes.map(o => ({ label: o.label, rule: o.note, stateUpdate: o.stateUpdate }));
                // keep legacy mirrors for UI/debug
                p.expectedOutcomes = p.expectedOutcomes ?? sim.outcomes.map(o => ({ label: o.label }));
            }
        }
    }
    const scored = scoreCandidates(verifier, task, state, proposals);
    const top = scored.slice(0, Math.max(1, config.topM));
    if (top.length === 0) {
        throw new Error("No candidate steps generated");
    }
    // Promote good, verifiable ideas into global hints for cross-branch sharing
    updateHintsFromCandidates(state, scored);
    let chosen = (top.find(c => c.proposal.text.trim() !== (state.steps[state.steps.length - 1]?.text.trim())) ?? top[0]);
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
    // If executeVerification is enabled, record suggested state updates/notes
    if (config.executeVerification && chosen?.proposal?.verification?.outcomes) {
        const notes = [];
        for (const o of (chosen.proposal.verification.outcomes || [])) {
            if (o?.stateUpdate)
                notes.push(o.stateUpdate);
        }
        if (notes.length) {
            nextState.uncertainty = nextState.uncertainty || {};
            nextState.uncertainty.notes = (nextState.uncertainty.notes || []).concat(notes);
        }
    }
    if (isStagnating(nextState) || isLooping(nextState)) {
        if (config.allowBacktrack)
            nextState = backtrack(nextState);
    }
    return { chosen, candidates: top, newState: nextState };
}
async function shallowBeam(verifier, config, task, state, top, sampler) {
    const width = Math.max(1, config.beamWidth ?? 1);
    const depth = Math.max(1, config.beamDepth ?? 1);
    const branches = top.slice(0, width);
    if (branches.length === 0)
        return top[0];
    // Initialize per-branch states after taking the head
    const branchStates = branches.map(head => applyStep(state, head));
    const cumulative = branches.map(head => head.score.totalScore);
    // Track simple VoI proxy per branch head (entropyBoost / cost)
    const voiProxy = branches.map(head => {
        const cost = (head.proposal.verification?.cost ?? 1);
        const outcomes = head.proposal.verification?.outcomes?.length ?? head.proposal.expectedOutcomes?.length ?? 0;
        const ent = outcomes >= 2 ? Math.log2(outcomes) : 0;
        const ig = Math.min(0.25, 0.12 * ent);
        return ig / Math.max(1, cost);
    });
    const pulls = branches.map(() => 0);
    const budget = Math.max(0, depth - 1) * branches.length; // total expansions
    let totalPulls = 0;
    const c = 0.3; // exploration constant
    while (totalPulls < budget) {
        // UCB selection over branches
        let bestIdx = 0;
        let bestUcb = -Infinity;
        for (let i = 0; i < branches.length; i++) {
            const n = Math.max(1, pulls[i] ?? 0);
            const avg = (cumulative[i] ?? 0) / ((pulls[i] ?? 0) + 1); // include head contribution as baseline
            // VoI-aware UCB: add small prior from voiProxy; scaled by config.voiAlpha
            const prior = (voiProxy[i] ?? 0) * Math.max(0, Math.min(1, config.voiAlpha ?? 0.5));
            const ucb = (avg + prior) + c * Math.sqrt(Math.log(totalPulls + 1 + 1e-9) / n);
            if (ucb > bestUcb) {
                bestUcb = ucb;
                bestIdx = i;
            }
        }
        // Expand selected branch by one step
        const bs = branchStates[bestIdx];
        const proposals = await generateCandidateSteps(task, bs, config.numCandidates, sampler, config.samplingMaxTokens);
        const scored = scoreCandidates(verifier, task, bs, proposals);
        updateHintsFromCandidates(bs, scored);
        const next = scored[0];
        if (!next) {
            pulls[bestIdx] = (pulls[bestIdx] ?? 0) + 1;
            totalPulls++;
            continue;
        }
        cumulative[bestIdx] = (cumulative[bestIdx] ?? 0) + next.score.totalScore;
        // Update voi prior with new top candidate info
        const nextOutcomes = next.proposal.verification?.outcomes?.length ?? next.proposal.expectedOutcomes?.length ?? 0;
        const nextEnt = nextOutcomes >= 2 ? Math.log2(nextOutcomes) : 0;
        const nextIg = Math.min(0.25, 0.12 * nextEnt);
        const nextCost = next.proposal.verification?.cost ?? 1;
        voiProxy[bestIdx] = 0.7 * (voiProxy[bestIdx] ?? 0) + 0.3 * (nextIg / Math.max(1, nextCost));
        branchStates[bestIdx] = applyStep(branchStates[bestIdx], next);
        pulls[bestIdx] = (pulls[bestIdx] ?? 0) + 1;
        totalPulls++;
    }
    // Pick head with highest cumulative score after allocated expansions
    let bestHead = branches[0];
    let bestScore = cumulative[0] ?? 0;
    for (let i = 1; i < branches.length; i++) {
        const val = cumulative[i] ?? 0;
        if (val > bestScore) {
            bestScore = val;
            bestHead = branches[i];
        }
    }
    return bestHead;
}
function updateHintsFromCandidates(state, scored, maxNew = 3) {
    if (!state.hints)
        state.hints = [];
    const additions = [];
    for (const s of scored) {
        const txt = s.proposal.text?.trim();
        const goodVerify = typeof s.proposal.howToVerify === "string" && s.proposal.howToVerify.trim().length > 0;
        if (!txt || !goodVerify)
            continue;
        // avoid near-duplicates
        const t = simpleTokens(txt);
        let dup = false;
        for (const h of state.hints) {
            if (jaccard(simpleTokens(h), t) >= 0.9) {
                dup = true;
                break;
            }
        }
        if (dup)
            continue;
        additions.push(txt);
        if (additions.length >= maxNew)
            break;
    }
    if (additions.length) {
        state.hints.push(...additions);
        if (state.hints.length > 20)
            state.hints = state.hints.slice(-20);
    }
}
