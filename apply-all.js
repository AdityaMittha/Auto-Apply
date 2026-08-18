/**
 * Apply-All Multi-Portal Runner — Runs Naukri & Internshala application engines
 * and dispatches the daily email summary report to your inbox.
 */
const { spawn } = require('child_process');
const path = require('path');
const { sendDailyReport } = require('./mailer');

function runScript(scriptName, args = []) {
  return new Promise((resolve) => {
    console.log(`\n=======================================================`);
    console.log(`🚀 Launching: node ${scriptName} ${args.join(' ')}`);
    console.log(`=======================================================`);

    const p = spawn('node', [path.join(__dirname, scriptName), ...args], {
      stdio: 'inherit',
      cwd: __dirname,
    });

    p.on('close', (code) => {
      console.log(`\n✅ ${scriptName} exited with code ${code}`);
      resolve(code);
    });

    p.on('error', (err) => {
      console.error(`❌ Failed to run ${scriptName}:`, err);
      resolve(1);
    });
  });
}

(async () => {
  const args = process.argv.slice(2);

  // 1. Run Naukri Engine
  await runScript('naukri-auto-apply.js', args);

  // 2. Run Internshala Engine
  await runScript('internshala-apply.js', args);

  // 3. Run LinkedIn Engine
  await runScript('linkedin-apply.js', args);

  // 4. Run Indeed Engine
  await runScript('indeed-apply.js', args);

  // 5. Run Wellfound (AngelList) Engine
  await runScript('wellfound-apply.js', args);

  // 6. Run Foundit Engine
  await runScript('foundit-apply.js', args);

  // 7. Send Consolidated Daily Email Digest
  console.log(`\n=======================================================`);
  console.log(`📧 Sending Daily Summary Email Digest to adityamittha09@gmail.com...`);
  console.log(`=======================================================`);
  await sendDailyReport();

  console.log(`\n🎉 All 6 portal sweeps & daily email digest completed!`);
})();
