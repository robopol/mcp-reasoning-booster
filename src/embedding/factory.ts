import type { Embedder } from "./embedder.js";
import { createNoopEmbedder } from "./embedder.js";

export function createEmbedderFromConfig(): Embedder {
  // Scaffold: future kinds (local/server/provider) go here
  return createNoopEmbedder();
}

