import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { writeFile } from "node:fs/promises";
import { resolve as pathResolve, join as pathJoin, isAbsolute as pathIsAbsolute } from "node:path";
import { DefaultConfig, ReasoningConfig, Session, State } from "../../types.js";
import type { SessionStore } from "../../state/sessionStore.js";
import { loadReasoningDefaults } from "../../config.js";
import { initializeScratchpad, runOneIteration, summarizeSolution } from "../../orchestrator.js";
import { createSampler, shouldEnableSampling } from "../../sampling/sampler.js";
import { createVerifierFromConfig } from "../../verifiers/factory.js";
import { createMemoryFromConfig } from "../../memory/factory.js";
import type { ToolDef } from "../toolRegistry.js";
import { asJson, extractArbiterPicks, getLastRawResponse, makeSessionId, mergeHints } from "../utils/common.js";

export function makeSolveTool(params: {
  server: Server;
  sessionStore: SessionStore;
}): ToolDef {
  const { server, sessionStore } = params;

  return {
    name: "solve",
    description: "One-shot reasoning: start session, run N iterations, return summary and steps. PRIMARY JSON is in content[0].text; agent MUST parse. Supports seedHints. Optional file save via outputPath.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task or goal description (required)" },
        iterations: { type: "number", description: "How many iterations to run", default: 8 },
        config: { type: "object" },
        seedHints: { type: "array", description: "Initial hints to seed into state.hints", items: { type: "string" } },
        outputPath: { type: "string", description: "Optional file path to save the same JSON/text payload" },
        outputFormat: { type: "string", description: "json (default) | text (summary only)", default: "json" }
      },
      required: ["task"],
      additionalProperties: false
    },
    handler: async (args: Record<string, unknown>) => {
      const task = String((args as any).task ?? "").trim();
      if (!task) throw new Error("Missing 'task'");

      const iterations = Number((args as any).iterations ?? 8);
      const cfg = (args as any).config as Partial<ReasoningConfig> | undefined;
      const merged: ReasoningConfig = { ...DefaultConfig, ...loadReasoningDefaults(), ...(cfg ?? {}) };
      if (cfg?.useSampling === undefined) {
        if (shouldEnableSampling(server)) merged.useSampling = true;
      }

      const state: State = initializeScratchpad(task);
      state.hints = mergeHints(state.hints, (args as any).seedHints);
      const id = makeSessionId();
      const memEngine = createMemoryFromConfig(merged);
      const session: Session = { id, state, config: merged, history: [], diagnostics: { totalCalls: 0 }, memory: { kind: memEngine.kind, state: memEngine.initState() as any } };
      sessionStore.set(id, session);

      const sampler = merged.useSampling ? createSampler(server, session.diagnostics!) : undefined;
      const maxCalls = Math.max(0, merged.llmMaxCalls ?? 8);
      for (let i = 0; i < iterations; i++) {
        const verifier = createVerifierFromConfig(merged);
        const budgetReached = sampler && (session.diagnostics?.totalCalls ?? 0) >= maxCalls;
        const { chosen, candidates, newState } = await runOneIteration(
          verifier,
          merged,
          session.state.task,
          session.state,
          budgetReached ? undefined : sampler,
          session.diagnostics
        );
        session.state = newState;
        session.history.push({ chosen, candidates });
      }

      const summary = summarizeSolution(session.state);
      const arbiterPicks = extractArbiterPicks(session.diagnostics);
      const lastRaw = getLastRawResponse(session.diagnostics);
      const enrichedSummary = arbiterPicks.length
        ? `${summary}\n\nArbiter picks (from raw LLM prose):\n- ${arbiterPicks.join("\n- ")}`
        : summary;

      const payload = {
        sessionId: id,
        summary: enrichedSummary,
        arbiterPicks,
        lastRawResponse: lastRaw,
        steps: session.state.steps,
        hints: session.state.hints,
        config: merged,
        diagnostics: session.diagnostics
      };

      const outputPathRaw = (args as any).outputPath;
      const outputFormat = String((args as any).outputFormat ?? "json").toLowerCase();
      if (typeof outputPathRaw === "string" && outputPathRaw.trim().length > 0) {
        try {
          const outputPath = outputPathRaw as string;
          const text = outputFormat === "text" ? summary : JSON.stringify(payload, null, 2);
          const cwd = process.cwd();
          const abs = pathIsAbsolute(outputPath) ? outputPath : pathResolve(cwd, outputPath);
          const safeBase = pathResolve(cwd);
          const safePath = abs.startsWith(safeBase) ? abs : pathResolve(safeBase, pathJoin(".", "summary.json"));
          await writeFile(safePath, text, { encoding: "utf8" });
        } catch {
          // ignore write errors, still return payload
        }
      }

      const content: Array<{ type: "text"; text: string }> = [ { type: "text", text: asJson(payload) } ];
      if (arbiterPicks.length) content.push({ type: "text", text: `Arbiter picks:\n- ${arbiterPicks.join("\n- ")}` });
      if (lastRaw) content.push({ type: "text", text: `Raw LLM response (last):\n${lastRaw}` });
      return { content };
    }
  };
}

