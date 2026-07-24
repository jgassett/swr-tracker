/* =====================================================================
 * Cuddeback CuddeLink parsing + health logic (pure — no Firebase/network
 * dependencies). Kept separate from index.js so it can be unit-tested
 * standalone. Camera keys extracted here go through the shared normKey()
 * (v2-patch-9's single normalizer), so photo subject keys and report
 * network keys are guaranteed to normalize identically to property
 * cameraIds — one function, one invariant (v2-patch-10 Item 4b).
 * ===================================================================== */

const { normKey } = require('./admin-migrations');

/* Health thresholds (tune here).
 *
 * SD rule (v2-patch-15 Item 3) — ONE rule for BOTH report species:
 * every Cuddeback report shows SD condition as FREE SPACE IN GB (CuddeLink
 * network tables and Tracks solo history rows alike — neither carries a
 * percent-used figure). The red-flag condition everywhere is therefore a
 * free-space floor: sdFreeGB < SD_FREE_MIN_GB. Alert copy that used to say
 * "SD card at or above 90% capacity" described a percentage that was never
 * computed anywhere — this GB floor has always been the actual computation
 * (the app's live view uses the identical `sdFreeGB < 4` in
 * deviceDefsLive, index.html) — so the copy now states the real rule.
 * A device row whose free-space text fails to parse leaves sdFreeGB null;
 * the condition is then unevaluable, and handleReportMessage logs a loud
 * per-device warning so it is never SILENTLY unevaluated (the parse tests
 * pin sdFreeGB non-null for both species' fixtures). */
const SD_FREE_MIN_GB = 4;    // free space BELOW this = deficiency (card nearly full)
const PHOTO_QUEUE_MAX = 5;   // photos in queue ABOVE this = deficiency

/* Photo/report subject → customer key (text before the first " - ").
 * Handles every observed subject shape:
 *   "KEY - date - time"                (photo emails)
 *   "Report - KEY - date - time"       (status reports)
 *   "Daily Report - KEY - date - time" (firmware variants prefix "Report"
 *                                       with extra words)
 * The key itself may be the LastnameF multi-property format with a trailing
 * property number (e.g. "HAYDENT1") — it is passed through verbatim,
 * uppercased, exactly as stored in property/customer Camera IDs. */
function subjectKey(subject) {
  if (!subject) return null;
  let s = subject.trim();
  s = s.replace(/^[^-]*\breport\s*-\s*/i, ''); // strip "…Report - " prefixes
  const idx = s.indexOf(' - ');
  const key = normKey(idx === -1 ? s : s.slice(0, idx));
  return key || null;
}

/* Normalize a customer display name to LASTNAME+FIRSTINITIAL (uppercase),
 * matching the camera subject key format (e.g. "Tom Smith" -> "SMITHT",
 * "Smith, Tom" -> "SMITHT"). Returns null if it can't derive one. */
