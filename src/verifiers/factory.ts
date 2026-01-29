import type { ReasoningConfig, Verifier } from "../types.js";
import { createVerifier as createDefaultVerifier } from "../verifier.js";

export function createVerifierFromConfig(config: ReasoningConfig): Verifier {
  // Future-proof: allow swapping verifier implementations via config
  const kind = config.verifierKind ?? "default";
  switch (kind) {
    case "default":
    default:
      return createDefaultVerifier(config);
  }
}

