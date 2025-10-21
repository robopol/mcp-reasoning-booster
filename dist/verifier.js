function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
}
function jaccardSimilarity(a, b) {
    const setA = new Set(a);
    const setB = new Set(b);
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}
function extractKeywords(text, minLen = 5) {
    return new Set(tokenize(text).filter(t => t.length >= minLen));
}
function maxSimilarityWithHistory(state, text) {
    let maxSim = 0;
    for (const s of state.steps) {
        const sim = jaccardSimilarity(tokenize(s.text), tokenize(text));
        if (sim > maxSim)
            maxSim = sim;
    }
    return maxSim;
}
function avgSimilarityWithHistory(state, text) {
    if (!state.steps.length)
        return 0;
    let sum = 0;
    for (const s of state.steps)
        sum += jaccardSimilarity(tokenize(s.text), tokenize(text));
    return sum / state.steps.length;
}
function extractConstraintsFromTask(task) {
    const t = task.toLowerCase();
    const singleActionOnly = /(single|one|exactly\s+one|only\s+one|adjust\s+one\s+factor\s+at\s+a\s+time|one\s+draw)/i.test(task);
    const minimalityDesired = /(minimal\s+steps|minimize|as\s+few\s+steps|efficient)/i.test(task);
    // Try to capture simple enumerations like "(a, b, c)" or comma lists
    const enumMatch = task.match(/\(([^\)]{3,})\)/);
    let enumeratedFactors = [];
    if (enumMatch && enumMatch[1]) {
        enumeratedFactors = enumMatch[1]
            .split(/[,;/]/)
            .map(s => s.trim().toLowerCase())
            .filter(s => s.length > 0 && s.length <= 40);
    }
    else {
        // Fallback: scan for common comma-separated lists in the whole task
        const parts = task.split(/[:,]/);
        if (parts.length > 2) {
            const tail = parts.slice(1).join(",");
            const cands = tail.split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
            if (cands.length >= 3 && cands.length <= 12)
                enumeratedFactors = cands;
        }
    }
    // Dedup
    enumeratedFactors = Array.from(new Set(enumeratedFactors));
    return { singleActionOnly, minimalityDesired, enumeratedFactors };
}
function classifyStepAgainstTask(text, constraints) {
    const lower = text.toLowerCase();
    const actionList = [
        "draw", "pick", "measure", "record", "log", "reduce", "increase", "check", "verify", "label", "assign", "test", "apply", "set", "use", "skip", "relabel", "rename", "observe"
    ];
    const actionVerbs = new Set(actionList.filter(v => new RegExp(`\\b${v}\\b`, "i").test(text)));
    const isObservation = /(draw|pick|measure|record|log|check|verify|test|observe)\b/i.test(text);
    const isRelabelOrAssign = /(label|assign|relabel|rename)\b/i.test(text);
    const isDeduction = /^\s*(if\b|then\b|therefore\b|hence\b|thus\b)/i.test(text) || /\bif\b.*\bthen\b/i.test(text);
    const mentionedFactors = new Set();
    if (constraints.enumeratedFactors.length) {
        for (const f of constraints.enumeratedFactors) {
            if (f.length < 2)
                continue;
            if (lower.includes(f))
                mentionedFactors.add(f);
        }
    }
    return { actionVerbs, mentionedFactors, isObservation, isRelabelOrAssign, isDeduction };
}
function computeObjectiveScores(task, constraints, cls) {
    let objectiveGain = 0.0;
    let constraintPenalty = 0.0;
    // Information-gain proxy: observation of a single factor is valuable
    if (cls.isObservation)
        objectiveGain += 0.3;
    // If there is a list of factors, focusing on a single one helps isolate
    if (constraints.enumeratedFactors.length) {
        if (cls.mentionedFactors.size === 1)
            objectiveGain += 0.15;
        else if (cls.mentionedFactors.size > 1)
            constraintPenalty -= 0.25;
    }
    // Prefer explicit relabel/assignment if it logically follows observation (generic boost)
    if (cls.isRelabelOrAssign)
        objectiveGain += 0.1;
    // Single-action constraint
    if (constraints.singleActionOnly) {
        // Penalize multiple verbs chained with 'and/then'
        const andCount = (task.match(/\band\b|\bthen\b/gi) || []).length;
        if (cls.actionVerbs.size > 1 || andCount > 0)
            constraintPenalty -= 0.2;
        if (cls.mentionedFactors.size > 1)
            constraintPenalty -= 0.25;
    }
    // Minimality preference: observation beats pure deduction in early steps
    if (constraints.minimalityDesired) {
        if (cls.isObservation)
            objectiveGain += 0.1;
        else if (cls.isDeduction)
            constraintPenalty -= 0.05;
    }
    return { objectiveGain, constraintPenalty };
}
export function createVerifier(config) {
    return {
        scoreStep(task, state, proposal) {
            const text = proposal.text.trim();
            // Rules score: prefer short, concrete, reversible hints; penalize vague words
            let rulesScore = 0.0;
            const length = text.length;
            if (length <= 200)
                rulesScore += 0.3;
            else if (length <= 400)
                rulesScore += 0.1;
            else
                rulesScore -= 0.2;
            const vaguePatterns = /(obviously|evidently|clearly|trivial|without proof)/gi;
            const vagueMatches = text.match(vaguePatterns);
            if (vagueMatches)
                rulesScore -= Math.min(0.6, vagueMatches.length * 0.2);
            // Prefer steps with explicit verification hooks
            if (typeof proposal.howToVerify === "string" && proposal.howToVerify.trim().length > 0) {
                rulesScore += 0.2;
            }
            // Outcome entropy (information gain proxy): prefer steps that specify multiple exclusive outcomes
            const entropyBoost = estimateOutcomeEntropy(proposal);
            rulesScore += entropyBoost;
            // Value-of-Information (VoI): IG / (1 + cost)
            const cost = (proposal.verification?.cost ?? 1);
            const voi = entropyBoost / Math.max(1, cost);
            // cap contribution to avoid overpowering other terms
            rulesScore += Math.min(0.2, voi);
            // Information-gain proxies
            const infoGainPatterns = /(if\s|then\s|case|outcome|tilt|balance|verify|check|observe|measure)/gi;
            const infoHits = text.match(infoGainPatterns)?.length ?? 0;
            if (infoHits > 0)
                rulesScore += Math.min(0.3, 0.08 * infoHits);
            // Penalize meta/boilerplate
            const metaOpeners = /^(we\s+are|standard approach|each step must|we must|the task|important:)/i;
            if (metaOpeners.test(text))
                rulesScore -= 0.35;
            // Small boost for explicit finalization if it includes verification or uniqueness
            if (/^final\s+step\s*:/i.test(text)) {
                const hasVerify = typeof proposal.howToVerify === "string" && proposal.howToVerify.trim().length > 0;
                rulesScore += hasVerify ? 0.15 : 0.05;
            }
            // Objective-ish: constraint compliance & information-gain proxy
            const constraints = extractConstraintsFromTask(task);
            const cls = classifyStepAgainstTask(text, constraints);
            const { objectiveGain, constraintPenalty } = computeObjectiveScores(task, constraints, cls);
            rulesScore += objectiveGain + constraintPenalty;
            // Encourage references to the task or previous state
            const taskKeywords = extractKeywords(task);
            const stepKeywords = extractKeywords(text);
            const overlapWithTask = [...stepKeywords].some(k => taskKeywords.has(k));
            if (overlapWithTask)
                rulesScore += 0.15;
            else
                rulesScore -= 0.1;
            // Redundancy/novelty against entire history
            let redundancyScore = 0.0;
            if (state.steps.length > 0) {
                const maxSim = maxSimilarityWithHistory(state, text);
                const avgSim = avgSimilarityWithHistory(state, text);
                if (maxSim >= 0.95)
                    redundancyScore -= 0.5;
                else if (maxSim >= 0.8)
                    redundancyScore -= 0.3;
                else
                    redundancyScore += 0.1;
                if (avgSim < 0.3)
                    rulesScore += 0.2;
                else if (avgSim < 0.5)
                    rulesScore += 0.1;
            }
            else {
                redundancyScore += 0.05;
            }
            // Consistency score: penalize contradiction markers
            let consistencyScore = 0.0;
            const contradictionPatterns = /(in contradiction|in conflict|contradicts|inconsistent)/gi;
            if (contradictionPatterns.test(text))
                consistencyScore -= 0.3;
            else
                consistencyScore += 0.05;
            const totalScore = config.wRules * rulesScore +
                config.wRedundancy * redundancyScore +
                config.wConsistency * consistencyScore;
            return { rulesScore, redundancyScore, consistencyScore, totalScore, entropyBoost, voi, cost };
        },
    };
}
function estimateOutcomeEntropy(proposal) {
    // 1) Prefer structured verification outcomes
    const structLabels = new Set();
    for (const o of proposal.verification?.outcomes ?? []) {
        if (o?.label?.trim())
            structLabels.add(o.label.trim().toLowerCase());
    }
    if (structLabels.size >= 2) {
        const ent = Math.log2(structLabels.size);
        return Math.min(0.25, 0.12 * ent);
    }
    // 2) Fallback to expectedOutcomes
    const eoLabels = new Set();
    for (const o of proposal.expectedOutcomes ?? []) {
        if (o?.label?.trim())
            eoLabels.add(o.label.trim().toLowerCase());
    }
    if (eoLabels.size >= 2) {
        const ent = Math.log2(eoLabels.size);
        return Math.min(0.25, 0.12 * ent);
    }
    // 3) Last resort: heuristics from howToVerify/rationale
    const sources = [];
    if (typeof proposal.howToVerify === "string")
        sources.push(proposal.howToVerify);
    if (typeof proposal?.rationale === "string")
        sources.push(proposal.rationale);
    const joined = sources.join("\n").toLowerCase();
    if (!joined)
        return 0;
    const outcomes = new Set();
    if (/balance/.test(joined))
        outcomes.add("balance");
    if (/left\s*(tilt|heavy)/.test(joined))
        outcomes.add("left");
    if (/right\s*(tilt|heavy)/.test(joined))
        outcomes.add("right");
    if (/(heavier|lighter)/.test(joined))
        outcomes.add("polarity");
    const sepCount = (joined.match(/(;|\bor\b|\/)/g) || []).length;
    if (sepCount >= 1)
        outcomes.add("alt1");
    if (sepCount >= 2)
        outcomes.add("alt2");
    if (/\bif\b.*\bthen\b/.test(joined)) {
        outcomes.add("if");
        if (/\belse\b/.test(joined))
            outcomes.add("else");
    }
    const n = Math.max(1, outcomes.size);
    if (n <= 1)
        return 0;
    const ent = Math.log2(n);
    return Math.min(0.25, 0.12 * ent);
}
