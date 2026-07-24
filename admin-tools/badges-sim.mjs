#!/usr/bin/env node
/*
 * badges-sim.mjs — v2-patch-14 Item 5 verification. Extracts the SHIPPED
 * flowStepBadges/todayNY (+ the fieldGroups chain they depend on) from
 * index.html and asserts the badge counts against synthetic data:
 *   Jobs:      < 30 days green; EXACTLY 30 days red (boundary); no-date
 *              green; non-Active ignored; legacy (no jobNumber) ignored.
 *   Schedule:  open today/future green; overdue red; undated-open green;
 *              Completed/Cancelled ignored; legacy appointments included.
 *   Monitoring: matched healthy green; 1-deficiency (yellow) red; stale
 *              red; silent installed (no report) red; unmatched red;
 *              internal healthy green (never unmatched); internal stale red.
 *   Zero-hide: empty caches → all counts 0.
 * No network, no Firebase — pure logic against the real shipped code.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const shipped = ['normCamKey', 'resolveCustomerForKey', 'worstOf', 'deviceIsCurrent',
  'deviceDefsLive', 'deviceStatusLive', 'fieldGroups', 'isLifecycleJob', 'lifecycleJobs',
  'todayNY', 'flowStepBadges'].map(extractFn).join('\n');

const G = globalThis;
G.STATUS_RANK = { red: 0, yellow: 1, green: 2, none: 3 };
G.currentUser = { email: 'jon@southern-wildlife.com' };
G.cachedJobs = []; G.cachedTasks = []; G.cachedAppointments = [];
G.cachedCustomers = []; G.cachedProperties = [];
G.cachedCameraHealth = []; G.cachedCameraPhotos = []; G.cachedCameraStatus = [];
const api = new Function(`${shipped}; return { flowStepBadges, todayNY };`)();

let failures = 0;
const eq = (got, want, msg) => {
  const pass = got === want;
  console.log(`${pass ? '  ✓' : '  ✖ FAIL'} ${msg} (got ${got}, want ${want})`);
  if (!pass) failures++;
};

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const localMDY = () => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
const nyPlus = (days) => {
  const [y, m, d] = api.todayNY().split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

/* --- zero-hide: everything empty --- */
console.log('\n--- zero data ---');
let b = api.flowStepBadges();
eq(b[2].green + b[2].red + b[3].green + b[3].red + b[4].green + b[4].red, 0, 'all counts zero when caches empty');

/* --- Jobs tile --- */
console.log('\n--- Jobs (step 2) ---');
G.cachedJobs = [
  { id: 'a', jobNumber: 'J1', status: 'Active', startDate: iso(29 * DAY) },          // 29d → green
  { id: 'b', jobNumber: 'J2', status: 'Active', startDate: iso(30 * DAY) },          // EXACTLY 30d → red
  { id: 'c', jobNumber: 'J3', status: 'Active', startDate: iso(45 * DAY) },          // 45d → red
  { id: 'd', jobNumber: 'J4', status: 'Active' },                                    // no dates → green
  { id: 'e', jobNumber: 'J5', status: 'Complete', startDate: iso(60 * DAY) },        // closed → ignored
  { id: 'f', jobNumber: 'J6', status: 'Pending Close', startDate: iso(60 * DAY) },   // not Active → ignored
  { id: 'g', status: 'Active', date: '2025-01-01' },                                 // legacy, no jobNumber → ignored
  { id: 'h', jobNumber: 'J7', status: 'Active', createdAt: iso(31 * DAY) },          // createdAt fallback → red
];
b = api.flowStepBadges();
eq(b[2].green, 2, 'Jobs green: 29d + no-date');
eq(b[2].red, 3, 'Jobs red: exactly-30d + 45d + createdAt-31d');

/* --- Schedule tile --- */
console.log('\n--- Schedule (step 3) ---');
G.cachedTasks = [
  { id: 't1', status: 'Open', scheduledDate: api.todayNY() },   // today → green
  { id: 't2', status: 'Open', scheduledDate: nyPlus(3) },       // future → green
  { id: 't3', status: 'Open', scheduledDate: nyPlus(-1) },      // yesterday → red
  { id: 't4', status: 'Completed', scheduledDate: nyPlus(-5) }, // done → ignored
  { id: 't5', status: 'Cancelled', scheduledDate: nyPlus(-5) }, // cancelled → ignored
  { id: 't6', status: 'Open' },                                 // undated open → green
  { id: 't7', scheduledDate: nyPlus(-2) },                      // no status = Open, overdue → red
];
G.cachedAppointments = [
  { id: 'a1', status: 'Scheduled', scheduledDate: nyPlus(-3) }, // legacy appt overdue → red
  { id: 'a2', status: 'Scheduled', scheduledDate: nyPlus(2) },  // legacy appt future → green
  { id: 'a3', status: 'Completed', scheduledDate: nyPlus(-3) }, // done → ignored
];
b = api.flowStepBadges();
eq(b[3].green, 4, 'Schedule green: today + future + undated + future appt');
eq(b[3].red, 3, 'Schedule red: yesterday + default-status overdue + overdue appt');

/* --- Monitoring tile --- */
console.log('\n--- Monitoring (step 4) ---');
G.cachedCustomers = [{ id: 'c1', name: 'Cust One' }, { id: 'c2', name: 'Cust Two' },
  { id: 'c3', name: 'Cust Three' }, { id: 'c4', name: 'Cust Four' }];
G.cachedProperties = [
  { id: 'p1', customerId: 'c1', cameraId: 'HEALTHY1' },
  { id: 'p2', customerId: 'c2', cameraId: 'YELLOW1' },
  { id: 'p3', customerId: 'c3', cameraId: 'STALE1' },
  { id: 'p4', customerId: 'c4', cameraId: 'SILENT1' },   // installed, never reported
];
G.cachedCameraHealth = [
  { id: 'HEALTHY1__001', customerKey: 'HEALTHY1', reportDate: localMDY(), battery: 'OK', sdFreeGB: 20, photoQueue: 0 },
  { id: 'YELLOW1__001', customerKey: 'YELLOW1', reportDate: localMDY(), battery: 'Low', sdFreeGB: 20, photoQueue: 0 },  // 1 deficiency → yellow → red badge
  { id: 'STALE1__001', customerKey: 'STALE1', reportDate: '1/1/2020', battery: 'OK', sdFreeGB: 20, photoQueue: 0 },     // no current report → red
  { id: 'INTG__001', customerKey: 'INTG', internal: true, reportDate: localMDY(), battery: 'OK', sdFreeGB: 20, photoQueue: 0 },  // internal healthy → green
  { id: 'INTB__001', customerKey: 'INTB', internal: true, reportDate: '1/1/2020', battery: 'OK', sdFreeGB: 20, photoQueue: 0 },  // internal stale → red
  { id: 'STRAY1__pending', customerKey: 'STRAY1', pending: true, status: 'red' },   // unmatched pending queue → red
];
b = api.flowStepBadges();
eq(b[4].green, 2, 'Monitoring green: healthy matched + healthy internal');
eq(b[4].red, 5, 'Monitoring red: yellow + stale + silent-installed + unmatched + internal-stale (internal never unmatched)');

console.log(failures ? `\n✖ ${failures} assertion(s) FAILED\n` : '\nbadges-sim: ALL assertions passed\n');
process.exit(failures ? 1 : 0);
