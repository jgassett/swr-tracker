#!/usr/bin/env node
/*
 * create-operator.mjs — create a Firebase Auth account for a new operator.
 *
 * Runs locally with a Firebase service-account key (same setup as
 * reset-pin.mjs — see README.md); nothing here is deployed with the app.
 * Credentials are never hardcoded: the email comes from the Employee ID map
 * and the PIN is passed on the command line.
 *
 * Usage:
 *   node create-operator.mjs <EMPLOYEE_ID | email> <PIN>
 *
 * Examples:
 *   node create-operator.mjs TC01 493817
 *   node create-operator.mjs tanya.clark0071@gmail.com 493817
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
  if (!who || !pin) die('Usage: node create-operator.mjs <EMPLOYEE_ID | email> <PIN>');
  if (!/^\d{6,}$/.test(pin)) die('PIN must be all digits and at least 6 long.');

  const email = who.includes('@') ? who.toLowerCase() : EMPLOYEE_ID_TO_EMAIL[who.toUpperCase()];
  if (!email) die(`Unknown Employee ID "${who}". Known: ${Object.keys(EMPLOYEE_ID_TO_EMAIL).join(', ')} (or pass a full email).`);

  initializeApp({ credential: cert(loadServiceAccount()) });
  const auth = getAuth();

  try {
    const existing = await auth.getUserByEmail(email).catch(() => null);
    if (existing) {
      console.log(`\nAccount already exists for ${email} (uid ${existing.uid}).`);
      console.log(`Use reset-pin.mjs to change its PIN instead.\n`);
      return;
    }
    const user = await auth.createUser({ email, password: pin, emailVerified: false, disabled: false });
    console.log(`\n✔ Created ${email}`);
    console.log(`  uid: ${user.uid}`);
    console.log(`  Sign in with the matching Employee ID and the PIN you just set.\n`);
  } catch (err) {
    die(`Create failed: ${err.message || err}`);
  }
}

main();
