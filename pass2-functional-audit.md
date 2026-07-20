# SWR Tracker — Pass 2: Functional Audit (Consolidated)

**Scope:** Every user-facing flow across the six modules — main landing/navigation, Trapping, Pesticides, Customers, Pricing Constructor, and Field Intelligence — inspected against ten dimensions (dead-end navigation, form validation gaps, unhandled Firestore writes, loading states without timeout, QuickBooks partial-failure consistency, blank-screen/undefined errors, null lookups on auto-populate, missing delete confirmations, Submit-&-New carry-over, and offline write-queue loss).

**Method:** Five parallel module analysts (Navigation/Auth, Trapping, Pesticides, Customers & Pricing Constructor, Field Intelligence + app-wide sweep). The Trapping module was audited both manually and by an independent re-run, which corroborated the manual findings and added three minor ones.

**Files:** `index.html` (~8,500-line vanilla-JS PWA), `functions/index.js` (Cloud Functions).

**Totals: 2 Critical · 8 High · 12 Medium · 12 Low.**

> This is the assessment as captured at audit time. A remediation-status appendix at the end maps each finding to the fix round.

---

## CRITICAL

**C1 — Duplicate QuickBooks estimates from double-tap** · Pricing Constructor · `index.html` `approveAndPushEstimate`, dispatcher; `functions/index.js` `qbPushEstimate`
The Approve & Push button sits inside the regenerated `estimateDetail` HTML and is never disabled during the call. A double-tap fires two concurrent `qbPushEstimate` calls; both read status `Pending Approval` and POST to Intuit before either Firestore write lands → two QuickBooks estimates. No server-side idempotency guard.
*Fix:* disable the button on click; wrap the server read-then-write in a Firestore transaction that short-circuits if `qbEstimateId` is already set.

**C2 — QBO object created but Firestore write-back fails → duplicate on retry** · Pricing Constructor + Customers · `functions/index.js` `qbPushEstimate` / `qbConvertToInvoice` / `qbCreateCustomer`
If the Intuit POST succeeds but the follow-up `estRef.set(...)`/`ref.set({qbId})` fails (transient network), the record keeps its pre-push state while QBO already holds the object. Retry re-POSTs → duplicate estimate/invoice, or an orphaned QBO customer permanently unlinked in Firestore. The `qbInvoiceId` guard is useless because the id was never persisted.
*Fix:* persist the returned QBO id in the same try; on write-back failure store it in a recovery field and check it before re-POSTing; for customers, query QBO by DisplayName before create.

---

## HIGH

**H1 — Primary trap-record save can fail silently** · Trapping · `confirmSave`, write via `dbPut`
The `try` has a `finally` but no `catch`. If `dbPut` rejects (e.g., permission-denied), the exception propagates: `closeSheet`/`resetForm`/success-toast never run, the review sheet stays open, and the operator gets no error — the record isn't saved but appears to have been. Primary data-entry path. (Independent pass rated this Critical.)
*Fix:* wrap the body in try/catch, toast the failure, reset UI only on success.

