// ============================================================
// VF Limit Bot - GitHub Actions Playwright Script
// Login to admin → Update limits → Screenshot → Send to CS group
// ============================================================

const { chromium } = require('playwright');
const fetch = require('node-fetch');
const FormData = require('form-data');

const ADMIN_URL = 'https://admin7777777.voteflux.com';
const FIAT_URL = `${ADMIN_URL}/zh/fiat-settings`;

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CS_GROUP_ID = process.env.CS_GROUP_ID;

const payload = JSON.parse(process.env.PAYLOAD || '{}');
const {
  uid, currency, deposit_min, deposit_max,
  gp_withdraw_min, gp_withdraw_max, withdraw_unavailable,
  callbackUrl, replyToMsgId,
} = payload;

async function main() {
  console.log(`[${uid}] Starting update for ${currency}...`);
  console.log(`[${uid}] Deposit: ${deposit_min} - ${deposit_max}`);
  console.log(`[${uid}] Withdraw GP: ${gp_withdraw_min} - ${gp_withdraw_max}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const changes = [];

  try {
    // ---- Step 1: Login ----
    console.log(`[${uid}] Navigating to admin panel...`);
    await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

    const loginForm = await page.$('input[type="password"]');
    if (loginForm) {
      console.log(`[${uid}] Login required, logging in...`);
      const emailInput = await page.$('input[type="email"], input[type="text"], input[name="email"], input[name="username"]');
      const passInput = await page.$('input[type="password"]');
      if (emailInput) await emailInput.fill(ADMIN_USER);
      if (passInput) await passInput.fill(ADMIN_PASS);

      const loginBtn = await page.$('button[type="submit"], button:has-text("登入"), button:has-text("Login"), button:has-text("登录")');
      if (loginBtn) await loginBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // ---- Step 2: Navigate to fiat-settings ----
    console.log(`[${uid}] Navigating to fiat settings...`);
    await page.goto(FIAT_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // ---- Step 3: Switch to currency tab ----
    console.log(`[${uid}] Switching to ${currency} tab...`);
    const tabBtn = await page.$(`button:has-text("${currency}")`);
    if (!tabBtn) throw new Error(`Cannot find ${currency} tab button`);
    await tabBtn.click();
    await page.waitForTimeout(1500);

    // ---- Step 4: Read all input fields ----
    const inputData = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="number"]'));
      return inputs.map((inp, idx) => {
        let label = '';
        let p = inp.parentElement;
        while (p && !label) {
          const labs = p.querySelectorAll('label');
          if (labs.length === 1) label = labs[0].innerText.trim();
          if (label) break;
          p = p.parentElement;
          if (p === document.body) break;
        }
        let section = '';
        let curr = inp;
        for (let j = 0; j < 20; j++) {
          curr = curr.parentElement;
          if (!curr) break;
          const heads = curr.querySelectorAll(':scope > h3, :scope > h2, :scope > div > h3');
          for (const h of heads) {
            const t = h.innerText.trim();
            if (t.length < 50) { section = t; break; }
          }
          if (section) break;
        }
        return { idx, value: inp.value, label, section };
      });
    });

    console.log(`[${uid}] Found ${inputData.length} input fields`);

    // ---- Step 5: Determine which fields to update ----
    const updates = getFieldUpdates(currency, inputData);
    if (updates.length === 0) {
      console.log(`[${uid}] No changes needed`);
      // Scroll to show full page and take screenshot
      await page.waitForTimeout(500);
      const caption = `✅ ${currency} — No changes needed, values are already correct.\n⏱ ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
      await sendScreenshotWithCaption(page, caption);
      return;
    }

    // ---- Step 6: Update fields one by one ----
    for (const u of updates) {
      console.log(`[${uid}] Updating field ${u.idx}: ${u.oldVal} → ${u.newVal} (${u.field})`);

      await page.evaluate(({ idx, val }) => {
        const inputs = Array.from(document.querySelectorAll('input[type="number"]'));
        const inp = inputs[idx];
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inp, val);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
      }, { idx: u.idx, val: String(u.newVal) });

      await page.waitForTimeout(500);

      // Click save button next to field
      await page.evaluate((idx) => {
        const inputs = Array.from(document.querySelectorAll('input[type="number"]'));
        const inp = inputs[idx];
        let p = inp.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!p) break;
          const btn = Array.from(p.querySelectorAll('button')).find(b => b.innerText.trim() === '储存');
          if (btn) { btn.click(); return; }
          p = p.parentElement;
        }
      }, u.idx);

      await page.waitForTimeout(1500);

      // Confirm dialog
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.trim() === '储存');
        if (btns.length > 0) btns[btns.length - 1].click();
      });

      await page.waitForTimeout(2000);
      changes.push({ field: u.field, oldVal: u.oldVal, newVal: u.newVal });
    }

    // ---- Step 7: Screenshot + Report (one message, reply to original) ----
    console.log(`[${uid}] Taking screenshot and sending report...`);
    await page.waitForTimeout(1000);

    // Scroll to show the full currency section
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // Build caption with changes
    let caption = `✅ ${currency} Limit Update Completed\n━━━━━━━━━━━━━━━━━━\n\n`;
    for (const c of changes) {
      caption += `${c.field}: ${c.oldVal} → ${c.newVal} ✅\n`;
    }
    caption += `\n⏱ ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

    await sendScreenshotWithCaption(page, caption);

    console.log(`[${uid}] Done!`);

  } catch (err) {
    console.error(`[${uid}] Error:`, err);
    try {
      const caption = `❌ ${currency} Update Failed\n\nError: ${err.message}`;
      await sendScreenshotWithCaption(page, caption);
    } catch (e) {
      // If screenshot also fails, report via callback
      await reportCompletion({ uid, success: false, message: err.message, replyToMsgId });
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ---- Determine which fields to update ----
function getFieldUpdates(cur, inputData) {
  const updates = [];
  const target = { deposit_min, deposit_max, gp_withdraw_min, gp_withdraw_max, withdraw_unavailable };

  if (cur === 'INR') {
    const minDep = inputData.find(i => i.section.includes('INR') && i.section.includes('GP') && i.label.includes('最低金额'));
    const maxDep = inputData.find(i => i.section.includes('INR') && i.section.includes('GP') && i.label.includes('最高金额'));
    const minGP = inputData.find(i => i.section.includes('GP') && i.section.includes('INR') && i.label.includes('最低') && i.label.includes('GP'));
    const maxGP = inputData.find(i => i.section.includes('GP') && i.section.includes('INR') && i.label.includes('最高') && i.label.includes('GP'));

    if (minDep && Number(minDep.value) !== target.deposit_min) updates.push({ idx: minDep.idx, field: 'INR→GP Min Deposit', oldVal: minDep.value, newVal: target.deposit_min });
    if (maxDep && Number(maxDep.value) !== target.deposit_max) updates.push({ idx: maxDep.idx, field: 'INR→GP Max Deposit', oldVal: maxDep.value, newVal: target.deposit_max });
    if (!target.withdraw_unavailable && target.gp_withdraw_min !== null) {
      if (minGP && Number(minGP.value) !== target.gp_withdraw_min) updates.push({ idx: minGP.idx, field: 'GP→INR Min GP', oldVal: minGP.value, newVal: target.gp_withdraw_min });
      if (maxGP && Number(maxGP.value) !== target.gp_withdraw_max) updates.push({ idx: maxGP.idx, field: 'GP→INR Max GP', oldVal: maxGP.value, newVal: target.gp_withdraw_max });
    }
  }

  if (cur === 'PKR') {
    const minDep = inputData.find(i => i.section.includes('储值') && i.label.includes('最低储值'));
    const maxDep = inputData.find(i => i.section.includes('储值') && i.label.includes('最高储值'));
    const minGP = inputData.find(i => i.section.includes('GP') && i.label.includes('最低') && i.label.includes('GP'));
    const maxGP = inputData.find(i => i.section.includes('GP') && i.label.includes('最高') && i.label.includes('GP'));

    if (minDep && Number(minDep.value) !== target.deposit_min) updates.push({ idx: minDep.idx, field: 'PKR Min Deposit', oldVal: minDep.value, newVal: target.deposit_min });
    if (maxDep && Number(maxDep.value) !== target.deposit_max) updates.push({ idx: maxDep.idx, field: 'PKR Max Deposit', oldVal: maxDep.value, newVal: target.deposit_max });
    if (!target.withdraw_unavailable && target.gp_withdraw_min !== null) {
      if (minGP && Number(minGP.value) !== target.gp_withdraw_min) updates.push({ idx: minGP.idx, field: 'GP→PKR Min GP', oldVal: minGP.value, newVal: target.gp_withdraw_min });
      if (maxGP && Number(maxGP.value) !== target.gp_withdraw_max) updates.push({ idx: maxGP.idx, field: 'GP→PKR Max GP', oldVal: maxGP.value, newVal: target.gp_withdraw_max });
    }
  }

  if (cur === 'CNY') {
    const minDep = inputData.find(i => i.section.includes('储值') && i.label.includes('最低储值'));
    const maxDep = inputData.find(i => i.section.includes('储值') && i.label.includes('最高储值'));
    const minGP = inputData.find(i => i.label.includes('最低') && i.label.includes('GP'));
    const maxGP = inputData.find(i => i.label.includes('最高') && i.label.includes('GP'));

    if (minDep && Number(minDep.value) !== target.deposit_min) updates.push({ idx: minDep.idx, field: 'CNY Min Deposit', oldVal: minDep.value, newVal: target.deposit_min });
    if (maxDep && Number(maxDep.value) !== target.deposit_max) updates.push({ idx: maxDep.idx, field: 'CNY Max Deposit', oldVal: maxDep.value, newVal: target.deposit_max });
    if (!target.withdraw_unavailable && target.gp_withdraw_min !== null) {
      if (minGP && Number(minGP.value) !== target.gp_withdraw_min) updates.push({ idx: minGP.idx, field: 'CNY↔GP Min Withdraw GP', oldVal: minGP.value, newVal: target.gp_withdraw_min });
      if (maxGP && Number(maxGP.value) !== target.gp_withdraw_max) updates.push({ idx: maxGP.idx, field: 'CNY↔GP Max Withdraw GP', oldVal: maxGP.value, newVal: target.gp_withdraw_max });
    }
  }

  return updates;
}

// ---- Send screenshot + caption as ONE message, reply to original ----
async function sendScreenshotWithCaption(page, caption) {
  // Take full page screenshot to capture both deposit and withdraw sections
  const buf = await page.screenshot({ fullPage: true });
  const form = new FormData();
  form.append('chat_id', CS_GROUP_ID);
  form.append('caption', caption);
  form.append('photo', buf, { filename: 'screenshot.png', contentType: 'image/png' });
  if (replyToMsgId) {
    form.append('reply_to_message_id', String(replyToMsgId));
  }
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
}

// ---- Report completion (fallback for errors) ----
async function reportCompletion(data) {
  if (!callbackUrl) return;
  await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

main();
