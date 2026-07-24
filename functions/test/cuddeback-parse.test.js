/* =====================================================================
 * v2-patch-15 parser regression test — cuddeback-parse.js, both species.
 * ---------------------------------------------------------------------
 * Pure Node, no emulator:   node functions/test/cuddeback-parse.test.js
 * (or `npm test` from functions/).
 *
 * Fixtures in samples/ are the ground truth for the two Cuddeback report
 * species (owner-confirmed taxonomy, v2-patch-15 Item 1):
 *  - CUDDELINK NETWORK reports: stacked per-day tables headed
 *    "Date: <d> - Network: <KEY> - Channel: <c>", one row per device.
 *  - TRACKS SOLO reports: one table headed "Camera: <KEY>" of per-day
 *    history rows for a single non-linking device.
 *
 * The Tracks format was broken invisibly from 07/05 (it never parsed;
 * the failure only became visible at 4b3cba4). These assertions exist so
 * no future "hardening" can re-break EITHER species without failing CI.
 * ===================================================================== */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cb = require(path.join(__dirname, '..', 'cuddeback-parse.js'));

const SAMPLES = path.join(__dirname, '..', '..', 'samples');
const read = (f) => fs.readFileSync(path.join(SAMPLES, f), 'utf8');
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/* ---- Tracks solo (samples/tracks-solo-hayden.html) ------------------ */
const tracksHtml = read('tracks-solo-hayden.html');

check('tracks: species/network/reportDate from the Camera: header + newest row', () => {
  const r = cb.parseReportHtml(tracksHtml);
  assert(r, 'parsed');
  assert.strictEqual(r.species, 'tracks');
  assert.strictEqual(r.network, 'HAYDENT');
  assert.strictEqual(r.reportDate, '7/23/2026');   // newest history row's date
  assert.strictEqual(r.devices.length, 1);
});

check('tracks: single device entry carries the newest row\'s health fields', () => {
  const d = cb.parseReportHtml(tracksHtml).devices[0];
  assert.strictEqual(d.cameraNumber, '1');          // stable doc id HAYDENT__1
  assert.strictEqual(d.cameraName, 'HAYDENT');
  assert.strictEqual(d.mode, 'Solo');
  assert.strictEqual(d.battery, 'OK');
  assert.strictEqual(d.batteryDays, '140');
  assert.strictEqual(d.sdPhotos, '928');
  assert.strictEqual(d.sdFreeSpace, '28 GB');
  assert.strictEqual(d.sdFreeGB, 28);               // SD floor evaluable (Item 3)
  assert.strictEqual(d.photoQueue, null);           // no link queue on a solo unit
  assert.strictEqual(d.fwVersion, '3.4.0');
  assert.deepStrictEqual(cb.deviceDeficiencies(d), []);
});

check('tracks: newest row selected by date, not position (reversed rows)', () => {
  const rows = tracksHtml.match(/<tr class="cl-entry">[\s\S]*?<\/tr>/gi);
  let i = rows.length - 1;
  const reversed = tracksHtml.replace(/<tr class="cl-entry">[\s\S]*?<\/tr>/gi, () => rows[i--]);
  const r = cb.parseReportHtml(reversed);
  assert.strictEqual(r.reportDate, '7/23/2026');
  assert.strictEqual(r.devices[0].batteryDays, '140');
});

check('tracks: SD floor red-flags a nearly-full card (Item 3 rule)', () => {
  const low = tracksHtml.replace(/<td>28 GB<\/td>/, '<td>3 GB</td>');
  const d = cb.parseReportHtml(low).devices[0];
  assert.strictEqual(d.sdFreeGB, 3);
  assert.deepStrictEqual(cb.deviceDeficiencies(d), ['sd']);
});

check('tracks: unparseable free-space text leaves sdFreeGB null (caller warns — never silent)', () => {
  const bad = tracksHtml.replace(/<td>28 GB<\/td>/, '<td>??</td>');
  assert.strictEqual(cb.parseReportHtml(bad).devices[0].sdFreeGB, null);
});

