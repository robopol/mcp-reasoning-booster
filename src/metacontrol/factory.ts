import type { ReasoningConfig } from "../types.js";
import type { MetacontrolEngine } from "./metacontrol.js";
import { createDefaultMetacontrol } from "./metacontrol.js";

export function createMetacontrolFromConfig(cfg: ReasoningConfig): MetacontrolEngine {
  const kind = cfg.metacontrolKind ?? "default";
  switch (kind) {
    case "default":
    default:
      return createDefaultMetacontrol();
  }
}

