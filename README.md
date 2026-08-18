# Naukri Profile Refresh

Keeps your Naukri profile "recently updated" — recruiters see fresh profiles first.
Every run it toggles a trailing `.` on your **resume headline**, which counts as a
profile update on Naukri. Schedule it hourly and forget about it.

- Logs in automatically with your **Google account** (session is saved after the first login).
- Runs in an off-screen Chrome window (Naukri blocks headless browsers).
- Verifies the save actually stuck on the server before reporting success.
- All personal data lives in `.env` — nothing sensitive is in the code.

## Requirements

- Windows 10/11 (uses Task Scheduler for the hourly run)
- [Node.js](https://nodejs.org/) 18+
- Google Chrome installed
- A Naukri account that signs in with Google

## Setup

**1. Clone and install:**

```powershell
git clone https://github.com/ankitbaghel01/naukri_update.git
cd naukri_update
npm install
```

**2. Create your `.env`:**

```powershell
copy .env.example .env
```

Open `.env` and fill in at least:

| Variable | What it is |
|---|---|
| `GOOGLE_EMAIL` | The Google account your Naukri profile uses |
| `GOOGLE_PASSWORD` | Its password (used only for the automated sign-in) |
| `NAUKRI_PROFILE_URL` | Your Naukri profile page — the default `https://www.naukri.com/mnjuser/profile` works for every account |

`.env` is git-ignored, so your credentials never get pushed.

**3. First login (one time, visible browser):**

```powershell
node naukri-profile-refresh.js login
```

A Chrome window opens and signs in with Google. If Google asks for 2-step
verification, approve it once — the session is saved to `.naukri-chrome-profile/`
and reused by every later run.

**4. Test a silent run:**

```powershell
node naukri-profile-refresh.js
```

Check `naukri-refresh.log` — you should see a line like:

```
[27/7/2026, 1:05:12 pm] OK: headline dot added (verified) → "AI Full Stack Developer | ..."
```

## Run it hourly (Task Scheduler)

Run this once in PowerShell (adjust the path to where you cloned the repo):

```powershell
$repo = "C:\path\to\auto-apply"
$action  = New-ScheduledTaskAction -Execute "node.exe" -Argument "`"$repo\naukri-profile-refresh.js`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "NaukriProfileRefresh" -Action $action -Trigger $trigger -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
```

That's it — the script now refreshes your profile every hour while your PC is on.

Useful commands:

```powershell
Get-ScheduledTask NaukriProfileRefresh            # check status
Start-ScheduledTask NaukriProfileRefresh          # run now
Disable-ScheduledTask NaukriProfileRefresh        # pause
Enable-ScheduledTask NaukriProfileRefresh         # resume
Unregister-ScheduledTask NaukriProfileRefresh     # remove
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Google login did not complete` in the log | Run `node naukri-profile-refresh.js login` and approve the 2-step verification prompt once manually. |
| `save did not stick` in the log | Naukri changed its headline editor — open an issue. |
| Any other error | Check `naukri-refresh-error-*.png` screenshots in the repo folder — they show exactly what the browser saw when it failed. |
| Want to start fresh | Delete the `.naukri-chrome-profile/` folder and run the `login` step again. |

## Files

| File | Purpose |
|---|---|
| `naukri-profile-refresh.js` | The refresh script |
| `config.js` | Loads `.env` (no dependencies) |
| `.env.example` | Template — copy to `.env` and fill in |
| `naukri-refresh.log` | Run history (git-ignored) |
| `.naukri-chrome-profile/` | Saved Chrome session (git-ignored) |

## Auto-Apply Engine (6 Portals: Naukri, Internshala, LinkedIn, Indeed, Wellfound, Foundit)

Automatically searches for jobs and internships matching your profile across 6 top platforms, extracts Job Descriptions, calculates match scores, selects your tailored resume PDF, and applies automatically.

### Commands:

| Command | Action |
|---|---|
| `npm run apply:all:dry` | **All Portals Dry Run** — crawls & scores across all 6 portals without submitting |
| `npm run apply:all` | **All Portals Live** — applies across all 6 portals & dispatches the daily email report |
| `npm run apply:naukri` | **Naukri Only** — crawl & apply on Naukri.com |
| `npm run apply:internshala` | **Internshala Only** — crawl & apply on Internshala internships |
| `npm run apply:linkedin` | **LinkedIn Only** — crawl Easy Apply roles on LinkedIn |
| `npm run apply:indeed` | **Indeed Only** — crawl & match Indeed India jobs |
| `npm run apply:wellfound` | **Wellfound Only** — crawl startup engineering jobs & internships |
| `npm run apply:foundit` | **Foundit Only** — crawl tech openings on Foundit (Monster) |
| `npm run apply:history` | **View Applied Jobs Table** — prints unified terminal table of all applied jobs |

### End-of-Day Email Digest (`mailer.js`)

At the end of every day (8:00 PM), a scheduled Windows task compiles all applications submitted across all portals and sends an HTML digest to `adityamittha09@gmail.com`.

| Command | Action |
|---|---|
| `npm run mail:preview` | **Preview Report Locally** — generates `daily-report-preview.html` to view in your browser |
| `npm run mail:report` | **Send Report Now** — emails the daily digest to your inbox |
| `npm run task:mail:status` | **Check Mailer Task** — checks the scheduled daily 8:00 PM mailer task state |

### Configuration (`.env`):

```env
# Email Digest Configuration
REPORT_EMAIL_TO=adityamittha09@gmail.com
SMTP_USER=adityamittha09@gmail.com
SMTP_PASS=your-gmail-app-password

# Auto-Apply Keywords & Locations
AUTO_APPLY_KEYWORDS=Embedded Systems Intern, Firmware Engineer, Python Developer, IoT Intern, Embedded C
AUTO_APPLY_LOCATIONS=Pune, Remote, Solapur, Bangalore, Hyderabad
AUTO_APPLY_EXPERIENCE=0
AUTO_APPLY_MIN_MATCH_SCORE=50
AUTO_APPLY_MAX_PER_RUN=10
DRY_RUN=false
```

### Resume Tailoring Logic:
- **Embedded / Firmware Roles** → Automatically attaches `resume/Mittha_Aditya_Embedded.pdf` (ARM Cortex-M, ESP32, FreeRTOS, Embedded C, UART/SPI/I2C/CAN/MQTT, AQUANOVA, SORTIFY).
- **Python / Cloud / DevOps Roles** → Automatically attaches `resume/Mittha_Aditya.pdf` (Python, AWS Lambda/DynamoDB, Docker, CI/CD, LabPulse).
- **Recruiter Screening Questions** → Automatically answered using your credentials and project achievements.
- **Application History** → Stored in `applied-jobs.json` to prevent applying twice to the same posting.

## Disclaimer

Automating your own profile and applications may be subject to platform guidelines. The engine uses human-like randomized delays and daily application caps, but use responsibly.


