// src/scheduling/interval-scheduler.mjs — timer-backed Scheduler port.
//
// A setTimeout chain (not setInterval) so a slow poll tick never overlaps
// itself: the next tick is scheduled only after the previous callback
// settles. In the DSH host the timers are unref'd so they never keep the
// process alive on their own; the CLI watch keeps them ref'd.

/** Production clock: wall-clock milliseconds. */
export const systemClock = Object.freeze({ now: () => Date.now() });

export class IntervalScheduler {
  /** @param {{unref?: boolean}} [opts] */
  constructor(opts = {}) {
    this.unref = opts.unref === true;
    this._timers = new Set();
  }

  /**
   * Invoke `fn` every `ms`. Returns a stop function.
   * @param {number} ms - interval in milliseconds (must be a positive integer).
   * @param {() => (void|Promise<void>)} fn - tick body; async bodies are awaited.
   */
  every(ms, fn) {
    if (!Number.isInteger(ms) || ms <= 0) throw new TypeError(`IntervalScheduler: ms must be a positive integer, got ${ms}`);
    let stopped = false;
    let timer = null;
    const scheduleNext = () => {
      if (stopped) return;
      timer = setTimeout(onTick, ms);
      if (this.unref && typeof timer.unref === 'function') timer.unref();
      this._timers.add(timer);
    };
    const onTick = () => {
      if (stopped) return;
      this._timers.delete(timer);
      try {
        const result = fn();
        if (result && typeof result.then === 'function') {
          result.then(scheduleNext, scheduleNext);
        } else {
          scheduleNext();
        }
      } catch {
        scheduleNext(); // a throwing tick must not stop the cadence
      }
    };
    scheduleNext();
    this._timers.add(timer);
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        this._timers.delete(timer);
      }
    };
  }

  stopAll() {
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
  }
}

/**
 * Deterministic scheduler for tests: same port, but `fire(intervalMs)` runs
 * every callback registered for that interval exactly once, synchronously.
 */
export class ManualScheduler {
  constructor() {
    this._callbacks = new Map();
    this.stops = [];
  }

  every(ms, fn) {
    const list = this._callbacks.get(ms) ?? [];
    list.push(fn);
    this._callbacks.set(ms, list);
    const stop = () => {
      this._callbacks.set(ms, (this._callbacks.get(ms) ?? []).filter((f) => f !== fn));
    };
    this.stops.push(stop);
    return stop;
  }

  /** Fire all callbacks registered for `ms` (awaiting async bodies). */
  async fire(ms) {
    const list = [...(this._callbacks.get(ms) ?? [])];
    for (const fn of list) await fn();
  }

  stopAll() {
    for (const stop of this.stops) stop();
    this._callbacks.clear();
  }
}
