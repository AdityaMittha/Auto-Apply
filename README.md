# 🚀 Auto-Apply & Resume Tailoring Engine

An autonomous, multi-portal job search, dynamic LaTeX resume tailoring, and application tracking system built for **Aditya Mittha** (Final-Year B.Tech E&TC, Walchand Institute of Technology — 9.27 CGPA).

The bot runs 24/7 in the cloud on AWS EC2, continuously monitoring 6 major job portals, tailoring ATS-optimized resumes with zero AI footprints, checking recruiter application status, sending cold outreach emails, and dispatching a consolidated daily digest at 8:00 PM IST.

---

## 🌟 Key Features

### 1. 🗺️ Multi-Portal Auto-Apply (6 Platforms)
Crawls and applies to jobs and internships matching your profile across:
- **Naukri.com** — Easy Apply & recruiter search
- **Internshala** — Student internship applications
- **LinkedIn** — Easy Apply search & detail crawler
- **Indeed India** — Tech listings with automated screening answers
- **Wellfound (AngelList)** — Early-stage tech & hardware startup roles
- **Foundit (Monster India)** — Engineering & developer listings

### 2. 📍 Strict Location Filter
- Enforces applications **ONLY** in **Pune**, **Remote / Work from Home**, and **Solapur**.
- Automatically skips jobs in other cities before loading full detail pages to conserve bandwidth and system memory.

### 3. 📄 Dynamic LaTeX Resume Compiler (`resume-compiler.js`)
- Compiles custom, ATS-optimized PDF resumes on-the-fly for **every single application** using `pdflatex` (TeX Live).
- **Anti-AI Humanized Style**: Uses `gemini-3.6-flash` with strict anti-AI guardrails (banning corporate buzzwords like *spearheaded*, *testament*, *delve*, *tapestry*, *synergy*) to craft 100% authentic, metric-driven summaries and skills highlighting your real achievements (9.27 CGPA, ESP32, FreeRTOS, Embedded C, Python, AWS, UART/I2C/CAN).
- Tailors:
  - **Summary**: Direct 2–3 sentence technical pitch tailored to the target JD.
  - **Skills**: Dynamically re-orders and includes exact matching JD keywords.
  - **Projects**: Highlights relevant achievements (Codec Technologies internship, LabPulse, AQUANOVA, SORTIFY).

### 4. ☁️ Amazon S3 Storage Integration (`s3-storage.js`)
- Automatically uploads tailored resumes and `applied-jobs.json` backups to Amazon S3 (`auto-apply-aditya-mittha`).
- Generates secure, 7-day pre-signed download URLs for one-click access.

### 5. 🔍 Application Status Tracker (`status-tracker.js`)
- Periodically revisits application boards on Naukri, Internshala, and LinkedIn.
- Scrapes live application status (*Applied*, *Viewed by Recruiter*, *Recruiter Action*, *Shortlisted*) and extracts recruiter names/emails.

### 6. ✉️ Automated Recruiter Cold Outreach (`cold-mailer.js`)
- Identifies newly discovered recruiter emails and generates concise (3–4 sentence) formal cold outreach emails.
- Attaches the tailored resume PDF for that specific role.
- Equipped with anti-spam safeguards (max 10 cold emails/day).

### 7. 📧 Daily 8:00 PM IST Email Digest (`mailer.js`)
- Sends a clean, beautiful HTML digest every day at **8:00 PM IST** to `adityamittha09@gmail.com`.
- Contains live stats, match percentages, category breakdowns, and direct clickable `[View Resume ↗]` links (no heavy attachments).

### 8. 🔄 Naukri Profile Refresh (`naukri-profile-refresh.js`)
- Runs hourly to toggle a trailing dot on your Naukri headline, keeping your profile at the top of recruiter search results 24/7.

---

## 🏗️ Architecture & Cron Schedule

