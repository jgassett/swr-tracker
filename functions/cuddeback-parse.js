/* =====================================================================
 * Cuddeback CuddeLink parsing + health logic (pure, dependency-free).
 * Kept separate from index.js so it can be unit-tested standalone.
 * ===================================================================== */

/* Health thresholds (tune here). */
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
  const key = (idx === -1 ? s : s.slice(0, idx)).trim();
  return key ? key.toUpperCase() : null;
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

/* Parse the report HTML attachment. Returns { reportDate, network, devices[] }
 * from the FIRST (latest) daily table.
 *
 * Item 10 (v2-patch-5) hardening — known format variations:
 *  - <table> may carry attributes on newer firmware (<table border="1">):
 *    the split now tolerates them.
 *  - Device rows are normally <tr class="cl-entry">; firmware that drops or
 *    renames the class falls back to scanning every <tr> with enough cells.
 *  - Date:/Network: header text is unchanged across observed versions. */
function parseReportHtml(html) {
  if (!html) return null;
  const tables = html.split(/<table[^>]*>/i).slice(1);
  if (!tables.length) return null;
  const first = tables[0];

  const dateMatch = first.match(/Date:\s*([\d/]+)/i);
  const netMatch = first.match(/Network:\s*([^<&\-]+?)\s*(?:&nbsp;|<|\s-\s)/i);
  const reportDate = dateMatch ? dateMatch[1].trim() : null;
  const network = netMatch ? netMatch[1].trim().toUpperCase() : null;

  let rows = first.match(/<tr class="cl-entry">[\s\S]*?<\/tr>/gi) || [];
  if (!rows.length) {
    /* Firmware variant without the cl-entry class: take every row; the
       cell-count and camera-number guards below drop headers and filler. */
    rows = first.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  }
  const devices = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => m[1].replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim());
    if (cells.length < 14) continue;              // filler/colspan rows
    const cameraNumber = cells[2];
    const cameraName = cells[3];
    if (!cameraNumber || !cameraName) continue;    // empty placeholder rows
    const queue = parseInt(cells[8], 10);
    devices.push({
      cameraNumber,
      cameraName,
      mode: cells[1],
      battery: cells[6],
      photoQueue: Number.isFinite(queue) ? queue : null,
      sdFreeSpace: cells[10],
      sdFreeGB: sdFreeGB(cells[10]),
      fwVersion: cells[12],
      clVersion: cells[13]
    });
  }
  return { reportDate, network, devices };
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
  subjectKey, customerKeyFor, sdFreeGB,
  parseReportHtml, deviceDeficiencies, deviceStatus, worstStatus, todayMDY
};
