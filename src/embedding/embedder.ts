export type EmbedderKind = "none";

export interface Embedder {
  kind: EmbedderKind;
  embedText(input: string): Promise<number[] | null>;
}

export function createNoopEmbedder(): Embedder {
  return {
    kind: "none",
    embedText: async () => null,
  };
}

