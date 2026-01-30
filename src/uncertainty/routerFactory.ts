import type { ReasoningConfig } from "../types.js";
import type { UncertaintyRouter } from "./contracts.js";
import { HybridUncertaintyRouter } from "./routers/hybridRouter.js";

class NoopRouter implements UncertaintyRouter {
  decide(): { slowLane: boolean; reasons: string[] } {
    return { slowLane: false, reasons: [] };
  }
}

export function makeUncertaintyRouter(config: ReasoningConfig): UncertaintyRouter {
  const kind = config.uncertaintyRouting?.routerKind ?? (config.uncertaintyRouting?.enabled === false ? "off" : "hybrid");
  if (kind === "off") return new NoopRouter();
  return new HybridUncertaintyRouter();
}

