import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { SessionStore } from "../state/sessionStore.js";
import type { ToolDef } from "./toolRegistry.js";
import { makeGetStateTool } from "./tools/getState.js";
import { makeMultiStepTool } from "./tools/multiStep.js";
import { makeCommitTool } from "./tools/commit.js";
import { makeProposeTool } from "./tools/propose.js";
import { makeSolveTool } from "./tools/solve.js";
import { makeSolveTextTool } from "./tools/solveText.js";
import { makeStartTool } from "./tools/start.js";
import { makeStepTool } from "./tools/step.js";
import { makeSummarizeTool } from "./tools/summarize.js";
import { makeUsageTool } from "./tools/usage.js";

export function registerTools(params: {
  server: Server;
  toolRegistry: Map<string, ToolDef>;
  sessionStore: SessionStore;
}): void {
  const { server, toolRegistry, sessionStore } = params;

  toolRegistry.set("start", makeStartTool({ server, sessionStore }));
  toolRegistry.set("step", makeStepTool({ server, sessionStore }));
  toolRegistry.set("multi-step", makeMultiStepTool({ server, sessionStore }));
  toolRegistry.set("get-state", makeGetStateTool({ sessionStore }));
  toolRegistry.set("summarize", makeSummarizeTool({ sessionStore }));
  toolRegistry.set("propose", makeProposeTool({ server, sessionStore }));
  toolRegistry.set("commit", makeCommitTool({ sessionStore }));
  toolRegistry.set("solve", makeSolveTool({ server, sessionStore }));
  toolRegistry.set("solve-text", makeSolveTextTool({ toolRegistry }));
  toolRegistry.set("usage", makeUsageTool());
}

