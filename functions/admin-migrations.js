/* =====================================================================
 * v2-patch-8: admin data-management migrations — SERVER-SIDE cores.
 * ---------------------------------------------------------------------
 * These ran client-side in v2-patch-7 and died with "The client has
 * already been terminated": the Firestore Web SDK's persistent multi-tab
 * cache shuts down permanently when the tab loses its IndexedDB lease
 * mid-run (iOS suspending the PWA during a minutes-long sequential write
 * loop). The Admin SDK has no such failure mode, no rules latency, and no
 * per-write network round-trip from a phone.
 *
 * Kept separate from index.js so the emulator functional test can require
 * this module directly and run the EXACT shipped logic against seeded
 * data (FIRESTORE_EMULATOR_HOST). Both cores take the Firestore instance
 * as an argument for the same reason.
 * ===================================================================== */

'use strict';

/* v2-patch-9 Item 1: THE camera-key normalizer — every camera-key
 * comparison in this module goes through it. Email-pipeline keys arrive
 * uppercase (HAYDENT); property/customer cameraIds may be stored mixed
 * case (HaydenT). Normalization happens ONLY at comparison time; stored
 * values keep their original casing for display. */
function normKey(v) {
  return (v == null ? '' : String(v)).trim().toUpperCase();
}

/* Backfill: one "Primary" property per customer with an EMPTY properties
 * subcollection, built from the customer's home address fields. Idempotent
 * — customers with any property are skipped, so running twice is safe. */
async function backfillPrimaryPropertiesCore(db) {
  const [custSnap, propSnap] = await Promise.all([
    db.collection('customers').get(),
    db.collectionGroup('properties').get()
  ]);
  const hasProps = new Set();
  propSnap.forEach((d) => {
    const cid = d.get('customerId') || (d.ref.parent.parent ? d.ref.parent.parent.id : null);
    if (cid) hasProps.add(cid);
  });
  const nowIso = new Date().toISOString();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  let backfilled = 0;
  let skipped = 0;
  for (const d of custSnap.docs) {
    if (hasProps.has(d.id)) { skipped++; continue; }
    batch.set(d.ref.collection('properties').doc(), {
      customerId: d.id,
      siteNickname: 'Primary',
      address: d.get('address') || '',
      city: d.get('city') || '',
      county: d.get('county') || '',
      insideCityLimits: null,
      cameraId: '',
      isPrimary: true,
      autoCreated: true,
      manuallyEdited: false,
      createdAt: nowIso,
      createdByUid: null,
      createdByEmail: 'admin-backfill',
      updatedAt: nowIso
    });
    backfilled++;
    if (++ops >= 450) await flush();
  }
  await flush();
  return { backfilled, skipped };
}

/* Re-link: every cameraHealth record's camera key matched against property
 * cameraIds — exact string match, case-insensitive via normKey. When no
 * property matches, v2-patch-9 Item 2 falls back to the DEPRECATED
 * customer-level cameraId field (also case-insensitive): a unique customer
 * claim writes that customer's stored (mixed-case) cameraId onto their
 * primary property, then links — this heals the data the failed
 * client-side migration never moved. Matches get their denormalized link
 * fields refreshed on the cameraHealth docs and the per-network
 * cameraStatus doc, so previously-pending rows resolve.
 * Returns { linked, linkedViaFallback, unmatched: [{ key, hint }] } where
 * hint (nullable) explains why a key could not be linked. */
