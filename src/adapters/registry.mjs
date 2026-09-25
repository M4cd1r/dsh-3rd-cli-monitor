// src/adapters/registry.mjs — the adapter registry (the provider plug point).
//
// The application looks adapters up by CLI id here; it never imports a
// concrete adapter. Adding Claude Code, Cursor, OpenCode, or Gemini CLI later
// means writing a new CliAdapter and registering it — zero application or
// host changes.

export class AdapterRegistry {
  constructor() {
    this._adapters = new Map();
  }

  /** Register an adapter; duplicate ids are rejected. */
  register(adapter) {
    if (!adapter || typeof adapter.id !== 'string' || !adapter.id) {
      throw new TypeError('AdapterRegistry: adapter.id (non-empty string) is required');
    }
    if (typeof adapter.discoverRuns !== 'function') {
      throw new TypeError(`AdapterRegistry: adapter "${adapter.id}" must implement discoverRuns()`);
    }
    if (this._adapters.has(adapter.id)) {
      throw new Error(`AdapterRegistry: an adapter with id "${adapter.id}" is already registered`);
    }
    this._adapters.set(adapter.id, adapter);
    return this;
  }

  /** @returns {object|undefined} */
  get(id) {
    return this._adapters.get(id);
  }

  has(id) {
    return this._adapters.has(id);
  }

  ids() {
    return [...this._adapters.keys()];
  }
}
