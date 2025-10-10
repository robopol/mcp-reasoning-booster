export function isWeighingTaskText(taskOrStep) {
    return /(\bweigh|\bbalance|\bscale|\bpan\b|\bcoins?\b)/i.test(taskOrStep);
}
export function simulateWeighing(task, stepText) {
    // Heuristic simulation: recognize common outcome labels
    const outcomes = [];
    const lower = `${task}\n${stepText}`.toLowerCase();
    const add = (label, note, stateUpdate) => {
        outcomes.push({ label, valid: true, note, stateUpdate });
    };
    if (/weigh/.test(lower)) {
        // canonical tri-outcome for scales
        add("balance", "No difference detected", "narrow: suspects outside compared sets");
        add("left", "Left pan heavier or right lighter", "narrow: focus on left-heavy/right-light suspects");
        add("right", "Right pan heavier or left lighter", "narrow: focus on right-heavy/left-light suspects");
    }
    else {
        // generic pass/fail
        add("pass", undefined, "confirm hypothesis branch");
        add("fail", undefined, "eliminate hypothesis branch");
    }
    return { outcomes };
}
