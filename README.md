# Naukri Profile Refresh

Keeps your Naukri profile marked **"recently updated"** automatically. Each run
opens your Naukri profile and toggles a trailing `.` on the resume headline —
headline ends with a dot → remove it, otherwise add it. Recruiters sorting by
"recently active" always see your profile near the top.

Every run verifies the save actually stuck by reloading the profile from the
server. Login is automatic (Google sign-in) with a persistent Chrome profile,
so you only approve 2-step verification once.

## Prerequisites

- **Node.js 18+** (with npm)
- **Google Chrome** installed (the script drives your real Chrome — Naukri's
  bot-check blocks headless browsers)
- **Windows 10/11** (for the hidden-launcher automation; the script itself is cross-platform)
- A **Naukri account linked to Google sign-in** (the auto-login uses the
  "Sign in with Google" button)

## Setup

```bash
git clone https://github.com/ankitbaghel01/naukri_update.git
cd naukri_update
npm install

# create your .env from the template:
copy .env.example .env     # Windows (cmd)
cp .env.example .env       # macOS / Linux / Git Bash
```

Open `.env` and fill in **GOOGLE_EMAIL** and **GOOGLE_PASSWORD** — that's all
this script needs. (The other fields in the template are used by companion
auto-apply scripts and can be left as-is.)

First run — visible browser window so you can approve Google 2-step
verification once:

```bash
npm run login
```

After that, the session is saved in `.naukri-chrome-profile/` and every
future run is fully automatic:

```bash
npm run refresh
```

## Automate — refresh every hour (Windows Task Scheduler)

1. Open `naukri-refresh-hidden.vbs` and edit the two paths at the top
   (your `node.exe` location and where you cloned this repo).
2. Open **Task Scheduler** (Win+R → `taskschd.msc`).
3. **Create Basic Task** → name it "Naukri Refresh".
4. Trigger: **Daily**, then after finishing open the task → **Triggers** tab →
   Edit → check **Repeat task every: 1 hour** for a duration of **Indefinitely**.
5. Action: **Start a program** →
   - Program/script: `wscript.exe`
   - Arguments: `"C:\path\to\naukri_update\naukri-refresh-hidden.vbs"`
6. Save. The script now runs hourly with **no visible window** — Chrome runs
   headed but positioned off-screen.

## Logs & troubleshooting

- Every run appends to `naukri-refresh.log`:
  `OK: headline dot added (verified) → "..."`
- Task Scheduler runs also capture console output in `naukri-launcher.log`
  (useful when the script crashes before it can write its own log).
- Failures save screenshots as `naukri-refresh-error-*.png`.
- If login breaks (e.g. Google asks for verification again), run
  `npm run login` once and approve it manually.

## Files

| File | Purpose |
|------|---------|
| `naukri-profile-refresh.js` | The refresh script (dot toggle + auto-login + save verification) |
| `config.js` | Loads credentials from `.env` — nothing sensitive lives in code |
| `.env.example` | Template — copy to `.env` and fill in |
| `naukri-refresh-hidden.vbs` | Hidden launcher for Task Scheduler (no console window) |
