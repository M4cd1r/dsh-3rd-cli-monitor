// src/application/queries.mjs — small read models shared by the CLI and the
// remote surface. Pure functions over normalized snapshots/events.

/** Human-ish one-line summary of a run snapshot. */
export function formatRunLine(snapshot) {
  const bits = [
    snapshot.runId,
    `[${snapshot.state}]`,
    snapshot.responsePresent ? 'response=yes' : 'response=no',
  ];
  if (snapshot.durationMs != null) bits.push(`${Math.round(snapshot.durationMs / 1000)}s`);
  if (snapshot.model) bits.push(`model=${snapshot.model}`);
  if (snapshot.errorKind) bits.push(`error=${snapshot.errorKind}`);
  if (snapshot.counts?.modelRequests) bits.push(`requests=${snapshot.counts.modelRequests}`);
  return bits.join(' ');
}

/** The `totals` object for a list of snapshots, keyed by state. */
export function totalsByState(snapshots) {
  const totals = {};
  for (const snapshot of snapshots) totals[snapshot.state] = (totals[snapshot.state] ?? 0) + 1;
  return totals;
}
