export interface WeighingSimulationResult {
  outcomes: Array<{ label: string; valid: boolean; note?: string; stateUpdate?: string }>;
}

export function isWeighingTaskText(taskOrStep: string): boolean {
  return /(\bweigh|\bbalance|\bscale|\bpan\b|\bcoins?\b)/i.test(taskOrStep);
}

export function simulateWeighing(task: string, stepText: string): WeighingSimulationResult {
  // Heuristic simulation: recognize common outcome labels
  const outcomes: Array<{ label: string; valid: boolean; note?: string; stateUpdate?: string }> = [];
  const lower = `${task}\n${stepText}`.toLowerCase();
  const add = (label: string, note?: string, stateUpdate?: string) => {
    outcomes.push({ label, valid: true, note, stateUpdate });
  };

  if (/weigh/.test(lower)) {
    // canonical tri-outcome for scales
    add("balance", "No difference detected", "narrow: suspects outside compared sets");
    add("left", "Left pan heavier or right lighter", "narrow: focus on left-heavy/right-light suspects");
    add("right", "Right pan heavier or left lighter", "narrow: focus on right-heavy/left-light suspects");
  } else {
    // generic pass/fail
    add("pass", undefined, "confirm hypothesis branch");
    add("fail", undefined, "eliminate hypothesis branch");
  }

  return { outcomes };
}
