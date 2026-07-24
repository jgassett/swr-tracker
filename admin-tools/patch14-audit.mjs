#!/usr/bin/env node
/*
 * patch14-audit.mjs — v2-patch-14 functional audit (static, no network).
 *  A. index.html main <script type="module"> parses as valid JS.
 *  B. Every status-pill class emitted by JS has a CSS rule, and no pill
 *     rule carries a raw hex (all on --status-* tokens).
 *  C. Both persisted terminal strings ('Complete' / 'Completed') map to
 *     the SAME pill class in both mappers and render the SAME label.
 *  D. EST_STATUSES matches the estStatusClass mapping and the CSS classes.
 *  E. Unread amber in both places: .notif-row.unread and .bell-badge both
 *     use var(--amber); nothing colors the bell badge danger.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✖ FAIL'} ${msg}`); if (!cond) failures++; };

/* A — syntax */
const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(scripts.length >= 1, `found ${scripts.length} module script block(s)`);
const dir = mkdtempSync(join(tmpdir(), 'p14-'));
scripts.forEach((s, i) => {
  const f = join(dir, `s${i}.mjs`);
  writeFileSync(f, s);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok(true, `script block ${i} parses (node --check)`); }
  catch (e) { ok(false, `script block ${i} SYNTAX ERROR: ${String(e.stderr).slice(0, 300)}`); }
});

/* B — emitted pill classes all defined; pill rules token-only */
function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
}
const definedPills = new Set([...html.matchAll(/\.status-pill\.([a-z]+)\s*\{/g)].map((m) => m[1]));
const mapperReturns = ['estStatusClass', 'jobStatusClass', 'jobLifeStatusClass']
  .flatMap((fn) => [...extractFn(fn).matchAll(/return '([a-z]+)'/g)].map((m) => m[1]));
for (const cls of new Set(mapperReturns)) ok(definedPills.has(cls), `pill class ".${cls}" (mapper output) has a CSS rule`);
const pillRules = [...html.matchAll(/\.status-pill\.[a-z]+\s*\{([^}]*)\}/g)].map((m) => m[1]);
const rawHexRules = pillRules.filter((r) => /#(?!fff\b)[0-9a-fA-F]{3,6}/.test(r));
ok(rawHexRules.length === 0, `no status-pill rule carries a raw hex (${pillRules.length} rules on tokens; #fff allowed for the Active ring ground)`);

/* C — dual terminal strings, one pill + one label */
const G = globalThis;
const estConst = html.match(/const EST_STATUSES = \{[\s\S]*?\};/)[0];
const api = new Function(`${estConst}\n${['statusLabel', 'jobStatusClass', 'jobLifeStatusClass', 'estStatusClass'].map(extractFn).join('\n')};
  return { statusLabel, jobStatusClass, jobLifeStatusClass, estStatusClass };`)();
ok(api.jobStatusClass('Completed') === 'completed' && api.jobStatusClass('Complete') === 'completed', 'jobStatusClass: both spellings → completed');
ok(api.jobLifeStatusClass('Complete') === 'completed' && api.jobLifeStatusClass('Completed') === 'completed', 'jobLifeStatusClass: both spellings → completed');
ok(api.statusLabel('Completed') === 'Complete' && api.statusLabel('Complete') === 'Complete', 'statusLabel renders both as "Complete"');
ok(api.statusLabel('Cancelled') === 'Cancelled' && api.statusLabel('Open') === 'Open', 'statusLabel passes other statuses through');

/* D — EST_STATUSES ↔ mapper ↔ CSS */
const estBlock = html.match(/const EST_STATUSES = \{[\s\S]*?\};/);
ok(!!estBlock, 'EST_STATUSES constant present');
ok(/'Pushed to QB'/.test(estBlock[0]), "EST_STATUSES carries the verified server string 'Pushed to QB'");
ok(api.estStatusClass('Pushed to QB') === 'pushed' && api.estStatusClass('Pending Approval') === 'pending'
  && api.estStatusClass('Invoiced') === 'invoiced' && api.estStatusClass('Rejected') === 'rejected'
  && api.estStatusClass('Draft') === 'draft' && api.estStatusClass('anything else') === 'draft',
  'estStatusClass maps every EST_STATUSES value (unknown → draft)');

/* E — unread amber in both places */
const bell = html.match(/^\s*\.bell-badge \{[\s\S]*?\n\s*\}/m)[0];
ok(/background:\s*var\(--amber\)/.test(bell) && !/var\(--danger\)/.test(bell), 'bell-badge is amber (not danger)');
const unread = html.match(/\.notif-row\.unread\s*\{[^}]*\}/)[0];
ok(/var\(--amber\)/.test(unread), 'notif-row.unread keeps the amber border');
const bullet = html.match(/\.notif-row\.unread \.nf-title::before\s*\{[^}]*\}/)[0];
ok(/var\(--amber\)/.test(bullet), 'unread bullet keeps amber');

console.log(failures ? `\n✖ ${failures} audit check(s) FAILED\n` : '\npatch14-audit: ALL checks passed\n');
process.exit(failures ? 1 : 0);
