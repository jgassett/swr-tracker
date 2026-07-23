/* =====================================================================
 * v2-patch-12: camera-health pipeline write cores — SERVER-SIDE.
 * ---------------------------------------------------------------------
 * Every ingest-pipeline write to cameraHealth lives here, behind one
 * invariant (Item 1): pipeline writes are MERGE-ONLY and never touch an
 * operator-set field — `internal` (marked from the Monitoring pending
 * queue) and the watchdog removal flags must survive every ingest.
 *
 * Sticky internal flag: the operator's mark lands on the docs that exist
 * at flag time, but a later report can renumber devices or add rows,
 * creating sibling docs the mark never touched. The upsert therefore
 * propagates internal=true from any existing doc on the same camera key
 * to every row it writes. It only ever propagates `true` — clearing the
 * flag is the operator's alone (the app writes internal=false on unmark).
 *
 * Kept separate from index.js so the emulator regression test can require
 * this module and exercise the EXACT shipped logic (same pattern as
 * admin-migrations.js). Every core takes the Firestore instance as an
 * argument for the same reason.
 * ===================================================================== */

'use strict';

const cb = require('./cuddeback-parse');
const { normKey } = require('./admin-migrations');

/* Fields the ingest pipeline must NEVER write: `internal` is operator-set
 * (Monitoring pending queue), the removal flags belong to the watchdog +
 * admin confirm, lastNotifiedAt to the alert dedup transaction. Stripping
 * is a regression guard — payloads built below don't include these, but a
 * future edit that adds one must not silently clobber an operator's flag. */
const OPERATOR_FIELDS = [
  'internal',
  'pendingRemoval', 'pendingRemovalAt',
  'removalConfirmed', 'removalConfirmedAt', 'removalConfirmedBy',
  'lastNotifiedAt'
];

function stripOperatorFields(payload) {
  const clean = { ...payload };
  for (const f of OPERATOR_FIELDS) delete clean[f];
  return clean;
}

/* True when any existing health row on this camera key carries the
 * operator's internal mark. */
async function keyMarkedInternal(db, key) {
  const snap = await db.collection('cameraHealth').where('customerKey', '==', key).get();
  return snap.docs.some((d) => d.get('internal') === true);
}

/* Daily status report → one merged health row per device. */
async function upsertReportHealthCore(db, { parsed, match, today, nowIso }) {
  const internal = await keyMarkedInternal(db, parsed.network);
  const batch = db.batch();
  for (const d of parsed.devices) {
    const status = cb.deviceStatus(d, parsed.reportDate, today);
    const payload = stripOperatorFields({
      customerKey: parsed.network,
      customerId: match ? match.id : null,
      customerName: match ? match.name : null,
      propertyId: (match && match.propertyId) || null,
      cameraNumber: d.cameraNumber,
      cameraName: d.cameraName,
      mode: d.mode,
      reportDate: parsed.reportDate,
      battery: d.battery,
      batteryOk: !/low/i.test(d.battery || ''),
      sdFreeSpace: d.sdFreeSpace,
      sdFreeGB: d.sdFreeGB,
      photoQueue: d.photoQueue,
      fwVersion: d.fwVersion,
      clVersion: d.clVersion,
      deficiencies: cb.deviceDeficiencies(d),
      status,
      dateCurrent: parsed.reportDate === today,
      updatedAt: nowIso
    });
    if (internal) payload.internal = true;
    batch.set(db.doc(`cameraHealth/${parsed.network}__${d.cameraNumber}`), payload, { merge: true });
  }
  await batch.commit();
  return { devices: parsed.devices.length, internal };
}

/* Unparsed/unmatched status report → the __pending manual-review row. */
async function queueUnmatchedHealthCore(db, { key, reason, subject, receivedAt, nowIso }) {
  const internal = await keyMarkedInternal(db, key);
  const payload = stripOperatorFields({
    customerKey: key,
    customerId: null,
    customerName: null,
    propertyId: null,
    cameraNumber: '—',
    cameraName: 'Status report (needs manual review)',
    mode: null,
    reportDate: null,
    battery: null,
    batteryOk: null,
    sdFreeSpace: null,
    sdFreeGB: null,
    photoQueue: null,
    fwVersion: null,
    clVersion: null,
    deficiencies: [],
    status: 'red',
    dateCurrent: false,
    pending: true,
    pendingReason: String(reason).slice(0, 300),
    subject,
    receivedAt,
    updatedAt: nowIso
  });
  if (internal) payload.internal = true;
  await db.doc(`cameraHealth/${key}__pending`).set(payload, { merge: true });
}

module.exports = {
  OPERATOR_FIELDS,
  stripOperatorFields,
  keyMarkedInternal,
  upsertReportHealthCore,
  queueUnmatchedHealthCore
};
