import type { Session } from "../types.js";

export interface SessionStore {
  get(id: string): Session | undefined;
  set(id: string, session: Session): void;
  delete(id: string): boolean;
}

export function createInMemorySessionStore(): SessionStore {
  const map = new Map<string, Session>();
  return {
    get: (id) => map.get(id),
    set: (id, session) => { map.set(id, session); },
    delete: (id) => map.delete(id),
  };
}

