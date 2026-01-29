import type { ReasoningConfig } from "../types.js";
import type { MemoryEngine } from "./memory.js";
import { createDefaultMemoryEngine } from "./memory.js";

export function createMemoryFromConfig(cfg: ReasoningConfig): MemoryEngine {
  const kind = cfg.memoryKind ?? "default";
  switch (kind) {
    case "default":
    default:
      return createDefaultMemoryEngine();
  }
}

