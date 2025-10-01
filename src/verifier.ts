import { ReasoningConfig, State, StepProposal, StepScoreParts, Verifier } from "./types.js";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function extractKeywords(text: string, minLen = 5): Set<string> {
  return new Set(tokenize(text).filter(t => t.length >= minLen));
}

export function createVerifier(config: ReasoningConfig): Verifier {
  return {
    scoreStep(task: string, state: State, proposal: StepProposal): StepScoreParts {
      const text = proposal.text.trim();

      // Rules score: prefer short, concrete, reversible hints; penalize vague words
      let rulesScore = 0.0;
      const length = text.length;
      if (length <= 200) rulesScore += 0.3;
      else if (length <= 400) rulesScore += 0.1;
      else rulesScore -= 0.2;

      const vaguePatterns = /(obviously|evidently|clearly|trivial|without proof)/gi;
      const vagueMatches = text.match(vaguePatterns);
      if (vagueMatches) rulesScore -= Math.min(0.6, vagueMatches.length * 0.2);

      // Encourage references to the task or previous state
      const taskKeywords = extractKeywords(task);
      const stepKeywords = extractKeywords(text);
      const overlapWithTask = [...stepKeywords].some(k => taskKeywords.has(k));
      if (overlapWithTask) rulesScore += 0.15;
      else rulesScore -= 0.1;

      // Redundancy score: penalize near-duplicates of the last step
      let redundancyScore = 0.0;
      const last = state.steps[state.steps.length - 1];
      if (last) {
        const sim = jaccardSimilarity(tokenize(last.text), tokenize(text));
        if (sim >= 0.95) redundancyScore -= 0.5;
        else if (sim >= 0.8) redundancyScore -= 0.3;
        else redundancyScore += 0.1;
      } else {
        redundancyScore += 0.05;
      }

      // Consistency score: penalize contradiction markers
      let consistencyScore = 0.0;
      const contradictionPatterns = /(in contradiction|in conflict|contradicts|inconsistent)/gi;
      if (contradictionPatterns.test(text)) consistencyScore -= 0.3;
      else consistencyScore += 0.05;

      const totalScore =
        config.wRules * rulesScore +
        config.wRedundancy * redundancyScore +
        config.wConsistency * consistencyScore;

      return { rulesScore, redundancyScore, consistencyScore, totalScore };
    },
  };
}