async function relinkCamerasCore(db) {
  const [healthSnap, propSnap, custSnap, statusSnap] = await Promise.all([
    db.collection('cameraHealth').get(),
    db.collectionGroup('properties').get(),
    db.collection('customers').get(),
    db.collection('cameraStatus').get()
  ]);
  const nameById = new Map();
  custSnap.forEach((d) => nameById.set(d.id, d.get('name') || ''));

  /* Property cameraIds (the source of truth) + per-customer property docs
     (the fallback write targets). */
  const byCam = new Map();
  const propsByCustomer = new Map();
  propSnap.forEach((d) => {
    const customerId = d.get('customerId') || (d.ref.parent.parent ? d.ref.parent.parent.id : null);
    if (!customerId) return;
    propsByCustomer.set(customerId, [...(propsByCustomer.get(customerId) || []), d]);
    const cam = normKey(d.get('cameraId'));
    if (!cam) return;
    byCam.set(cam, { customerId, propertyId: d.id, customerName: nameById.get(customerId) || '' });
  });

  /* Item 2: deprecated customer-level cameraIds, normalized key → claims
     (the stored raw value is kept so the fallback writes the original
     mixed-case ID for display). */
  const custByCam = new Map();
  custSnap.forEach((d) => {
    const raw = String(d.get('cameraId') || '').trim();
    const K = normKey(raw);
    if (!K) return;
    custByCam.set(K, [...(custByCam.get(K) || []), { id: d.id, raw, name: d.get('name') || '' }]);
  });

  const primaryOf = (customerId) => {
    const docs = propsByCustomer.get(customerId) || [];
    const prims = docs.filter((p) => p.get('isPrimary') === true)
      .sort((a, b) => String(a.get('createdAt') || '').localeCompare(String(b.get('createdAt') || '')));
    return prims[0] || (docs.length === 1 ? docs[0] : null);
  };

  /* Group health docs by unique camera key. */
  const keyOf = (d) =>
    normKey(d.get('customerKey') || (d.id.includes('__') ? d.id.split('__')[0] : d.id));
  const docsByKey = new Map();
  for (const d of healthSnap.docs) {
    const key = keyOf(d);
    if (!key) continue;
    docsByKey.set(key, [...(docsByKey.get(key) || []), d]);
  }

  const nowIso = new Date().toISOString();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  let linked = 0;
  let linkedViaFallback = 0;
  let internalIgnored = 0;
  const unmatched = [];

  for (const [key, docs] of [...docsByKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    /* Item 4: internal (non-customer) cameras — e.g. the SWR master unit —
       are flagged from the Monitoring pending queue. They link to no
       customer and never count as unmatched; their health rows keep
       ingesting normally. */
    if (docs.some((d) => d.get('internal') === true)) { internalIgnored++; continue; }
    let match = byCam.get(key) || null;

    if (!match) {
      /* Item 2: customer-level fallback — exact key, case-insensitive. */
      const claims = custByCam.get(key) || [];
      if (claims.length === 1) {
        const cl = claims[0];
        const target = primaryOf(cl.id);
        const targetCam = target ? normKey(target.get('cameraId')) : '';
        if (target && !targetCam) {
          /* Write the customer's ORIGINAL mixed-case ID for display;
             matching normalizes, so this links. */
          await target.ref.set({ cameraId: cl.raw, updatedAt: nowIso }, { merge: true });
          match = { customerId: cl.id, propertyId: target.id, customerName: cl.name, viaFallback: true };
          byCam.set(key, match);
        } else if (target) {
          unmatched.push({ key, hint: `customer-level Camera ID matches ${cl.name}, but their primary property already routes camera ${target.get('cameraId')} — resolve manually` });
          continue;
        } else {
          unmatched.push({ key, hint: `customer-level Camera ID matches ${cl.name}, but they have no primary/sole property — run Backfill Primary Properties first` });
          continue;
        }
      } else if (claims.length > 1) {
        unmatched.push({ key, hint: `customer-level Camera ID claimed by ${claims.length} customers (${claims.map((c) => c.name || c.id).join(', ')}) — resolve manually` });
        continue;
      } else {
        /* Item 3: numbered keys (PULLIAMR1, PULLIAMR2) — a trailing number
           names a SPECIFIC site, so linking is never guessed. If the
           digit-stripped base matches a customer-level cameraId (or a
           property), report unmatched WITH a hint naming that customer so
           the numbered property can be created and assigned manually. */
        const base = key.replace(/\d+$/, '');
        let hint = null;
        if (base && base !== key) {
          const baseClaims = custByCam.get(base) || [];
          const baseProp = byCam.get(base) || null;
          if (baseClaims.length) {
            hint = `numbered key — customer-level Camera ID ${baseClaims[0].raw} suggests ${baseClaims.map((c) => c.name || c.id).join(', ')}; create/assign property #${key.slice(base.length)} manually, do not guess`;
          } else if (baseProp) {
            hint = `numbered key — base ${base} routes to ${baseProp.customerName || baseProp.customerId}; create/assign property #${key.slice(base.length)} manually, do not guess`;
          }
        }
        unmatched.push({ key, hint });
        continue;
      }
    }

    if (match.viaFallback) linkedViaFallback++; else linked++;
    for (const d of docs) {
      if (d.get('customerId') !== match.customerId || d.get('propertyId') !== match.propertyId
          || d.get('customerName') !== match.customerName) {
        batch.set(d.ref, {
          customerId: match.customerId,
          customerName: match.customerName,
          propertyId: match.propertyId,
          updatedAt: nowIso
        }, { merge: true });
        if (++ops >= 450) await flush();
      }
    }
  }

  for (const d of statusSnap.docs) {
    const key = normKey(d.get('customerKey') || d.id);
    const match = byCam.get(key);
    if (!match) continue;
    if (d.get('customerId') !== match.customerId || d.get('propertyId') !== match.propertyId
        || d.get('customerName') !== match.customerName) {
      batch.set(d.ref, {
        customerId: match.customerId,
        customerName: match.customerName,
        propertyId: match.propertyId,
        updatedAt: nowIso
      }, { merge: true });
      if (++ops >= 450) await flush();
    }
  }
  await flush();
  return { linked, linkedViaFallback, internalIgnored, unmatched };
}

/* Pure admin-gate decision (the callable wrappers in index.js throw the
 * matching HttpsError). Pure so the security test exercises the exact
 * shipped logic: 'ok' | 'unauthenticated' | 'permission-denied'. */
function adminGateDecision(auth, adminEmails) {
  if (!auth) return 'unauthenticated';
  const email = ((auth.token && auth.token.email) || '').toLowerCase();
  return adminEmails.includes(email) ? 'ok' : 'permission-denied';
}

module.exports = { backfillPrimaryPropertiesCore, relinkCamerasCore, adminGateDecision, normKey };
