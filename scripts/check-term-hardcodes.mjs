#!/usr/bin/env node
// check-term-hardcodes.mjs
//
// Walk-away-ready guard. Greps the codebase for known CR election
// term-boundary numeric literals that should NEVER appear hardcoded
// outside of the canonical constants files. If a developer copy-
// pastes "term 6 voting starts at 1941250" into a new feature, this
// script catches it before T7/T8/T9 ship and the feature breaks.
//
// Usage: `npm run check:term-hardcodes`
//
// Allow-list: the constants files that ARE allowed to contain these
// numbers because they're the canonical source. Everything else is
// expected to derive boundaries via the formula.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Canonical CR config values — only these files may contain them.
const FORBIDDEN_LITERALS = [
  // CRFirstTermStart — the genesis block of T1
  '658930', '658_930',
  // CRTermLength — duration of one term
  '262800', '262_800',
  // CRVotingPeriod — duration of voting window
  '21600', '21_600',
  // CRClaimPeriod — duration of claim window
  '10080', '10_080',
  // T1-T6 specific termStart heights — should NEVER be hardcoded
  '921730', '921_730',     // T2
  '1184530', '1_184_530',  // T3
  '1447330', '1_447_330',  // T4
  '1710130', '1_710_130',  // T5
  '1972930', '1_972_930',  // T6
  // T1-T6 specific narrowEnd heights
  '648849',                // T1
  '911649',                // T2
  '1174449',               // T3
  '1437249',               // T4
  '1700049',               // T5
  '1962849',               // T6
];

// Files that ARE allowed to contain these literals. They are the
// canonical source of truth — every other consumer derives via
// formula or imports from here.
const ALLOW_LIST = [
  // Backend canonical constants
  /ela-explorer\/internal\/aggregator\/aggregator\.go$/,
  /ela-explorer\/internal\/aggregator\/vote_replay\.go$/,
  /ela-explorer\/internal\/api\/governance\.go$/,
  /ela-explorer\/internal\/db\/schema\.go$/,
  // Backend tx-type constants — `HeightCRCommitteeStart = 658930` is
  // an Elastos consensus identifier, not a derivable boundary.
  /ela-explorer\/internal\/sync\/tx_types\.go$/,
  // Frontend canonical constants
  /src\/constants\/governance\.ts$/,
  // The simulator file derives via formula but the canonical
  // CR_* constants live at the top.
  /src\/pages\/DevElectionReplay\.tsx$/,
  // API docs — sample response values literally are these heights;
  // the docs aren't computing anything.
  /src\/data\/api-docs\.ts$/,
  // Legacy archive — kept for reference only, not part of production.
  /ela-rpc-server-archive\//,
  /ela-indexer\//,
  /elastos-node-monitor\//,
  // This script itself
  /scripts\/check-term-hardcodes\.mjs$/,
  // Generated / vendored
  /dist\//,
  /build\//,
  /node_modules\//,
  // Docs / plans
  /\.md$/,
  /CLAUDE\.md$/,
  /\.claude\//,
  // SQL fixtures
  /\.sql$/,
];

// File extensions to scan
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.go'];

function isAllowed(relativePath) {
  return ALLOW_LIST.some((re) => re.test(relativePath));
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name === '.git') continue;
      yield* walk(full);
    } else if (SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      yield full;
    }
  }
}

const violations = [];

for (const file of walk(root)) {
  const rel = path.relative(root, file);
  if (isAllowed(rel)) continue;
  const content = fs.readFileSync(file, 'utf8');
  for (const literal of FORBIDDEN_LITERALS) {
    if (content.includes(literal)) {
      // Find the line number for nicer error messages
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (line.includes(literal)) {
          violations.push({ file: rel, line: i + 1, literal, snippet: line.trim() });
        }
      });
    }
  }
}

if (violations.length === 0) {
  console.log('✓ No hardcoded term boundaries found outside canonical files.');
  process.exit(0);
}

console.error('✗ Term-boundary hardcodes detected — these must be replaced with formula-driven derivation:');
console.error('');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    found: ${v.literal}`);
  console.error(`    line:  ${v.snippet.length > 100 ? v.snippet.slice(0, 100) + '…' : v.snippet}`);
  console.error('');
}
console.error(`Total: ${violations.length} violation${violations.length === 1 ? '' : 's'}.`);
console.error('');
console.error('Fix: import from src/constants/governance.ts (frontend) or use the');
console.error('canonical constants in aggregator.go / governance.go (backend). All');
console.error('term boundaries should derive via formula:');
console.error('  termStart = CRFirstTermStart + (term - 1) * CRTermLength');
console.error('  votingEnd = termStart - 1 - CRClaimPeriod');
console.error('  votingStart = votingEnd - CRVotingPeriod + 1');
process.exit(1);
