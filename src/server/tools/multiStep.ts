import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { SessionStore } from "../../state/sessionStore.js";
import type { ReasoningConfig } from "../../types.js";
import { runOneIteration } from "../../orchestrator.js";
import { createSampler } from "../../sampling/sampler.js";
import { createVerifierFromConfig } from "../../verifiers/factory.js";
import type { ToolDef } from "../toolRegistry.js";
import { asJson, mergeHints } from "../utils/common.js";

export function makeMultiStepTool(params: {
  server: Server;
  sessionStore: SessionStore;
}): ToolDef {
  const { server, sessionStore } = params;

  return {
    name: "multi-step",
    description: "Run N iterations with optional budget overrides and return final state. PRIMARY JSON is in content[0].text (state). Supports addHints to seed hints for all iterations in this call.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        iterations: { type: "number" },
        overrideNumCandidates: { type: "number" },
        addHints: { type: "array", description: "Hints to merge into state.hints before iterations", items: { type: "string" } }
      },
      additionalProperties: false
    },
    handler: async (args: Record<string, unknown>) => {
      const sessionId = String((args as any).sessionId ?? "");
      const iterations = Number((args as any).iterations ?? 1);
      const overrideNumCandidates = (args as any).overrideNumCandidates as number | undefined;

      const session = sessionStore.get(sessionId);
      if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);

      session.state.hints = mergeHints(session.state.hints, (args as any).addHints);
      const diag = session.diagnostics ?? (session.diagnostics = { totalCalls: 0 });
      const sampler = session.config.useSampling ? createSampler(server, diag) : undefined;

      for (let i = 0; i < iterations; i++) {
        const cfg: ReasoningConfig = {
          ...session.config,
          ...(overrideNumCandidates ? { numCandidates: overrideNumCandidates } : {})
        };
        const verifier = createVerifierFromConfig(cfg);
        const { chosen, candidates, newState } = await runOneIteration(
          verifier,
          cfg,
          session.state.task,
          session.state,
          sampler
        );
        session.state = newState;
        session.history.push({ chosen, candidates });
      }

      sessionStore.set(sessionId, session);
      return { content: [ { type: "text", text: asJson({ state: session.state }) } ] };
    }
  };
}

