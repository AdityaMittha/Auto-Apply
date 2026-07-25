# Naukri Profile Refresh

Keeps your Naukri profile marked "recently updated" by toggling a trailing `.`
on the resume headline — headline ends with a dot → remove it, otherwise add it.
Each run verifies the save actually stuck by reloading the profile from the server.

Handles login automatically (Google sign-in) with a persistent Chrome profile,
so you only approve 2-step verification once.

## Setup

```bash
npm install
cp .env.example .env   # fill in GOOGLE_EMAIL / GOOGLE_PASSWORD
node naukri-profile-refresh.js login   # first run: visible window, approve login once
```

## Automate (hourly)

Edit the paths in `naukri-refresh-hidden.vbs`, then add it to Windows Task
Scheduler on an hourly trigger. Chrome runs headed but off-screen (Naukri's
bot-check blocks headless), so nothing pops up.

Runs are logged to `naukri-refresh.log`; failures leave `naukri-refresh-error-*.png` screenshots.
