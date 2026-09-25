// src/application/monitor-service.mjs — the polling use-case.
//
// The service depends only on ports (CliAdapter via the registry, RunStore,
// EventStore, RunLockManager, Scheduler, Clock, Logger). It never imports a
// concrete adapter or storage class, and it is the only place that decides
// when a change of state becomes a persisted snapshot and an event.
//
// Cadences (both via the injected Scheduler):
//   pollMs      (default 15s) — full discovery pass over the active CLI.
//   heartbeatMs (default 60s) — status refresh: open runs get their
//                             observedAt refreshed and a run.heartbeat event.
//
// Read-only guarantee: nothing here spawns, signals, or writes anywhere
// except the monitor's own state root.

import { createRunEvent, isOpenState, snapshotFingerprint } from '../domain/model.mjs';
import { LIMITS } from '../domain/redact.mjs';

export class MonitorService {
  /**
   * @param {object} deps
   * @param {import('../adapters/registry.mjs').AdapterRegistry} deps.registry
   * @param {() => string} deps.getActiveCli - resolves the active CLI id.
   * @param {object} deps.store - RunStore + EventStore + RunLockManager faces.
   * @param {{every: Function, stopAll: Function}} [deps.scheduler]
   * @param {{now: () => number}} [deps.clock]
   * @param {{info?: Function, warn?: Function, error?: Function}} [deps.logger]
   * @param {{lockStaleMs?: number}} [opts]
   */
  constructor(deps, opts = {}) {
    this.registry = deps.registry;
    this.getActiveCli = deps.getActiveCli;
    this.store = deps.store;
    this.scheduler = deps.scheduler ?? null;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.logger = deps.logger ?? {};
    this.lockStaleMs = opts.lockStaleMs ?? 30_000;
    this._pollStops = [];
    this._idSeq = 0;
  }

  _nowIso() {
    return new Date(this.clock.now()).toISOString();
  }

  _eventId() {
    this._idSeq += 1;
    return `evt-${this.clock.now()}-${this._idSeq}`;
  }

  _log(level, ...args) {
    try {
      this.logger?.[level]?.(...args);
    } catch {
      // logging must never break monitoring
    }
  }

  /**
   * One discovery pass over the active CLI. Emits and persists transitions.
   * @returns {{cliId: string, discovered: number, changed: number, events: number, unavailable: boolean}}
   */
  async pollOnce() {
    const cliId = this.getActiveCli();
    const adapter = this.registry.get(cliId);
    if (!adapter) {
      return { cliId, discovered: 0, changed: 0, events: 0, unavailable: true, error: `no adapter for CLI "${cliId}"` };
    }
    let observations;
    try {
      observations = adapter.discoverRuns();
    } catch (err) {
      this._log('error', `[dsh-3rd-cli-monitor] adapter "${cliId}" discoverRuns failed`, err);
      return { cliId, discovered: 0, changed: 0, events: 0, unavailable: true, error: String(err?.message ?? err) };
    }
    let changed = 0;
    let events = 0;
    for (const observation of observations) {
      const result = this._processRun(observation, { heartbeat: false });
      changed += result.changed;
      events += result.events;
    }
    return { cliId, discovered: observations.length, changed, events, unavailable: false };
  }

  /**
   * Heartbeat pass: refresh open runs' observedAt and emit run.heartbeat
   * events. Terminal runs are left untouched (no churn).
   */
  async heartbeatOnce() {
    const cliId = this.getActiveCli();
    const adapter = this.registry.get(cliId);
    if (!adapter) return { cliId, refreshed: 0, unavailable: true };
    let observations;
    try {
      observations = adapter.discoverRuns();
    } catch (err) {
      this._log('warn', `[dsh-3rd-cli-monitor] heartbeat discovery failed: ${err?.message ?? err}`);
      return { cliId, refreshed: 0, unavailable: true };
    }
    let refreshed = 0;
    for (const observation of observations) {
      const result = this._processRun(observation, { heartbeat: true });
      refreshed += result.changed;
    }
    return { cliId, refreshed, unavailable: false };
  }

