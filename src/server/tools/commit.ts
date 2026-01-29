import type { SessionStore } from "../../state/sessionStore.js";
import type { ReasoningConfig, ScoredStep, StepProposal } from "../../types.js";
import { applyStep, backtrack, isLooping, isStagnating } from "../../orchestrator.js";
import { createVerifierFromConfig } from "../../verifiers/factory.js";
import { createMemoryFromConfig } from "../../memory/factory.js";
import { asJson } from "../utils/common.js";
import type { ToolDef } from "../toolRegistry.js";

export function makeCommitTool(params: { sessionStore: SessionStore }): ToolDef {
  const { sessionStore } = params;

  return {
    name: "commit",
    description: "Apply exactly one chosen step into the session state. Intended for the two-model workflow (Generator -> propose, Arbiter -> commit). PRIMARY JSON is in content[0].text.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        chosenText: { type: "string", description: "Exact step text to commit" },
        chosenIndex: { type: "number", description: "Index into the last propose() candidates" },
        artifact: { description: "Optional artifact/evidence payload to store with the committed step" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const sessionId = String((args as any).sessionId ?? "");
      const chosenTextRaw = (args as any).chosenText;
      const chosenIndexRaw = (args as any).chosenIndex;
      const artifact = (args as any).artifact as unknown;

      const session = sessionStore.get(sessionId);
      if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);

      const cfg: ReasoningConfig = { ...session.config };

      let picked: ScoredStep | undefined;
      if (typeof chosenIndexRaw === "number") {
        const idx = Math.floor(chosenIndexRaw);
        const list = session.lastPropose?.candidates || [];
        picked = list[idx];
        if (!picked) throw new Error(`chosenIndex out of range: ${idx}`);
      } else if (typeof chosenTextRaw === "string" && chosenTextRaw.trim()) {
        const t = chosenTextRaw.trim();
        // Try to match last propose candidates first (keeps rationale/howToVerify/score)
        const list = session.lastPropose?.candidates || [];
        picked = list.find(c => c.proposal.text.trim() === t);
        if (!picked) {
          const verifier = createVerifierFromConfig(cfg);
          const proposal: StepProposal = { text: t, rationale: "Committed by arbiter", artifact };
          const score = verifier.scoreStep(session.state.task, session.state, proposal);
          picked = { proposal, score };
        }
      } else {
        throw new Error("Provide either chosenIndex (number) or chosenText (string)");
      }

      // Attach artifact if provided
      if (artifact !== undefined) {
        picked.proposal.artifact = artifact;
      }

      const prevHash = (() => {
        try {
          const memEngine = createMemoryFromConfig(cfg);
          const ms = session.memory?.state as any;
          return ms ? memEngine.hashState(session.state) : undefined;
        } catch { return undefined; }
      })();

      let newState = applyStep(session.state, picked);
      if (cfg.allowBacktrack && (isStagnating(newState) || isLooping(newState))) {
        newState = backtrack(newState);
      }
      session.state = newState;

      // Update memory tabu/oscillation trackers (best-effort)
      try {
        const memEngine = createMemoryFromConfig(cfg);
        if (!session.memory || !session.memory.state) {
          session.memory = { kind: memEngine.kind, state: memEngine.initState() as any };
        }
        const ms = session.memory.state as any;
        memEngine.recordStep(ms, picked.proposal.text);
        const h = memEngine.hashState(session.state);
        memEngine.recordState(ms, h);
        if (prevHash && prevHash === h) {
          memEngine.recordFailure(ms, "state_repeat", "commit did not change state hash");
        }
      } catch {
        // ignore memory failures
      }

      sessionStore.set(sessionId, session);

      return { content: [ { type: "text", text: asJson({ sessionId, state: session.state }) } ] };
    }
  };
}

