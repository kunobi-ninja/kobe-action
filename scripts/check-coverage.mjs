#!/usr/bin/env node
// Enforces per-file coverage floors in CI. Reads
// `coverage-thresholds.json` (lines/branches/functions floors per
// gated file) and `coverage/coverage-summary.json` (vitest output),
// prints a table of actual-vs-floor for every metric, and exits
// non-zero if any metric is below its floor.
//
// Replaces vitest's built-in `coverage.thresholds` block. Living here
// instead of vitest config means:
//   * Coverage failures show up as a discrete CI step in the PR view.
//   * Local `npm run test:coverage` doesn't fail on threshold drift —
//     contributors can iterate without fighting the gate, then run
//     `npm run check-coverage` before pushing.
//   * The threshold config is plain JSON, easy to diff in PRs.
//
// Usage:
//   node scripts/check-coverage.mjs
//     [--thresholds-path <path>] [--summary-path <path>]
//
// Defaults: ./coverage-thresholds.json and ./coverage/coverage-summary.json.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { argv, exit, cwd } from 'node:process';

const METRICS = /** @type {const} */ (['lines', 'branches', 'functions']);

function parseArgs(argvList) {
  const out = {
    thresholdsPath: 'coverage-thresholds.json',
    summaryPath: 'coverage/coverage-summary.json',
  };
  for (let i = 0; i < argvList.length; i++) {
    const a = argvList[i];
    if (a === '--thresholds-path') out.thresholdsPath = argvList[++i];
    else if (a === '--summary-path') out.summaryPath = argvList[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      exit(0);
    } else {
      die(`unknown arg: ${a}`);
    }
  }
  return out;
}

function printHelp() {
  console.log(
    'Usage: node scripts/check-coverage.mjs ' +
      '[--thresholds-path <path>] [--summary-path <path>]',
  );
}

function die(msg) {
  console.error(`check-coverage: ${msg}`);
  exit(2); // 2 = misuse / config error, distinct from 1 = floor violation
}

function readJson(label, path) {
  const abs = isAbsolute(path) ? path : resolve(cwd(), path);
  if (!existsSync(abs)) {
    if (label === 'summary') {
      die(
        `coverage summary not found at ${abs} — run \`npm run test:coverage\` first.`,
      );
    }
    die(`${label} file not found at ${abs}`);
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    die(`failed to parse ${label} JSON at ${abs}: ${err.message}`);
  }
}

// coverage-summary keys are absolute paths on the running machine.
// Match each gated file by suffix (e.g. `src/readiness.ts`) so the
// thresholds config is portable across local and CI checkouts.
function findSummaryEntry(summary, gatedFile) {
  const direct = Object.keys(summary).find(
    (k) => k === gatedFile || k.endsWith(`/${gatedFile}`),
  );
  return direct ? summary[direct] : undefined;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function formatPct(n) {
  return typeof n === 'number' ? n.toFixed(2) : String(n);
}

function main() {
  const args = parseArgs(argv.slice(2));
  const thresholds = readJson('thresholds', args.thresholdsPath);
  const summary = readJson('summary', args.summaryPath);

  if (!thresholds || typeof thresholds !== 'object' || !thresholds.files) {
    die(
      `${args.thresholdsPath} must have a top-level "files" object mapping ` +
        `relative file paths to per-metric floors.`,
    );
  }

  /** @type {Array<{file:string, metric:string, actual:number|string, floor:number, ok:boolean}>} */
  const rows = [];
  let pass = 0;
  let fail = 0;

  for (const [file, floors] of Object.entries(thresholds.files)) {
    const entry = findSummaryEntry(summary, file);
    if (!entry) {
      die(
        `thresholds reference "${file}" but it is missing from the coverage ` +
          `summary — typo in coverage-thresholds.json, or stale entry?`,
      );
    }
    for (const metric of METRICS) {
      if (floors[metric] === undefined) continue; // metric not gated — skip silently
      const floor = Number(floors[metric]);
      const actual = entry[metric]?.pct;
      const ok =
        typeof actual === 'number' && !Number.isNaN(actual) && actual >= floor;
      rows.push({ file, metric, actual: actual ?? 'n/a', floor, ok });
      if (ok) pass += 1;
      else fail += 1;
    }
  }

  // Render table.
  const widths = {
    file: Math.max(4, ...rows.map((r) => r.file.length)),
    metric: Math.max(6, ...rows.map((r) => r.metric.length)),
    actual: Math.max(6, ...rows.map((r) => formatPct(r.actual).length)),
    floor: Math.max(5, ...rows.map((r) => String(r.floor).length)),
  };
  const header =
    pad('FILE', widths.file) +
    '  ' +
    pad('METRIC', widths.metric) +
    '  ' +
    pad('ACTUAL', widths.actual) +
    '  ' +
    pad('FLOOR', widths.floor) +
    '  STATUS';
  const sep = '-'.repeat(header.length);
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    console.log(
      pad(r.file, widths.file) +
        '  ' +
        pad(r.metric, widths.metric) +
        '  ' +
        pad(formatPct(r.actual), widths.actual) +
        '  ' +
        pad(String(r.floor), widths.floor) +
        '  ' +
        (r.ok ? 'ok' : 'FAIL'),
    );
  }

  const total = rows.length;
  if (fail > 0) {
    console.log('');
    console.log(`x ${fail} of ${total} thresholds below floor — see table above.`);
    exit(1);
  }
  console.log('');
  console.log(`OK: all ${total} thresholds met.`);
}

main();