check('tracks: row fallback survives a firmware that drops the cl-entry class', () => {
  const noClass = tracksHtml.replace(/<tr class="cl-entry">/gi, '<tr>');
  const r = cb.parseReportHtml(noClass);
  assert.strictEqual(r.reportDate, '7/23/2026');
  assert.strictEqual(r.devices.length, 1);
});

/* ---- CuddeLink single device (samples/cuddelink-single-pulliamr2.html) */
const singleHtml = read('cuddelink-single-pulliamr2.html');

check('cuddelink single: one home device from the newest table', () => {
  const r = cb.parseReportHtml(singleHtml);
  assert.strictEqual(r.species, 'cuddelink');
  assert.strictEqual(r.network, 'PULLIAMR2');
  assert.strictEqual(r.reportDate, '7/23/2026');
  assert.strictEqual(r.devices.length, 1);
  const d = r.devices[0];
  assert.strictEqual(d.cameraNumber, '001');
  assert.strictEqual(d.cameraName, 'PULLIAMR2');
  assert.strictEqual(d.mode, 'Home');
  assert.strictEqual(d.battery, 'Ext OK');
  assert.strictEqual(d.batteryDays, '5');
  assert.strictEqual(d.photoQueue, 0);
  assert.strictEqual(d.sdPhotos, '841');
  assert.strictEqual(d.sdFreeGB, 14);
  assert.strictEqual(d.clVersion, '3.1.0 / 5.5.15');
  assert.deepStrictEqual(cb.deviceDeficiencies(d), []);
});

check('cuddelink: table-attribute hardening survives (<table border="1">)', () => {
  const attrs = singleHtml.replace(/<table>/gi, '<table border="1" cellpadding="2">');
  const r = cb.parseReportHtml(attrs);
  assert.strictEqual(r.network, 'PULLIAMR2');
  assert.strictEqual(r.devices.length, 1);
});

check('cuddelink: row fallback survives a firmware that drops the cl-entry class', () => {
  const noClass = singleHtml.replace(/<tr class="cl-entry">/gi, '<tr>');
  const r = cb.parseReportHtml(noClass);
  assert.strictEqual(r.devices.length, 1);
});

/* ---- CuddeLink multi device (samples/cuddelink-multi-tackettf.html) -- */
const multiHtml = read('cuddelink-multi-tackettf.html');

check('cuddelink multi: home + linked device, NEWEST stacked table (7/24 of 7/12..7/24)', () => {
  const r = cb.parseReportHtml(multiHtml);
  assert.strictEqual(r.species, 'cuddelink');
  assert.strictEqual(r.network, 'TACKETTF');
  assert.strictEqual(r.reportDate, '7/24/2026');
  assert.deepStrictEqual(
    r.devices.map((d) => [d.cameraNumber, d.cameraName, d.mode]),
    [['001', 'TACKETTF', 'Home'], ['011', 'CAMERA 11', 'Camera']]
  );
  assert.strictEqual(r.devices[0].batteryDays, '48');   // 7/24 values, not an older day's
  assert.strictEqual(r.devices[0].sdPhotos, '799');
  assert.strictEqual(r.devices[1].sdFreeGB, 13);
});

check('cuddelink multi: newest table selected by date, not position (reversed stack)', () => {
  const tbls = multiHtml.match(/<table[\s\S]*?<\/table>/gi);
  const r = cb.parseReportHtml(tbls.slice().reverse().join('<br>'));
  assert.strictEqual(r.reportDate, '7/24/2026');
  assert.strictEqual(r.devices.length, 2);
  assert.strictEqual(r.devices[0].sdPhotos, '799');
});

/* ---- Neither species ------------------------------------------------- */
check('unrecognized HTML (no Network:/Camera: header) returns null for manual review', () => {
  assert.strictEqual(cb.parseReportHtml('<table><tr><td>hello</td></tr></table>'), null);
  assert.strictEqual(cb.parseReportHtml('no tables at all'), null);
  assert.strictEqual(cb.parseReportHtml(''), null);
});

console.log(`\ncuddeback-parse.test.js: all ${passed} checks passed`);