  /**
   * Diff one observation against the persisted snapshot under a per-run lock,
   * persist on change, and append the corresponding events.
   */
  _processRun(observation, { heartbeat }) {
    const outcome = { changed: 0, events: 0 };
    const lock = this.store.acquireRunLock?.(observation.cliId, observation.runId, { staleMs: this.lockStaleMs });
    if (!lock && this.store.acquireRunLock) return outcome; // another monitor owns this run right now
    try {
      const prev = this.store.loadStatus(observation.cliId, observation.runId);
      let next = observation;
      if (prev) {
        next = this._mergePrevious(observation, prev);
      }
      const fingerprint = snapshotFingerprint(next);
      const prevFingerprint = prev ? snapshotFingerprint(prev) : null;
      const stateChanged = !prev || prev.state !== next.state;
      const materialChanged = fingerprint !== prevFingerprint;

      if (heartbeat) {
        if (!prev || next.state !== prev.state) {
          // A heartbeat that discovers a transition is a real poll result.
          this._writeTransition(prev ?? null, next, 'transition-during-heartbeat');
          outcome.changed += 1;
          outcome.events += 1;
          return outcome;
        }
        if (!isOpenState(next.state)) return outcome; // terminal runs: no churn
        next = this._touchObservedAt(next);
        this.store.writeStatus(next);
        this.store.appendEvents(next.cliId, next.runId, [
          createRunEvent({
            type: 'run.heartbeat',
            runId: next.runId,
            cliId: next.cliId,
            sessionId: next.sessionId,
            fromState: next.state,
            toState: next.state,
            at: next.observedAt,
          }, { idGen: () => this._eventId() }),
        ]);
        outcome.changed += 1;
        outcome.events += 1;
        return outcome;
      }

      if (!prev) {
        this.store.writeStatus(next);
        this.store.appendEvents(next.cliId, next.runId, [
          createRunEvent({
            type: 'run.discovered',
            runId: next.runId,
            cliId: next.cliId,
            sessionId: next.sessionId,
            fromState: null,
            toState: next.state,
            at: next.observedAt,
          }, { idGen: () => this._eventId() }),
        ]);
        outcome.changed += 1;
        outcome.events += 1;
      } else if (materialChanged) {
        this.store.writeStatus(next);
        outcome.changed += 1;
        if (stateChanged) {
          this.store.appendEvents(next.cliId, next.runId, [
            createRunEvent({
              type: 'run.state-changed',
              runId: next.runId,
              cliId: next.cliId,
              sessionId: next.sessionId,
              fromState: prev.state,
              toState: next.state,
              at: next.observedAt,
            }, { idGen: () => this._eventId() }),
          ]);
          outcome.events += 1;
        }
      }
      return outcome;
    } catch (err) {
      this._log('error', `[dsh-3rd-cli-monitor] processing run ${observation.runId} failed`, err);
      return outcome;
    } finally {
      try {
        lock?.release();
      } catch {
        // lock release is best effort; staleness cleans up
      }
    }
  }

  /** Carry fields forward that the adapter cannot re-derive every poll. */
  _mergePrevious(observation, prev) {
    const merged = { ...observation };
    if (!merged.sessionId && prev.sessionId) merged.sessionId = prev.sessionId;
    return merged;
  }

  _touchObservedAt(snapshot) {
    return { ...snapshot, observedAt: this._nowIso() };
  }

  _writeTransition(prev, next, reason) {
    this.store.writeStatus(next);
    this.store.appendEvents(next.cliId, next.runId, [
      createRunEvent({
        type: prev ? 'run.state-changed' : 'run.discovered',
        runId: next.runId,
        cliId: next.cliId,
        sessionId: next.sessionId,
        fromState: prev ? prev.state : null,
        toState: next.state,
        reason,
        at: next.observedAt,
      }, { idGen: () => this._eventId() }),
    ]);
  }

  /**
   * Bind the poll and heartbeat cadences to the injected scheduler. Returns
   * a stop function; tests that drive ticks by hand simply never call this.
   */
  startCadences({ pollMs, heartbeatMs } = {}) {
    if (!this.scheduler) throw new Error('MonitorService.startCadences: no scheduler injected');
    const pollStop = this.scheduler.every(pollMs, () => this.pollOnce());
    const heartbeatStop = this.scheduler.every(heartbeatMs, () => this.heartbeatOnce());
    this._pollStops.push(pollStop, heartbeatStop);
    return () => {
      pollStop();
      heartbeatStop();
    };
  }

  stop() {
    for (const stop of this._pollStops) {
      try {
        stop();
      } catch {
        // ignore
      }
    }
    this._pollStops = [];
  }

  // ------------------------------------------------------------ read side --

  /** Aggregate status for the active (or given) CLI. */
  async getStatus(filter = {}) {
    const cliId = filter.cliId ?? this.getActiveCli();
    const runs = this.store.listRuns({ cliId, limit: LIMITS.listRunsMax });
    const totals = {};
    for (const run of runs) totals[run.state] = (totals[run.state] ?? 0) + 1;
    return {
      cliId,
      generatedAt: this._nowIso(),
      totals,
      open: runs.filter((r) => r.state === 'discovered' || r.state === 'running' || r.state === 'waiting' || r.state === 'response-ready').length,
      runs: runs.slice(0, filter.runsLimit ?? 20),
    };
  }

  /** List persisted runs, newest first. */
  async listRuns(filter = {}) {
    return this.store.listRuns(filter);
  }

  /** Read events for one run (all persisted events pass through here). */
  async getEvents(filter = {}) {
    if (!filter.runId) throw new TypeError('getEvents: runId is required');
    const cliId = filter.cliId ?? this.getActiveCli();
    return this.store.readEvents(cliId, filter.runId, {
      limit: filter.limit,
      type: filter.type,
      since: filter.since,
    });
  }
}
