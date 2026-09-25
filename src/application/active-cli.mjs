// src/application/active-cli.mjs — active CLI selection.
//
// Which third-party CLI is observed is configuration, never behavior: the
// selection changes what the monitor reads, and never how any CLI is
// launched (this package has no launch path at all). The selection is one
// small durable document at the state root so the host plugin and the
// standalone CLI agree.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../storage/atomic-write.mjs';

const ACTIVE_FILE = 'active-cli.json';

export class ActiveCliService {
  /**
   * @param {{stateRoot: string, registry: object, defaultCli?: string, clock?: {now: () => number}, logger?: object}} opts
   */
  constructor(opts) {
    this.stateRoot = opts.stateRoot;
    this.registry = opts.registry;
    this.defaultCli = opts.defaultCli ?? 'zcode';
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.logger = opts.logger ?? {};
  }

  _path() {
    return join(this.stateRoot, ACTIVE_FILE);
  }

  /**
   * The active CLI id. A persisted value that no longer matches a registered
   * adapter falls back to the default (fail-safe, never throws).
   */
  get() {
    let persisted = null;
    try {
      const raw = JSON.parse(readFileSync(this._path(), 'utf8'));
      if (typeof raw?.cliId === 'string') persisted = raw.cliId;
    } catch {
      // absent or unreadable: use the default
    }
    if (persisted && this.registry.has(persisted)) return persisted;
    if (persisted) {
      try {
        this.logger?.warn?.(`[dsh-3rd-cli-monitor] activeCli "${persisted}" has no adapter; falling back to "${this.defaultCli}"`);
      } catch {
        // ignore
      }
    }
    return this.registry.has(this.defaultCli) ? this.defaultCli : this.registry.ids()[0] ?? this.defaultCli;
  }

  /**
   * Select the active CLI. The id must match a registered adapter — this is
   * the guard that keeps a typo from silently pointing the monitor at
   * nothing.
   */
  set(cliId) {
    if (typeof cliId !== 'string' || !cliId) throw new RangeError('activeCli: a CLI id is required');
    if (!this.registry.has(cliId)) {
      throw new RangeError(`activeCli: unknown CLI "${cliId}" (available: ${this.registry.ids().join(', ') || 'none'})`);
    }
    atomicWriteFileSync(this._path(), JSON.stringify({
      cliId,
      updatedAt: new Date(this.clock.now()).toISOString(),
    }, null, 2) + '\n');
    return this.get();
  }
}
