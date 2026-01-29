import type { SessionStoreConfig } from "../config.js";
import type { SessionStore } from "./sessionStore.js";
import { createInMemorySessionStore } from "./sessionStore.js";

export function createSessionStoreFromConfig(cfg?: SessionStoreConfig): SessionStore {
  const kind = cfg?.kind ?? "memory";
  switch (kind) {
    case "memory":
    default:
      return createInMemorySessionStore();
  }
}

