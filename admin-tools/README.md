# SWR Tracker — admin tools

Local-only utilities that talk to the Firebase project with **admin** privileges.
These are **not** part of the app and are never used by the deployed site — they
run on your Mac from the terminal.

## `reset-pin.mjs` — set an operator's PIN directly

Use this when the in-app **"Email me a reset link"** button (or the Firebase
console password reset) can't be used — e.g. the account's mailbox doesn't
receive mail. It sets the account password (the "PIN") directly.

### One-time setup

1. **Download a service-account key** (this is a secret — treat it like a password):
   - Firebase console → project **swr-tracker-54dfd** → ⚙ **Project settings**
     → **Service accounts** tab → **Generate new private key** → **Generate key**.
   - Save the downloaded file as:
     ```
     admin-tools/serviceAccountKey.json
     ```
   - It's already in `.gitignore`, so it won't be committed. **Never** commit it
     or paste it anywhere — anyone with this key has full admin access to the
     project.

2. **Install dependencies** (needs Node 18+):
   ```
   cd ~/swr-tracker/admin-tools
   npm install
   ```

### Reset a PIN

```
node reset-pin.mjs <EMPLOYEE_ID | email> <new-PIN>
```

Examples:
```
node reset-pin.mjs JG01 481920
node reset-pin.mjs jon@southern-wildlife.com 481920
```

- PIN must be **all digits, at least 6 long** (the app uses 6-digit PINs; Firebase
  requires a 6-character minimum password).
- Known Employee IDs: `JG01` (Jon), `RG01` (Robin), `CG01` (Chris). You can also
  pass a full email.

On success it prints the account UID and confirms the reset. Then sign in on the
device with that Employee ID and the new PIN.

### When you're done

Delete the key so it isn't sitting on disk:
```
rm admin-tools/serviceAccountKey.json
```

You can regenerate a new one from the console any time you need to run this again.
(If a key is ever exposed, revoke it in the Service accounts tab.)
