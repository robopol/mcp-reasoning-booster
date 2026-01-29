import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { SessionStore } from "../../state/sessionStore.js";
import type { ReasoningConfig } from "../../types.js";
import { runOneIteration } from "../../orchestrator.js";
import { createSampler } from "../../sampling/sampler.js";
import { createVerifierFromConfig } from "../../verifiers/factory.js";
import { createMemoryFromConfig } from "../../memory/factory.js";
import type { ToolDef } from "../toolRegistry.js";
import { asJson, mergeHints } from "../utils/common.js";

export function makeStepTool(params: {
  server: Server;
  sessionStore: SessionStore;
}): ToolDef {
  const { server, sessionStore } = params;

  return {
    name: "step",
    description: "One iteration: Best-of-N, scoring and step application. PRIMARY JSON is in content[0].text (chosen, candidates, state). Supports addHints to propagate arbiter-selected ideas before this step.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session identifier from 'start'" },
        overrideNumCandidates: { type: "number" },
        addHints: { type: "array", description: "Hints to merge into state.hints before this step", items: { type: "string" } }
      },
      additionalProperties: false
    },
    handler: async (args: Record<string, unknown>) => {
      const sessionId = String((args as any).sessionId ?? "");
      const overrideNumCandidates = (args as any).overrideNumCandidates as number | undefined;
      const addHints = (args as any).addHints as unknown;

      const session = sessionStore.get(sessionId);
      if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);

      session.state.hints = mergeHints(session.state.hints, addHints);
      const cfg: ReasoningConfig = {
        ...session.config,
        ...(overrideNumCandidates ? { numCandidates: overrideNumCandidates } : {})
      };

      const verifier = createVerifierFromConfig(cfg);
      const diag = session.diagnostics ?? (session.diagnostics = { totalCalls: 0 });
      const sampler = session.config.useSampling ? createSampler(server, diag) : undefined;
      // Ensure memory exists; record state hash (best-effort)
      try {
        const memEngine = createMemoryFromConfig(cfg);
        if (!session.memory || !session.memory.state) {
          session.memory = { kind: memEngine.kind, state: memEngine.initState() as any };
        }
        const ms = session.memory.state as any;
        memEngine.recordState(ms, memEngine.hashState(session.state));
      } catch {}

      const { chosen, candidates, newState } = await runOneIteration(
        verifier,
        cfg,
        session.state.task,
        session.state,
        sampler
      );

      session.state = newState;
      session.history.push({ chosen, candidates });
      // Update memory with committed step/state (best-effort)
      try {
        const memEngine = createMemoryFromConfig(cfg);
        const ms = session.memory?.state as any;
        if (ms) {
          memEngine.recordStep(ms, chosen.proposal.text);
          memEngine.recordState(ms, memEngine.hashState(session.state));
        }
      } catch {}
      sessionStore.set(sessionId, session);

      return {
        content: [
          { type: "text", text: asJson({ chosen, candidates, state: newState }) },
          { type: "text", text: `chosen: ${chosen.proposal.text}` }
        ]
      };
    }
  };
}

