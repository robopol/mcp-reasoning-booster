import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DefaultConfig, ReasoningConfig, Session, State } from "../../types.js";
import type { SessionStore } from "../../state/sessionStore.js";
import { initializeScratchpad } from "../../orchestrator.js";
import { shouldEnableSampling } from "../../sampling/sampler.js";
import type { ToolDef } from "../toolRegistry.js";
import { asJson, makeSessionId, mergeHints } from "../utils/common.js";

export function makeStartTool(params: {
  server: Server;
  sessionStore: SessionStore;
}): ToolDef {
  const { server, sessionStore } = params;

  return {
    name: "start",
    description: "Initialize a reasoning session and its scratchpad for a given task. PRIMARY JSON is in content[0].text; agent MUST parse it. Supports optional seedHints to pre-populate cross-branch ideas.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task or goal description (required)" },
        config: {
          type: "object",
          properties: {
            maxSteps: { type: "number", description: "Max steps to keep in scratchpad", default: 16 },
            numCandidates: { type: "number", description: "Candidates per iteration", default: 5 },
            topM: { type: "number", description: "Top-M kept for selection/beam", default: 2 },
            allowBacktrack: { type: "boolean", description: "Allow backtrack on loops/stagnation", default: true },
            wRules: { type: "number", description: "Weight: rules score", default: 0.6 },
            wRedundancy: { type: "number", description: "Weight: redundancy/novelty", default: 0.25 },
            wConsistency: { type: "number", description: "Weight: consistency", default: 0.15 },
            verifierKind: { type: "string", description: "Verifier/scorer implementation (default)", default: "default" },
            useSampling: { type: "boolean", description: "Enable LLM sampling (auto if keys/capabilities)", default: undefined },
            samplingMaxTokens: { type: "number", description: "LLM max tokens per call", default: 2000 },
            minImprovement: { type: "number", description: "Min score delta to avoid stagnation", default: 0.01 },
            beamWidth: { type: "number", description: "Shallow beam width", default: 1 },
            beamDepth: { type: "number", description: "Shallow beam depth", default: 2 },
            llmMaxCalls: { type: "number", description: "Hard budget of LLM calls", default: 8 },
            resampleOnParseFailure: { type: "boolean", description: "Make a second stricter request if parse fails", default: false },
            voiAlpha: { type: "number", description: "Weight of VoI prior in beam selection", default: 0.5 },
            executeVerification: { type: "boolean", description: "If true, record verification notes into state.uncertainty", default: false }
          },
          additionalProperties: true
        },
        seedHints: { type: "array", description: "Initial hints to seed into state.hints", items: { type: "string" } }
      },
      required: ["task"],
      additionalProperties: false
    },
    handler: async (args: Record<string, unknown>) => {
      const task = String((args as any).task ?? "").trim();
      const cfg = (args as any).config as Partial<ReasoningConfig> | undefined;
      if (!task) throw new Error("Missing 'task'");

      const merged: ReasoningConfig = { ...DefaultConfig, ...(cfg ?? {}) };
      if (cfg?.useSampling === undefined) {
        if (shouldEnableSampling(server)) merged.useSampling = true;
      }

      const state: State = initializeScratchpad(task);
      state.hints = mergeHints(state.hints, (args as any).seedHints);

      const id = makeSessionId();
      const session: Session = { id, state, config: merged, history: [] };
      sessionStore.set(id, session);

      return {
        content: [
          { type: "text", text: asJson({ sessionId: id, state, config: merged }) },
          { type: "text", text: `sessionId: ${id}` }
        ]
      };
    }
  };
}