**H2 — Trap save freezes and locks out all further saves when offline** · Trapping · `confirmSave` → `dbPut`
With `persistentLocalCache`, `setDoc`/`addDoc` promises resolve only after the backend acks — offline they stay pending. `confirmSave` awaits `dbPut`, so offline the "Saving…" button never clears, `isSaving` stays `true`, and the double-tap guard blocks every subsequent save until an app reload. Data is queued safely, but the app appears frozen and locks out saving. Highest-impact bug for offline field use. (Independent pass rated this Critical.)
*Fix:* treat the local-cache write as success for UI (don't await the server ack), surface a "saved offline, will sync" state.

**H3 — Pending trap photo lost offline** · Trapping · `confirmSave` photo upload
`pendingPhotoBlob` is an in-memory Blob; Firebase Storage has no offline queue. Offline, `uploadBytes` hangs; if the app is force-closed the blob is gone and the queued record syncs permanently without `photoUrl`, with no warning.
*Fix:* persist the blob to IndexedDB tied to the record and retry on reconnect, or block/warn on offline photo save.

**H4 — Infinite splash spinner if boot never resolves** · Global · `hideSplash`, only called from `onAuthStateChanged`
The splash is hidden only when the first auth callback fires. No watchdog, no `window.onerror`/`unhandledrejection`, and the top-level `await setPersistence` can abort the module. If the Firebase SDK import is blocked (CSP/CDN), it's a hard-offline first load, or auth hangs, the spinner runs forever with no escape.
*Fix:* ~10s watchdog that shows a "Can't reach the server — reload" screen; wrap top-level init in try/catch surfacing a fatal-error state.

**H5 — Client callable timeout (70s) shorter than server (120s) → false-failure duplicates** · Pricing Constructor · `httpsCallable` calls; `functions/index.js` `timeoutSeconds`
Firebase callables default to a 70s client timeout; the functions run up to 120s. A slow Intuit response makes the client show "Push failed" while the server completes the POST → user retries → duplicate (compounds C1/C2). No custom timeout set on any callable.
*Fix:* raise the client timeout via `httpsCallable(fn, {timeout})`; treat `deadline-exceeded` as "verify in QuickBooks before retrying," not a plain failure.

**H6 — Manual customer created while QBO disconnected is never linked, then duplicated** · Customers · customer-create → `qbCreateCustomer`; `syncCustomers`
`qbCreateCustomer` is fire-and-forget. On failure/`failed-precondition` the customer stays with no `qbId`, no retry, no flag, and no manual "Push to QuickBooks" button in the editor. The one-way sync (keyed on `qbId`) never links it; if the customer is later added in QBO, sync creates a second Firestore row. Estimates for the unlinked customer can never be pushed.
*Fix:* store a `qbCreateError`/`qbSyncPending` flag, surface a retry button, and match manual rows by name+email in sync before creating.

**H7 — Convert-to-Invoice double-tap race → duplicate invoice** · Pricing Constructor · `convertEstimateToInvoice`; guard in `qbConvertToInvoice`
`confirm()` gates it but the button isn't disabled after confirming; two rapid confirms → two invoices. The guard is a non-transactional read.
*Fix:* disable the button; make the guard a Firestore transaction.

**H8 — Offline-captured pesticide application photo permanently lost** · Pesticides · `confirmSavePesticide`
Same mechanism as H3, on a regulatory application record. Offline, `uploadBytes` throws → "Save without photo?" → the record saves without the photo and the in-memory blob is discarded, with no retry.
*Fix:* persist the blob to IndexedDB and retry on reconnect, or block save-without-photo while offline.

---

## MEDIUM

**M1 — Reject-estimate proceeds even when the operator cancels the prompt** · Pricing Constructor · `rejectEstimate`
`prompt(...)` returning `null` (Cancel) becomes `''` and the code rejects anyway — no way to abort, no confirmation dialog, and the `writeWithRetry` isn't caught (silent failure).
*Fix:* `if (note === null) return;`; add try/catch + error toast.

**M2 — Fire-and-forget writes with no error feedback** · App-wide (Dim 3). Each awaits a write whose success-toast fires only on resolve, so a rejection shows the user nothing:

| Function | Module |
|---|---|
| `submitEstimateForApproval` | Pricing |
| `rejectEstimate` | Pricing |
| `deleteEstimateDraft` | Pricing |
| `setJobStatus` | Schedule |
| `deleteJob` | Schedule |
| `deletePesticideRecord` | Pesticides |
| record delete handler | Trapping |

*Fix:* wrap each in try/catch with an error toast; `await`/`.catch` at the dispatchers.

**M3 — Save hangs indefinitely when offline** · Customers, Pricing (and Trapping, see H2) · `handleSaveCustomer`, `handleSaveEstimate`, `writeWithRetry`
The Firestore SDK does not resolve `addDoc`/`setDoc` promises while offline (the local cache updates, but the `await` stays pending). Result: Save button stuck "Saving…", `isSaving` stuck true, success toast never fires, follow-ups (`qbCreateCustomer`) never run — until reconnect. Data isn't lost; the UI is frozen. The code comment incorrectly assumes the write "queues and returns."
*Fix:* update UI/toast optimistically without blocking on the server ack, or detect `!navigator.onLine` and show "queued."

**M4 — "Saved" toasts imply durability that offline writes don't have** · App-wide · sync indicator
Every success toast fires on local resolve; offline that means merely queued, not server-confirmed. The sync indicator only reflects the `records` collection, so a pending write on customers/jobs/estimates still shows "Synced."
*Fix:* distinguish "queued (offline)" from "synced"; derive pending state across the active module's subscription.

**M5 — Eight of nine `onSnapshot` subscriptions are log-only** · App-wide · org, pesticides, pesticideRecords, customers, estimates, cameraHealth, cameraPhotos, jobs
Only the `records` stream surfaces errors and self-heals with a 5s retry. The others just `console.error` — on a permanent stream error the module silently stops updating with no user-visible error and no retry.
*Fix:* apply the records stream's error-indicator + retry pattern, at least to customers/jobs/estimates.

**M6 — Field-camera assignment writes with no confirmation and no undo** · Field Intelligence · `assignFieldPhotos`
A single autocomplete mis-tap immediately writes `cameraId` onto the wrong customer and stamps every matching photo, with no confirm step and no undo.
*Fix:* `confirmDialog("Link {key} → {name}?")` before writing; add an early `if (!customer || !customer.id) return;`.

**M7 — Pesticide master partial-save + misleading toast** · Pesticides · `savePesticide`
The product doc is written first, then SDS/label uploads. If an upload fails, the doc is already persisted but the user sees "Save failed," leaving a product with no PDF URLs (and offline, an orphaned doc that syncs later without the PDF the toast said failed).
*Fix:* upload first, or report partial success distinctly.

**M8 — Editing a pesticide record whose product was deleted silently drops the brand** · Pesticides · `loadPesticideRecordIntoForm`
If the product no longer exists in `cachedPesticides`, the `<option>` is gone, the select resets to "", and on re-save the record reverts to "(unspecified brand)" — losing the original brand association.
*Fix:* inject a disabled option showing the stored `brandName` when `brandId` isn't in the dropdown.

**M9 — Weather / concentration / volume ranges unvalidated** · Pesticides · `validatePesticideRecord`; master `savePesticide`
The form is `novalidate`, so HTML `min`/`max` aren't enforced. Accepts negative or absurd temp/wind/humidity, negative or >100 concentration, negative/zero volume, and master concentration outside 0–100.
*Fix:* add explicit range checks (temp −40…130, wind/humidity 0…100, 0<conc≤100, volume>0).

**M10 — Uploads have no timeout; save spinner can stick forever** · Pesticides + Trapping · `uploadBytes`/`getDownloadURL`
A stalled large upload leaves the Save button "Saving…" indefinitely with no progress indicator or abort; offline it hangs instead of hitting the "Save Without Photo" fallback.
*Fix:* `Promise.race` timeout on uploads and/or a progress indicator.

**M11 — `EMAIL_TO_TRAPPER` lookup missing `.toLowerCase()`** · Global · push-token write (two sites)
Every other call site normalizes case; these two don't. If Firebase returns a differently-cased email, the trapper name silently falls back to the raw email in the push-token doc / notifications.
*Fix:* `currentUser.email.toLowerCase()` at both sites.

**M12 — No date sanity checks on trap records** · Trapping · `validateRecord`
Only presence is checked. `dateCollected` accepts future dates; `releaseDate` can be before `dateCollected`. Data-integrity problem for a KDFWR wildlife record.
*Fix:* reject `dateCollected > today` and `releaseDate < dateCollected`.

---

## LOW

**L1 — `animalCount` has no upper bound** · Trapping · `readForm` — clamps to ≥1 but accepts absurd values (form is `novalidate`).
**L2 — `excludedNumber` allows decimals / no upper bound** · Trapping · `readForm` uses `Number()`; validate only rejects `< 0` — `3.5` saves.
**L3 — Detail subtitle renders "undefined County"** · Trapping · `openSheet` interpolates raw `rec.county` instead of `countyDisplay(rec)` (cosmetic).
**L4 — Phone/ZIP not validated on customers** · Customers · `handleSaveCustomer` — name required, email regex-checked, but malformed phone/ZIP accepted.
**L5 — Record & pesticide writes bypass `writeWithRetry`** · Trapping `dbPut`, Pesticides master/record/delete writes — raw `setDoc`/`addDoc`/`deleteDoc`, forgoing the transient-retry the customer/estimate paths use.
**L6 — Detail "not found" branches drop the back button** · Pricing/Schedule · `renderEstimateDetail`, `renderJobDetail` return before appending Back (bottom nav still works, so not a hard trap). Also `showEstimateDetail` bypasses `setView`, leaving bottom-nav active state wrong.
**L7 — `setView` with an unmapped name shows a blank body** · Global · no fallback view (only reachable via a future nav-config typo).
**L8 — Sign-in silently no-ops on empty fields** · Auth · `handleSignIn` — `if (!idRaw||!pin) return;` with no message (form is `novalidate`).
**L9 — `handleSignOut` sign-out not wrapped** · Auth · no try/catch; a network failure is an unhandled rejection with no feedback.
**L10 — Photo tile with no `storagePath` renders broken** · Field · broken `<img>` and href-less `<a>` (cosmetic).
**L11 — `finalVolumeGallons` allows 0** · Pesticides · check is `< 0`, likely should be `<= 0`.
**L12 — "Other" brand savable with no name / no per-product EPA required** · Pesticides · renders "(unspecified brand)".

---

## Dimensions confirmed clean
- **Submit-&-New reset (Dim 9):** clean in all modules — Trapping (double-verified: species/disposal/count/capture/dispatch/release all reset, and `editingId` cleared so edit→Submit-&-New creates a new record), Pesticides (`confirmSavePesticide` carries only date/applicator/client), Estimates & Customers (`resetEstimateBuilder`/`resetCustomerForm`).
- **Delete confirmations (Dim 8):** all destructive actions confirm — trap-record, customer, estimate, pesticide product (admin-gated + sentinel), sign-out, Clear All Records. **Exception:** field-camera assignment (M6).
- **Auto-populate null-safety (Dim 7):** `applyCustomerToTrapForm`, `applyCustomerToPesticideForm`, `handleBrandSelectChange`, estimate customer prefill, field key resolution — all guarded. **Exception:** deleted-product brand (M8).
- **Navigation exits (Dim 1):** every module has a working back/cancel/menu path; the persistent bottom nav is a sibling of the view container, so no hard dead-ends (only the cosmetic L6 not-found gaps).

---

## Priorities (as recommended at audit time)
1. **QuickBooks integrity (C1, C2, H5, H6, H7)** — highest-severity cluster. Two changes neutralize most of it: disable the QBO action buttons on tap, and add server-side transactional idempotency guards to `qbPushEstimate`/`qbConvertToInvoice`.
2. **Offline save path (H1, H2, H3, M3)** — top risk for daily field use; writes are never lost, but the UI freezes, locks out, or fails silently.
3. **Boot resilience (H4)** — one watchdog timer.
4. Then the Medium error-handling/validation batch and the Lows.

---

## Appendix — Remediation status (as of Round 4)

Fixes were applied on the `audit-fixes` branch in rounds. Rules and Cloud Functions were deployed as each round completed; client-side (`index.html`) changes are staged on `audit-fixes` and go live when it merges to `main`.

| Finding | Status | Round |
|---|---|---|
| C1, C2, H5, H7 | Fixed & deployed | Round 1 (QBO integrity) + C2 recovery field in Round 2 |
| H1, H2, H3, H8, M3 | Fixed (client) | Round 2 (offline save path) |
| H4, M5 | Fixed (client) | Round 3 (boot + streams) |
| M1, M2, M6, M7, M9, M10, M11, M12 | Fixed (client) | Round 4 |
| H6 | Partially addressed | Server DisplayName dedup (Round 1); full retry-affordance not yet done |
| L1, L2, L3, L4, L5, L6, L8, L9, L11, M4, M8 | Planned | Round 5 (final cleanup — not yet started) |
| L7, L10, L12 | Deferred (won't-fix this cycle) | — |
