#!/usr/bin/env node
// bin/dsh-3rd-cli-monitor.mjs — standalone read-only monitor CLI.
//
// Uses the exact same application/domain code and state root as the DSH host
// plugin (src/compose.mjs). Commands: status, runs, events, watch, use.
// This CLI never spawns a third-party coding CLI, never sends a model
// request, and never writes anywhere except the monitor's own state root
// (default $DSH_HOME/third-cli-monitor).

import { resolveMonitorConfig } from '../src/config.mjs';
import { assemble } from '../src/compose.mjs';
import { formatRunLine } from '../src/application/queries.mjs';
import { IntervalScheduler } from '../src/scheduling/interval-scheduler.mjs';

const USAGE = `dsh-3rd-cli-monitor — read-only monitor for third-party coding CLI runs

Usage:
  dsh-3rd-cli-monitor status  [--cli <id>] [--json]
  dsh-3rd-cli-monitor runs    [--cli <id>] [--state <state>] [--limit <n>] [--json]
  dsh-3rd-cli-monitor events  --run <runId> [--cli <id>] [--type <type>] [--limit <n>] [--json]
  dsh-3rd-cli-monitor watch   [--interval <ms>] [--once] [--json]
  dsh-3rd-cli-monitor use     <cliId>

Global flags:
  --state-root <dir>   override the state root (default: $DSH_HOME/third-cli-monitor)
  --json               machine-readable output
  --version, --help

Commands never start, cancel, or restart a monitored CLI; they only read its
log/report artifacts and the monitor's own state.`;

const EXIT = { OK: 0, ERROR: 1, USAGE: 2 };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--state-root') out.stateRoot = argv[++i];
    else if (arg === '--cli') out.cli = argv[++i];
    else if (arg === '--state') out.state = argv[++i];
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg === '--type') out.type = argv[++i];
    else if (arg === '--run') out.run = argv[++i];
    else if (arg === '--interval') out.interval = Number(argv[++i]);
    else if (arg === '--once') out.once = true;
    else if (arg === '--version') out.version = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--')) throw new RangeError(`unknown flag: ${arg}`);
    else out._.push(arg);
  }
  return out;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function shortTime(iso) {
  return typeof iso === 'string' ? iso.slice(11, 19) + 'Z' : '?';
}

function commandFor(args) {
  const [command] = args._;
  if (args.help || args.version) return 'help';
  return command ?? 'status';
}

async function cmdStatus(monitor, args) {
  const status = await monitor.service.getStatus({
    cliId: args.cli,
    runsLimit: args.json ? 20 : 10,
  });
  if (args.json) return printJson(status);
  const totals = Object.entries(status.totals).map(([state, n]) => `${n} ${state}`).join(', ');
  console.log(`${status.cliId} — ${status.runs.length} run(s) on record${totals ? `: ${totals}` : ' (none yet)'}`);
  for (const run of status.runs) {
    console.log(`  ${formatRunLine(run)}  started ${shortTime(run.startedAt)}`);
  }
}

async function cmdRuns(monitor, args) {
  const runs = await monitor.service.listRuns({
    cliId: args.cli,
    state: args.state,
    limit: args.limit,
  });
  if (args.json) return printJson(runs);
  if (runs.length === 0) console.log('no runs on record');
  for (const run of runs) {
    console.log(`  ${formatRunLine(run)}  started ${shortTime(run.startedAt)}`);
    for (const diag of run.diagnostics ?? []) console.log(`      · ${diag}`);
  }
}

async function cmdEvents(monitor, args) {
  if (!args.run) throw new RangeError('events: --run <runId> is required');
  const events = await monitor.service.getEvents({
    cliId: args.cli,
    runId: args.run,
    type: args.type,
    limit: args.limit,
  });
  if (args.json) return printJson(events);
  if (events.length === 0) console.log('no events recorded for this run');
  for (const event of events) {
    const transition = event.fromState
      ? `${event.fromState} -> ${event.toState}`
      : `-> ${event.toState}`;
    console.log(`  ${event.at}  ${event.type.padEnd(18)} ${transition}`);
  }
}

async function cmdWatch(monitor, args, config) {
  const interval = Number.isInteger(args.interval) && args.interval > 0 ? args.interval : config.pollMs;
  const lastStates = new Map();
  const reportTransitions = async () => {
    await monitor.service.pollOnce();
    const runs = monitor.store.listRuns({ cliId: monitor.activeCli.get(), limit: 200 });
    for (const run of runs) {
      const prev = lastStates.get(run.runId);
      lastStates.set(run.runId, run.state);
      if (prev === run.state) continue;
      if (args.json) printJson(run);
      else console.log(`${new Date().toISOString()}  ${run.runId}: ${prev ?? 'new'} -> ${run.state}`);
    }
  };
  if (args.once) {
    await reportTransitions();
    return;
  }
  const scheduler = new IntervalScheduler({ unref: false });
  const stopScheduler = scheduler.every(interval, () => reportTransitions());
  console.error(`watching ${monitor.activeCli.get()} every ${interval} ms — Ctrl-C to stop`);
  const stopWatching = () => {
    stopScheduler();
    process.exit(EXIT.OK);
  };
  process.on('SIGINT', stopWatching);
  process.on('SIGTERM', stopWatching);
  // Watch runs until interrupted: keep the turn alive without busy-waiting.
  await new Promise(() => {});
}

async function cmdUse(monitor, args) {
  const cliId = args._[1];
  if (!cliId) throw new RangeError('use: a CLI id is required (registered: ' + monitor.registry.ids().join(', ') + ')');
  const active = monitor.activeCli.set(cliId);
  if (args.json) return printJson({ activeCli: active });
  console.log(`active CLI: ${active}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = commandFor(args);
  if (command === 'help') {
    console.log(USAGE);
    if (args.version) console.log('version: 0.1.0');
    return EXIT.OK;
  }
  const config = resolveMonitorConfig({ overrides: { stateRoot: args.stateRoot, pollMs: args.interval } });
  const monitor = assemble(config);
  switch (command) {
    case 'status':
      await cmdStatus(monitor, args);
      break;
    case 'runs':
      await cmdRuns(monitor, args);
      break;
    case 'events':
      await cmdEvents(monitor, args);
      break;
    case 'watch':
      await cmdWatch(monitor, args, config);
      break;
    case 'use':
      await cmdUse(monitor, args);
      break;
    default:
      console.error(`unknown command: ${command}`);
      console.error(USAGE);
      return EXIT.USAGE;
  }
  return EXIT.OK;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const message = String(err?.message ?? err);
    if (err instanceof RangeError || message.startsWith('unknown flag') || message.includes('is required')) {
      console.error(`error: ${message}`);
      console.error(USAGE);
      process.exit(EXIT.USAGE);
    }
    console.error(`error: ${message}`);
    process.exit(EXIT.ERROR);
  });