```
                    ┌─────────────────────────┐
                    │      AWS EC2 Server     │
                    │  (Amazon Linux 2023)    │
                    └────────────┬────────────┘
                                 │
   ┌─────────────────────────────┼─────────────────────────────┐
   │ (Every Hour)                │ (Every 10 Mins)             │ (Daily 6:00 PM IST)
   ▼                             ▼                             ▼
Profile Refresh             Apply-All (6 Portals)         Status Tracker
(Keep Naukri Active)        - Location Filter             (Scrapes Viewed / Shortlisted)
                            - Gemini 3.6 Flash Tailor     (Extracts Recruiter Emails)
                            - pdflatex Compile to PDF
                            - Amazon S3 Backup
                                 │                             │
                                 │ (Daily 7:30 PM IST)         ▼ (Daily 6:30 PM IST)
                                 │ S3 Resume Sync              Cold Outreach Mailer
                                 │                             (Tailored Recruiter Email)
                                 ▼
                    ┌─────────────────────────┐
                    │   8:00 PM IST Digest    │
                    │   HTML Summary Email    │
                    │ (Clickable S3 PDF Links)│
                    └─────────────────────────┘
```

### Automated EC2 Cron Schedule (IST = UTC + 5:30)

| Time (IST) | Cron Expression | Script / Task | Description |
|---|---|---|---|
| **Every hour** | `0 * * * *` | `./run.sh refresh` | Toggles headline dot to keep Naukri profile fresh |
| **Every 10 min** | `*/10 * * * *` | `./run.sh apply:all` | Crawls & applies across all 6 portals (Pune/Remote only) |
| **6:00 PM** | `30 12 * * *` | `./run.sh status:check` | Scrapes application tracker status across portals |
| **6:30 PM** | `00 13 * * *` | `./run.sh cold:mail` | Sends personalized cold emails to discovered recruiters |
| **7:30 PM** | `00 14 * * *` | `./run.sh s3:sync` | Syncs tailored resumes and database to S3 |
| **8:00 PM** | `30 14 * * *` | `./run.sh mail:report` | Dispatches daily consolidated HTML summary email |

---

## 🛠️ CLI Commands & Usage

### 🚀 Application Commands
```bash
# Run all 6 portals in live mode
npm run apply:all

# Run all 6 portals in dry-run mode (safe preview)
npm run apply:all:dry

# Run individual portals
npm run apply:naukri
npm run apply:internshala
npm run apply:linkedin
npm run apply:indeed
npm run apply:wellfound
npm run apply:foundit

# View application history table in terminal
npm run apply:history
```

### 📧 Mailer & Outreach Commands
```bash
# Preview the daily HTML email report in your browser
npm run mail:preview

# Send daily email digest immediately
npm run mail:report

# Check application status across portals
npm run status:check

# Run recruiter cold outreach (dry run)
npm run cold:mail:dry

# Run recruiter cold outreach (live)
npm run cold:mail

# Sync tailored resumes and data to S3
npm run s3:sync
```

---

## ⚙️ Configuration (`.env`)

Copy `.env.example` to `.env` and configure your credentials:

```env
# Google Account (Used for Naukri automated login)
GOOGLE_EMAIL=***********@gmail.com
GOOGLE_PASSWORD=your-password
NAUKRI_PROFILE_URL=https://www.naukri.com/mnjuser/profile

# Candidate Profile
NAME=Aditya Mittha
EMAIL=************@gmail.com
PHONE=+91 *********
LOCATION=Solapur, India
EDUCATION=Bachelor's Degree in Electronics and Telecommunication
SKILLS=Embedded C, Python, FreeRTOS, ARM Cortex-M, ESP32, Raspberry Pi, UART, SPI, I2C, CAN, MQTT, AWS, Docker, Linux, Git

# Gemini AI (Resume Tailoring & Screening Answers)
GEMINI_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-3.6-flash
AI_ENABLED=true

# Email Digest & Cold Outreach Settings
REPORT_EMAIL_TO=***********@gmail.com
SMTP_USER=********@gmail.com
SMTP_PASS=your-gmail-app-password
COLD_EMAIL_ENABLED=true
COLD_EMAIL_MAX_PER_DAY=10

# Search & Location Filters
AUTO_APPLY_KEYWORDS=Embedded Systems Intern, Firmware Engineer, Python Developer, IoT Intern, Embedded C
AUTO_APPLY_LOCATIONS=Pune, Remote, Solapur
ALLOWED_LOCATIONS=Pune, Remote, Solapur, Work from Home, WFH, Anywhere
AUTO_APPLY_EXPERIENCE=0
AUTO_APPLY_MAX_PER_RUN=10
AUTO_APPLY_MIN_MATCH_SCORE=50
DRY_RUN=false

# Amazon S3 Storage
S3_BUCKET_NAME=auto-apply
AWS_REGION=ap-south-1
```

