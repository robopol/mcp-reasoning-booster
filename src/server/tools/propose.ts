import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { SessionStore } from "../../state/sessionStore.js";
import type { ReasoningConfig } from "../../types.js";
import { generateCandidateSteps, scoreCandidates, enrichProposalsWithDomainVerification } from "../../orchestrator.js";
import { createSampler } from "../../sampling/sampler.js";
import { createVerifierFromConfig } from "../../verifiers/factory.js";
import { createMemoryFromConfig } from "../../memory/factory.js";
import { asJson, mergeHints } from "../utils/common.js";
import type { ToolDef } from "../toolRegistry.js";

export function makeProposeTool(params: {
  server: Server;
  sessionStore: SessionStore;
}): ToolDef {
  const { server, sessionStore } = params;

  return {
    name: "propose",
    description: "Judge-only step: generate and score candidate steps without mutating the session state. Stores the last proposal set for a later 'commit'. PRIMARY JSON is in content[0].text.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        k: { type: "number", description: "How many candidates to propose (default: session.config.numCandidates)" },
        mode: { type: "string", description: "fast | slow (currently informational)", default: "fast" },
        addHints: { type: "array", description: "Hints to merge into state.hints before proposing", items: { type: "string" } },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const sessionId = String((args as any).sessionId ?? "");
      const kRaw = (args as any).k;
      const addHints = (args as any).addHints as unknown;
      const mode = String((args as any).mode ?? "fast");

      const session = sessionStore.get(sessionId);
      if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);

      session.state.hints = mergeHints(session.state.hints, addHints);

      const cfg: ReasoningConfig = { ...session.config };
      const k = Math.max(1, Math.min(50, Number(kRaw ?? cfg.numCandidates)));

      const verifier = createVerifierFromConfig(cfg);
      const diag = session.diagnostics ?? (session.diagnostics = { totalCalls: 0 });
      const sampler = session.config.useSampling ? createSampler(server, diag) : undefined;

      const proposals = await generateCandidateSteps(
        session.state.task,
        session.state,
        k,
        sampler,
        cfg.samplingMaxTokens
      );
      enrichProposalsWithDomainVerification(session.state.task, proposals);
      const scored = scoreCandidates(verifier, session.state.task, session.state, proposals);

      const memEngine = createMemoryFromConfig(cfg);
      if (!session.memory || !session.memory.state) {
        session.memory = { kind: memEngine.kind, state: memEngine.initState() as any };
      }
      const memState = session.memory.state as any;

      const accepted: typeof scored = [];
      const rejected: Array<{ text: string; reason: string }> = [];
      for (const s of scored) {
        const r = memEngine.shouldReject(memState, session.state, s.proposal);
        if (r.reject) rejected.push({ text: s.proposal.text, reason: r.reason ?? "rejected" });
        else accepted.push(s);
      }

      session.lastPropose = {
        at: new Date().toISOString(),
        candidates: accepted,
        rejected: rejected.length ? rejected : undefined,
      };
      sessionStore.set(sessionId, session);

      const payload = {
        sessionId,
        mode,
        candidates: accepted,
        rejected,
        stateSnapshot: session.state,
        diagnostics: session.diagnostics,
      };

      return { content: [ { type: "text", text: asJson(payload) } ] };
    }
  };
}

