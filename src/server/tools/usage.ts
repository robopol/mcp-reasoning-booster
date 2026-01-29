import type { ToolDef } from "../toolRegistry.js";
import { asJson } from "../utils/common.js";

export function makeUsageTool(): ToolDef {
  return {
    name: "usage",
    description: "Call this first. Returns exact how-to (mcp.json, shell commands, examples). PRIMARY JSON is in content[0].text. Mock mode is for local testing only; do not use in production runs.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "optional: 'quick' | 'full'" }
      },
      additionalProperties: false
    },
    handler: async () => {
      const payload = {
        intro: "Reasoning Booster MCP: parse JSON from content[0].text; file output via outputPath is optional.",
        contract: {
          primaryOutput: "JSON in content[0].text",
          parseNote: "Always JSON.parse the first text content.",
        },
        shellCommands: {
          powershell5: "Set-Location mcp-reasoning-booster; npm run build; npx --yes tsx tests\\demo_sampling.ts --sampling=mock --task \"<your task>\"",
          pwsh_or_cmd: "cd mcp-reasoning-booster && npm run build && npx --yes tsx tests\\demo_sampling.ts --sampling=mock --task \"<your task>\"",
          bash: "cd mcp-reasoning-booster && npm run build && npx tsx tests/demo_sampling.ts --sampling=mock --task '<your task>'"
        },
        clientConfig: {
          mcpServers: {
            "reasoning-booster": {
              command: "node",
              args: ["./dist/index.js"],
              cwd: "./mcp-reasoning-booster",
              transport: "stdio"
            }
          }
        },
        tools: {
          start: {
            input: ["task (string)", "config? (object)", "seedHints? (string[])"]
          },
          step: {
            input: ["sessionId (string)", "overrideNumCandidates? (number)", "addHints? (string[])"]
          },
          "multi-step": {
            input: ["sessionId (string)", "iterations (number)", "overrideNumCandidates? (number)", "addHints? (string[])"]
          },
          summarize: { input: ["sessionId (string)"] },
          "get-state": { input: ["sessionId (string)"] },
          solve: {
            input: ["task (string)", "iterations? (number)", "config? (object)", "seedHints? (string[])", "outputPath? (string)", "outputFormat? ('json'|'text')"]
          },
          "solve-text": {
            input: ["task (string)", "iterations? (number)", "config? (object)", "seedHints? (string[])", "outputPath? (string)"]
          }
        },
        examples: {
          solve: {
            name: "solve",
            arguments: {
              task: "Hard problem (succinct).",
              iterations: 10,
              config: { useSampling: true, numCandidates: 8, beamWidth: 2, beamDepth: 2, samplingMaxTokens: 3000 },
              seedHints: ["Define one measurable subgoal and the success criterion.", "Design a quick experiment that isolates one factor."],
              outputPath: "./summary.json",
              outputFormat: "json"
            }
          },
          minimalQuickstartNoSampling: {
            name: "solve",
            arguments: {
              task: "Simple task (succinct).",
              iterations: 6,
              config: { useSampling: false, numCandidates: 3 }
            }
          },
          multiRound: [
            { name: "start", arguments: { task: "Hard problem (succinct).", config: { useSampling: true, numCandidates: 8, beamWidth: 2, beamDepth: 2 }, seedHints: ["Hint A","Hint B"] } },
            { name: "step",  arguments: { sessionId: "ses_...", overrideNumCandidates: 8 } },
            { name: "step",  arguments: { sessionId: "ses_...", overrideNumCandidates: 8, addHints: ["Promoted Hint 1","Promoted Hint 2"] } },
            { name: "summarize", arguments: { sessionId: "ses_..." } }
          ],
          solveText: {
            name: "solve-text",
            arguments: {
              task: "Return plain text summary without JSON parsing.",
              iterations: 8,
              config: { useSampling: false, numCandidates: 5 }
            }
          }
        },
        notes: [
          "Prefer short, verifiable steps with how_to_verify.",
          "Hints should be 3–5 concise, reusable ideas; they propagate across branches.",
          "Use llmMaxCalls to cap token budget; increase samplingMaxTokens if truncation occurs.",
          "Secrets: put API keys into mcp-reasoning-booster/secrets.local.txt (or secrets.txt); environment variables are optional fallback.",
          "Mock note: --sampling=mock enables a local sampler for offline testing only. For real LLMs, omit this flag and ensure secrets are set."
        ]
      };
      return { content: [ { type: "text", text: asJson(payload) } ] };
    }
  };
}

