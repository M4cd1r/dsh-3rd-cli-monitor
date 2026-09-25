// src/domain/redact.mjs — bounding and sanitizing helpers.
//
// Everything the monitor persists passes through these bounds. The rule is
// whitelist-by-construction: parsers copy specific fields only, and these
// helpers cap every free-form string that does get through. Prompt text,
// reasoning content, raw tool output, credentials, and whole log lines are
// never persisted, so they can never leak through storage or the remote.

export const LIMITS = Object.freeze({
  diagnosticChars: 200,
  diagnosticsPerSnapshot: 10,
  partialStateChars: 500,
  modelsUsed: 8,
  sessionsPerScan: 5,
  filesPerScan: 10,
  listRunsDefault: 50,
  listRunsMax: 200,
  eventsDefault: 100,
  eventsMax: 500,
  eventFileMaxBytes: 256 * 1024,
});

/** Coerce to a bounded single-line string; non-strings become ''. */
export function boundString(value, maxChars) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\r\n\t]+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, Math.max(0, maxChars - 1))}…` : flat;
}

/** Keep at most `max` bounded strings, dropping empties. */
export function boundStringList(values, max, maxChars = LIMITS.diagnosticChars) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    if (out.length >= max) break;
    const bounded = boundString(value, maxChars);
    if (bounded) out.push(bounded);
  }
  return out;
}

/**
 * Last-resort scrub for fields that must never be persisted even if a future
 * parser accidentally copies a whole object: any key in this list is dropped.
 * Values already copied by whitelist parsers are unaffected; this protects
 * against wholesale object spread regressions.
 */
const FORBIDDEN_KEYS = new Set([
  'prompt', 'prompts', 'promptfile', 'brief', 'message', 'messages', 'content',
  'reasoning', 'thinking', 'text', 'toolcalls', 'tooloutputs', 'tools',
  'apikey', 'api_key', 'authorization', 'token', 'secret', 'password', 'cookie',
  'response', 'stdout', 'stderr', 'loglines', 'rawlog',
]);

/**
 * Return a shallow copy of `obj` without forbidden keys (case-insensitive,
 * one nesting level). Used defensively wherever a foreign object is about to
 * be embedded into a snapshot or event.
 */
export function stripForbidden(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? stripForbidden(value)
      : value;
  }
  return out;
}