function customerKeyFor(name) {
  if (!name) return null;
  const clean = name.replace(/[^A-Za-z, ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (clean.includes(',')) {
    const [last, first] = clean.split(',').map((s) => s.trim());
    if (last) return (last + (first ? first[0] : '')).toUpperCase().replace(/\s/g, '');
  }
  const toks = clean.split(' ').filter(Boolean);
  if (toks.length >= 2) {
    const last = toks[toks.length - 1];
    const first = toks[0];
    return (last + first[0]).toUpperCase();
  }
  return clean.toUpperCase().replace(/\s/g, '');
}

/* SD free space "14 GB" -> 14 (number), or null. */
function sdFreeGB(s) {
  const m = (s || '').match(/([\d.]+)\s*GB/i);
  return m ? parseFloat(m[1]) : null;
}

/* "M/D/YYYY" (anywhere in the string) -> sortable YYYYMMDD number, 0 if
 * absent — used to pick the NEWEST table/row regardless of email order. */
function mdyNum(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? (+m[3]) * 10000 + (+m[1]) * 100 + (+m[2]) : 0;
}

/* Split a <tr> into trimmed, tag-stripped cell texts. */
function rowCells(row) {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((m) => m[1].replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim());
}

/* Data rows of one table: <tr class="cl-entry"> normally; firmware that
 * drops or renames the class falls back to every <tr> — the callers' cell
 * guards drop headers and filler (Item 10 / v2-patch-5 hardening). */
function tableRows(t) {
  const rows = t.match(/<tr class="cl-entry">[\s\S]*?<\/tr>/gi) || [];
  return rows.length ? rows : (t.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []);
}

/* Parse the report HTML attachment. Cuddeback sends TWO report species
 * (v2-patch-15, owner-confirmed taxonomy):
 *
 *  - CUDDELINK NETWORK reports (linking cameras): stacked per-day tables
 *    headed "Date: <d> - Network: <KEY> - Channel: <c>", one row per
 *    linked device. Handled by parseCuddeLinkTables().
 *  - TRACKS SOLO reports (non-linking cameras): one table headed
 *    "Camera: <KEY>" of per-day history rows for that single device.
 *    Handled by parseTracksTable(). These NEVER parsed before v2-patch-15
 *    (see Item 1 analysis) — the old parser required a Network: header.
 *
 * Returns { species, reportDate, network, devices[] } or null when neither
 * header is present (the caller queues the message for manual review).
 *
 * Item 10 (v2-patch-5) hardening retained: <table> may carry attributes
 * on newer firmware; device rows fall back from cl-entry to every <tr>. */
function parseReportHtml(html) {
  if (!html) return null;
  const tables = html.split(/<table[^>]*>/i).slice(1);
  if (!tables.length) return null;
  if (tables.some((t) => /Network:/i.test(t))) return parseCuddeLinkTables(tables);
  const camHeader = html.match(/Camera:\s*([^<]+?)\s*</i);
  if (camHeader) return parseTracksTable(tables, camHeader[1]);
  return null;
}

/* CuddeLink network report: the email stacks several days' tables
 * (observed newest-first, so the old take-tables[0] behavior was already
 * correct on every fixture). Item 4 (v2-patch-15) makes that explicit:
 * the table is selected by NEWEST parsed "Date:" header, not by position,
 * mirroring the Tracks newest-row rule. Tables without a parseable date
 * rank lowest; if none parse, the first table is used as before. */
function parseCuddeLinkTables(tables) {
  let first = tables[0], bestNum = -1;
  for (const t of tables) {
    const dm = t.match(/Date:\s*([\d/]+)/i);
    const n = dm ? mdyNum(dm[1]) : 0;
    if (n > bestNum) { bestNum = n; first = t; }
  }

  const dateMatch = first.match(/Date:\s*([\d/]+)/i);
  const netMatch = first.match(/Network:\s*([^<&\-]+?)\s*(?:&nbsp;|<|\s-\s)/i);
  const reportDate = dateMatch ? dateMatch[1].trim() : null;
  const network = netMatch ? (normKey(netMatch[1]) || null) : null;

  const devices = [];
  for (const row of tableRows(first)) {
    const cells = rowCells(row);
    if (cells.length < 14) continue;              // filler/colspan rows
    const cameraNumber = cells[2];
    const cameraName = cells[3];
    if (!cameraNumber || !cameraName) continue;    // empty placeholder rows
    /* Column-label row: only reachable via the any-<tr> fallback (its
       cells[2]/[3] are the literal texts "Camera Number"/"Camera Name",
       which passed the guards above). Device numbers are always numeric. */
    if (!/^\d+$/.test(cameraNumber)) continue;
    const queue = parseInt(cells[8], 10);
    devices.push({
      cameraNumber,
      cameraName,
      mode: cells[1],
      battery: cells[6],
      batteryDays: cells[7] || null,
      photoQueue: Number.isFinite(queue) ? queue : null,
      sdPhotos: cells[9] || null,
      sdFreeSpace: cells[10],
      sdFreeGB: sdFreeGB(cells[10]),
      fwVersion: cells[12],
      clVersion: cells[13]
    });
  }
  return { species: 'cuddelink', reportDate, network, devices };
}

/* Tracks solo report: the "Camera: <KEY>" table is a per-day history of
 * ONE device (columns: #, Date, Battery, Battery Days, SD Photos,
 * SD Free Space, HW Version, FW Version, CL Version). The device entry is
 * built from the NEWEST history row by date (rows are observed
 * newest-first, but selection is by parsed date, not position);
 * reportDate is that row's date. cameraNumber is fixed at '1' — a solo
 * unit is always exactly one device, so its health doc is <KEY>__1. */
function parseTracksTable(tables, rawKey) {
  const t = tables.find((x) => /Camera:/i.test(x)) || tables[0];
  const key = normKey(rawKey) || null;
  let best = null, bestNum = 0;
  for (const row of tableRows(t)) {
    const cells = rowCells(row);
    if (cells.length < 9) continue;               // "Camera:" header / filler
    const n = mdyNum(cells[1]);
    if (!n) continue;                             // column-label row ("Date")
    if (n > bestNum) { bestNum = n; best = cells; }
  }
  if (!best) return { species: 'tracks', reportDate: null, network: key, devices: [] };
  return {
    species: 'tracks',
    reportDate: best[1],
    network: key,
    devices: [{
      cameraNumber: '1',
      cameraName: key,
      mode: 'Solo',
      battery: best[2],
      batteryDays: best[3] || null,
      photoQueue: null,                            // no link queue on a solo unit
      sdPhotos: best[4] || null,
      sdFreeSpace: best[5],
      sdFreeGB: sdFreeGB(best[5]),
      fwVersion: best[7],
      clVersion: best[8]
    }]
  };
}

/* Which factors are deficient for one device. */
function deviceDeficiencies(d) {
  const def = [];
  if (/low/i.test(d.battery || '')) def.push('battery');
  if (d.sdFreeGB != null && d.sdFreeGB < SD_FREE_MIN_GB) def.push('sd');
  if (Number.isFinite(d.photoQueue) && d.photoQueue > PHOTO_QUEUE_MAX) def.push('queue');
  return def;
}

/* green | yellow | red for one device, given the report date and today (M/D/YYYY). */
function deviceStatus(d, reportDate, todayMDY) {
  if (!reportDate || reportDate !== todayMDY) return 'red';   // stale date overrides
  const n = deviceDeficiencies(d).length;
  return n === 0 ? 'green' : n === 1 ? 'yellow' : 'red';
}

/* Worst status among a set (for the per-customer roll-up). */
function worstStatus(statuses) {
  if (statuses.includes('red')) return 'red';
  if (statuses.includes('yellow')) return 'yellow';
  return statuses.length ? 'green' : 'red';
}

/* Today's date as M/D/YYYY in a given IANA timezone. */
function todayMDY(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric'
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('month')}/${g('day')}/${g('year')}`;
}

module.exports = {
  SD_FREE_MIN_GB, PHOTO_QUEUE_MAX,
  subjectKey, customerKeyFor, sdFreeGB, mdyNum,
  parseReportHtml, deviceDeficiencies, deviceStatus, worstStatus, todayMDY
};
