#!/usr/bin/env node
/*
 * reset-pin.mjs — directly set an operator's PIN (Firebase Auth password).
 *
 * Fallback for when the in-app "Email me a reset link" button / Firebase
 * console reset can't be used (e.g. the account's mailbox doesn't receive
 * mail). Runs locally with a Firebase service-account key; nothing here is
 * deployed with the app.
 *
 * Usage:
 *   node reset-pin.mjs <EMPLOYEE_ID | email> <new-PIN>
 *
 * Examples:
 *   node reset-pin.mjs JG01 481920
 *   node reset-pin.mjs jon@southern-wildlife.com 481920
 *
 * The service-account key is read from (in order):
 *   1. $GOOGLE_APPLICATION_CREDENTIALS
 *   2. ./serviceAccountKey.json   (next to this script)
 *
 * See README.md in this folder for setup.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_PROJECT = 'swr-tracker-54dfd';

/* Employee ID → account email. Mirrors EMPLOYEE_ID_TO_EMAIL in the app. */
const EMPLOYEE_ID_TO_EMAIL = {
  JG01: 'jon@southern-wildlife.com',
  RG01: 'robin@southern-wildlife.com',
  CG01: 'chris@southern-wildlife.com',
  TC01: 'tanya.clark0071@gmail.com',
};

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function loadServiceAccount() {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(HERE, 'serviceAccountKey.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    die(
      `Couldn't read a service-account key.\n` +
      `  Looked at: ${path}\n` +
      `  Download one: Firebase console → Project settings → Service accounts →\n` +
      `  "Generate new private key", then save it as admin-tools/serviceAccountKey.json\n` +
      `  (or set GOOGLE_APPLICATION_CREDENTIALS to its path).`
    );
  }
  let json;
  try { json = JSON.parse(raw); } catch { die(`Service-account key at ${path} is not valid JSON.`); }
  if (json.project_id && json.project_id !== EXPECTED_PROJECT) {
    die(`Key is for project "${json.project_id}", expected "${EXPECTED_PROJECT}". Wrong key file?`);
  }
  return json;
}

async function main() {
  const [who, pin] = process.argv.slice(2);
  if (!who || !pin) {
    die('Usage: node reset-pin.mjs <EMPLOYEE_ID | email> <new-PIN>');
  }

  /* Resolve the target email. */
  const key = who.trim();
  const email = EMPLOYEE_ID_TO_EMAIL[key.toUpperCase()] || (key.includes('@') ? key.toLowerCase() : null);
  if (!email) {
    die(`Unknown Employee ID "${key}". Known: ${Object.keys(EMPLOYEE_ID_TO_EMAIL).join(', ')} — or pass a full email.`);
  }

  /* Firebase passwords must be at least 6 characters. The app treats PINs as
     6 digits; enforce numeric + 6-digit to match, but allow longer numeric. */
  if (!/^\d{6,}$/.test(pin)) {
    die('PIN must be all digits and at least 6 long (the app uses 6-digit PINs).');
  }

  const serviceAccount = loadServiceAccount();
  initializeApp({ credential: cert(serviceAccount) });
  const auth = getAuth();

  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') {
      die(`No account exists for ${email}. Nothing changed.`);
    }
    die(`Lookup failed for ${email}: ${err && err.message || err}`);
  }

  await auth.updateUser(user.uid, { password: pin });
  console.log(`\n✔ PIN reset for ${email} (uid ${user.uid}).`);
  console.log(`  Sign in with ${key.toUpperCase() in EMPLOYEE_ID_TO_EMAIL ? key.toUpperCase() : 'the matching Employee ID'} and the new PIN.\n`);
  console.log('  Reminder: delete admin-tools/serviceAccountKey.json when you no longer need it.\n');
  process.exit(0);
}

main().catch((err) => die(err && err.message || String(err)));