---

## 📂 Project Structure

```
├── .env.example             # Environment variable template
├── apply-all.js             # Master runner for all 6 portals
├── career-page-engine.js    # Direct company career portal / ATS application engine
├── config.js                # Central configuration & location filter helper
├── cron-setup.sh            # Automated crontab installer for EC2
├── dashboard-server.js      # Web Dashboard Express backend & API
├── deploy-aws.sh            # Infrastructure provisioning script
├── deploy-s3.sh             # Amazon S3 bucket setup script
├── health-check.sh          # System health and process monitor
├── login-all.js             # One-click portal login & session manager
├── mailer.js                # HTML email digest builder & sender
├── naukri-auto-apply.js     # Naukri auto-apply engine
├── internshala-apply.js     # Internshala auto-apply engine
├── linkedin-apply.js        # LinkedIn Easy Apply engine
├── indeed-apply.js          # Indeed auto-apply engine
├── foundit-apply.js         # Foundit (Monster) auto-apply engine
├── wellfound-apply.js       # Wellfound (AngelList) auto-apply engine
├── naukri-profile-refresh.js# Hourly Naukri bump script
├── resume-compiler.js       # Dynamic LaTeX compiler & S3 uploader
├── s3-storage.js            # Amazon S3 storage & presigned URL helper
├── server-setup.sh          # Full EC2 server bootstrap & dependencies setup
├── start-xvfb.sh            # Xvfb virtual display helper
├── status-tracker.js        # Portal application status scraper
├── tailor-engine.js         # Hybrid keyword + AI scoring engine
├── gemini-ai.js             # Anti-AI humanized prompt engine (Gemini Flash)
├── cold-mailer.js           # Automated recruiter cold emailer
├── verify-applied-jobs.js   # Live website application verification engine
├── run.sh                   # Headless Xvfb execution wrapper
├── transfer-data.ps1        # Sync data and browser profiles to EC2 (PowerShell)
├── transfer-data.sh         # Sync data and browser profiles to EC2 (Bash)
├── package.json             # NPM scripts & dependencies
├── docs/                    # Architecture & system design documentation
│   ├── PROJECT_DOCUMENTATION.md
│   └── AI_Job_Search_Automation_System.pdf
├── public/                  # Web Dashboard frontend assets
│   ├── index.html
│   ├── css/dashboard.css
│   └── js/
│       ├── components.js
│       └── dashboard.js
├── resume/                  # LaTeX resume templates & canonical fallback PDFs
│   ├── Aditya_Mittha_Embedded.tex
│   ├── Aditya_Mittha_Embedded_Software.tex
│   ├── Aditya_Mittha_Data_Analytics.tex
│   ├── Aditya_Mittha.tex
│   ├── Mittha_Aditya_Embedded.pdf
│   ├── Mittha_Aditya_Embedded_Software.pdf
│   ├── Mittha_Aditya_Data_Analytics.pdf
│   ├── Mittha_Aditya.pdf
│   └── tailored/            # Dynamically compiled per-job PDFs (gitignored)
└── applied-jobs.json        # Database of submitted applications & statuses
```

---

## 🛡️ Best Practices & Anti-Bot Protection

- **Randomized Delays**: Human-like randomized pacing (6–12s) between applications to prevent portal rate-limiting.
- **Headless Xvfb**: Real Chromium browser instances run inside a virtual frame buffer (`:99`) to bypass headless browser detection.
- **Deduplication**: Every application is indexed by URL/Job ID in `applied-jobs.json` to prevent applying twice to the same job.
- **Rate-Limited Cold Outreach**: Strict 10-email/day cap with anti-spam delays to protect your sender domain reputation.

---

## 📄 License

ISC © Aditya Mittha
