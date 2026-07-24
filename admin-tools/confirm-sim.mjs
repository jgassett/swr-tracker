/* v2-patch-13 Item 2: scripted DOM simulation of the confirmDialog sentinel
   flow. Unlike nav-sim (which mirrors logic), this extracts the REAL
   confirmDialog source out of index.html and runs it against a stub DOM, so
   a regression in the shipped function fails here.

   Covers the live bug fixed in this patch: the sentinel input renders with
   text-transform:uppercase, so the operator always SEES "CONFIRM" while the
   value's real case is unknowable — iOS predictive-text acceptance inserts
   mixed case ("Confirm ") and the old exact-case compare left a silently
   dead OK button. */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* Extract `function confirmDialog(...) { ... }` by brace counting. */
const start = src.indexOf('function confirmDialog(');
if (start < 0) { console.error('FAIL: confirmDialog not found in index.html'); process.exit(1); }
const bodyBrace = src.indexOf(') {', start) + 2;   /* skip `opts = {}` in the params */
let depth = 0, end = -1;
for (let i = bodyBrace; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = src.slice(start, end);

/* ---- minimal DOM stubs ---- */
function makeEl(id) {
  const listeners = new Map();
  return {
    id,
    textContent: '', value: '', placeholder: '', disabled: false, onclick: null,
    classes: new Set(id === 'confirmSentinel' || id === 'confirmSentinelHint' ? ['hidden'] : []),
    classList: {
      add(c) { this._el.classes.add(c); }, remove(c) { this._el.classes.delete(c); },
      toggle(c, force) { force ? this._el.classes.add(c) : this._el.classes.delete(c); },
      contains(c) { return this._el.classes.has(c); },
    },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type) { [...(listeners.get(type) || [])].forEach((fn) => fn()); },
    listenerCount(type) { return (listeners.get(type) || new Set()).size; },
    focus() {},
  };
}
const ids = ['confirmTitle', 'confirmBody', 'confirmSentinel', 'confirmSentinelInput', 'confirmSentinelHint', 'confirmOk', 'confirmCancel', 'confirm'];
const els = Object.fromEntries(ids.map((i) => [i, makeEl(i)]));
for (const el of Object.values(els)) el.classList._el = el;
const $ = (sel) => els[sel.replace('#', '')] || null;

const confirmDialog = new Function('$', 'setTimeout', `${fnSrc}; return confirmDialog;`)($, () => {});

/* ---- helpers ---- */
let step = 0;
function check(desc, cond) {
  step++;
  if (!cond) { console.error(`FAIL step ${step}: ${desc}`); process.exit(1); }
  console.log(`ok ${String(step).padStart(2)}: ${desc}`);
}
const input = els.confirmSentinelInput, ok = els.confirmOk, hint = els.confirmSentinelHint;
function type(v) { input.value = v; input.fire('input'); }
async function settle(p) { let v; await p.then((r) => { v = r; }); return v; }

/* 1 — non-sentinel dialog: OK armed immediately, resolves true */
{
  const p = confirmDialog('Plain?', 'body', { okText: 'Go' });
  check('non-sentinel: dialog opens', els.confirm.classList.contains('open'));
  check('non-sentinel: OK enabled immediately', !ok.disabled);
  check('non-sentinel: sentinel row hidden', els.confirmSentinel.classList.contains('hidden'));
  ok.onclick();
  check('non-sentinel: resolves true on OK', await settle(p) === true);
}

/* 2 — sentinel happy path: open → type → arms → resolves true */
{
  const p = confirmDialog('Type CONFIRM', 'body', { sentinel: 'CONFIRM', okText: 'Delete' });
  check('sentinel: opens with OK disabled', ok.disabled === true);
  check('sentinel: input visible', !els.confirmSentinel.classList.contains('hidden'));
  check('sentinel: input listener attached', input.listenerCount('input') === 1);
  type('CONF');
  check('sentinel: partial entry keeps OK disabled', ok.disabled === true);
  check('sentinel: partial entry shows mismatch hint', !hint.classList.contains('hidden') && hint.textContent.includes('CONFIRM'));
  type('CONFIRM');
  check('sentinel: exact CONFIRM arms OK', ok.disabled === false);
  check('sentinel: hint hidden once matched', hint.classList.contains('hidden'));
  ok.onclick();
  check('sentinel: resolves true on armed OK', await settle(p) === true);
  check('sentinel: listener removed on cleanup', input.listenerCount('input') === 0);
  check('sentinel: row re-hidden on cleanup', els.confirmSentinel.classList.contains('hidden'));
}

/* 3 — the live iPhone bug: display shows CONFIRM, value is "Confirm "
   (predictive-text acceptance). Must arm. */
{
  const p = confirmDialog('Type CONFIRM', 'body', { sentinel: 'CONFIRM' });
  type('Confirm ');
  check('iOS masked-case value "Confirm " arms OK', ok.disabled === false);
  ok.onclick();
  check('iOS masked-case: resolves true', await settle(p) === true);
}

/* 4 — plain lowercase (auto-capitalization disabled in iOS Settings) */
{
  const p = confirmDialog('Type CONFIRM', 'body', { sentinel: 'CONFIRM' });
  type('confirm');
  check('lowercase "confirm" arms OK', ok.disabled === false);
  els.confirmCancel.onclick();
  check('cancel still resolves false', await settle(p) === false);
}

/* 5 — genuine mismatch: never arms, hint explains; clearing hides hint */
{
  const p = confirmDialog('Type CONFIRM', 'body', { sentinel: 'CONFIRM' });
  type('CONFIRN');
  check('wrong word keeps OK disabled', ok.disabled === true);
  check('wrong word shows hint', !hint.classList.contains('hidden'));
  type('');
  check('cleared box hides hint', hint.classList.contains('hidden'));
  check('cleared box keeps OK disabled', ok.disabled === true);
  els.confirmCancel.onclick();
  check('mismatch flow: cancel resolves false', await settle(p) === false);
  check('mismatch flow: OK re-enabled after cleanup', ok.disabled === false);
}

/* 6 — the deleteCameraPermanently shape: plain dialog then sentinel dialog
   back-to-back; state must fully reset between the two */
{
  const p1 = confirmDialog('Permanently delete?', 'explain', { okText: 'Continue' });
  ok.onclick();
  check('chained: step 1 resolves true', await settle(p1) === true);
  const p2 = confirmDialog('Type CONFIRM', 'final', { sentinel: 'CONFIRM', okText: 'Delete Camera' });
  check('chained: step 2 re-opens with OK disabled', ok.disabled === true && els.confirm.classList.contains('open'));
  check('chained: exactly one input listener (no stale handler)', input.listenerCount('input') === 1);
  type('CONFIRM');
  check('chained: arms after typing', ok.disabled === false);
  ok.onclick();
  check('chained: step 2 resolves true', await settle(p2) === true);
}

console.log('\nconfirm-sim: ALL steps passed');
