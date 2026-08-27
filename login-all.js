/**
 * Interactive Login Manager for All 6 Job Portals.
 * Launches visible Chrome browsers for each portal, allowing one-time authentication
 * and saving persistent cookies so you never get prompted again.
 */
const { chromium } = require('playwright-core');
const path = require('path');
const readline = require('readline');
const { CREDS } = require('./config');

const PORTALS = [
  {
    name: 'Naukri',
    url: 'https://www.naukri.com/nlogin/login?URL=https://www.naukri.com/mnjuser/profile',
    checkUrl: 'https://www.naukri.com/mnjuser/profile',
    profileDir: path.join(__dirname, '.naukri-chrome-profile'),
    isLoggedIn: (url) => url.includes('/mnjuser'),
  },
  {
    name: 'Internshala',
    url: 'https://internshala.com/login/user',
    checkUrl: 'https://internshala.com/student/dashboard',
    profileDir: path.join(__dirname, '.internshala-chrome-profile'),
    isLoggedIn: (url) => url.includes('/student/dashboard') || url.includes('/user_preference'),
  },
  {
    name: 'LinkedIn',
    url: 'https://www.linkedin.com/login',
    checkUrl: 'https://www.linkedin.com/feed/',
    profileDir: path.join(__dirname, '.linkedin-chrome-profile'),
    isLoggedIn: (url) => url.includes('/feed') || url.includes('/jobs'),
  },
  {
    name: 'Indeed',
    url: 'https://secure.indeed.com/auth',
    checkUrl: 'https://in.indeed.com/',
    profileDir: path.join(__dirname, '.indeed-chrome-profile'),
    isLoggedIn: (url) => !url.includes('/auth') && !url.includes('/login'),
  },
  {
    name: 'Wellfound',
    url: 'https://wellfound.com/login',
    checkUrl: 'https://wellfound.com/jobs',
    profileDir: path.join(__dirname, '.wellfound-chrome-profile'),
    isLoggedIn: (url) => url.includes('/jobs') || url.includes('/overview'),
  },
  {
    name: 'Foundit',
    url: 'https://www.foundit.in/seeker/login',
    checkUrl: 'https://www.foundit.in/seeker/dashboard',
    profileDir: path.join(__dirname, '.foundit-chrome-profile'),
    isLoggedIn: (url) => url.includes('/seeker/dashboard') || url.includes('/seeker/profile'),
  },
];

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

async function loginPortal(portal) {
  console.log(`\n=======================================================`);
  console.log(`🔐 [${portal.name}] Launching browser for one-time login...`);
  console.log(`📁 Profile Directory: ${portal.profileDir}`);
  console.log(`=======================================================`);

  const IS_LINUX = process.platform === 'linux';
  const ctx = await chromium.launchPersistentContext(portal.profileDir, {
    channel: IS_LINUX ? 'chromium' : 'chrome',
    headless: false,
    viewport: { width: 1280, height: 850 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      ...(IS_LINUX ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []),
    ],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    // 1. Check if already logged in
    await page.goto(portal.checkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    if (portal.isLoggedIn(page.url())) {
      console.log(`✅ Already authenticated on ${portal.name}! Session is active.`);
    } else {
      console.log(`👉 Please complete login in the opened Chrome window for ${portal.name}.`);
      console.log(`   (You can use Email + Password or Google SSO. Your credentials will be remembered permanently.)`);

      await page.goto(portal.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

      // Autofill email/password if inputs are present
      try {
        const emailInput = page.locator('input#usernameField, input#email, input#session_key, input[type="email"], input[name="email"], input[name="identifier"]').first();
        const passInput = page.locator('input#passwordField, input#password, input#session_password, input[type="password"]').first();
        if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          await emailInput.fill(CREDS.email);
        }
        if (await passInput.isVisible({ timeout: 3000 }).catch(() => false) && CREDS.password) {
          await passInput.fill(CREDS.password);
        }
      } catch {}

      // Wait for login or manual enter
      console.log(`\n⏳ Press ENTER in this terminal once you have completed login on ${portal.name}...`);
      await askQuestion('   [Press Enter when done] ');

      console.log(`✅ Session saved for ${portal.name}!`);
    }
  } catch (err) {
    console.error(`❌ Error during ${portal.name} login:`, err.message);
  } finally {
    await ctx.close().catch(() => {});
    console.log(`🔒 Browser closed for ${portal.name}. Cookies stored permanently.\n`);
  }
}

(async () => {
  const targetPortalArg = process.argv[2];

  console.log(`\n*******************************************************`);
  console.log(`🔑 Unified Portal Login Manager`);
  console.log(`*******************************************************`);

  if (targetPortalArg && targetPortalArg !== 'all') {
    const matched = PORTALS.find(p => p.name.toLowerCase() === targetPortalArg.toLowerCase());
    if (matched) {
      await loginPortal(matched);
      process.exit(0);
    }
  }

  for (const portal of PORTALS) {
    await loginPortal(portal);
  }

  console.log(`\n🎉 All portal sessions successfully configured and saved!`);
  console.log(`💡 Next step: Run "npm run sync:ec2" to upload authenticated profiles to your cloud instance.`);
  process.exit(0);
})();
