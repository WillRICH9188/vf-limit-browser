// ============================================================
// VF Limit Bot - GitHub Actions Playwright Script
// Login to admin → Update limits → Screenshot → Send to CS group
//
// Updated for new admin layout (2026-06):
//  - Sections collapsed by default — click "全部展开" to expand
//  - Each field saved INDIVIDUALLY via small "储存" button that appears
//    only AFTER the value is changed (top-right of the 额度限制 row).
//  - After clicking that 储存, a confirmation dialog appears with
//    "取消" / "储存" — must click the dialog's 储存 to actually save.
//  - DO NOT click "套用" — it resets the field to system defaults.
//  - If both min and max need to change: do MAX first (save+confirm),
//    then MIN (save+confirm). One field per save cycle.
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
  uid, currency,
  deposit = {}, withdraw = {}, gp_withdraw = {},
  callbackUrl, replyToMsgId,
} = payload;

const deposit_min = deposit.min;
const deposit_max = deposit.max;
const withdraw_min = withdraw.min;
const withdraw_max = withdraw.max;
const withdraw_unavailable = withdraw.unavailable || false;
const gp_withdraw_min = gp_withdraw.min;
const gp_withdraw_max = gp_withdraw.max;

// Card titles that contain the 额度限制 sub-block per currency
const CARD_MAP = {
  INR: { deposit: 'INR → GP', withdraw: 'GP → INR' },
  PKR: { deposit: '储值设定', withdraw: 'GP → PKR' },
  CNY: { deposit: '储值设定', withdraw: 'CNY ↔ GP' },
};

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
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const loginForm = await page.$('input[type="password"]');
    if (loginForm) {
      console.log(`[${uid}] Login required, logging in...`);
      const emailInput = await page.$('input[type="email"], input[type="text"], input[name="email"], input[name="username"]');
      const passInput = await page.$('input[type="password"]');
      if (emailInput) await emailInput.fill(ADMIN_USER);
      if (passInput) await passInput.fill(ADMIN_PASS);

      const loginBtn = await page.$('button[type="submit"], button:has-text("登入"), button:has-text("Login"), button:has-text("登录")');
      if (loginBtn) await loginBtn.click();
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // ---- Step 2: Navigate to fiat-settings ----
    console.log(`[${uid}] Navigating to fiat settings...`);
    await page.goto(FIAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // ---- Step 3: Click currency tab ----
    console.log(`[${uid}] Switching to ${currency} tab...`);
    const tabClicked = await page.evaluate((cur) => {
      const spans = Array.from(document.querySelectorAll('span'));
      const targetSpan = spans.find(s => s.innerText.trim() === cur);
      const btn = targetSpan?.closest('button');
      if (btn) { btn.click(); return true; }
      return false;
    }, currency);
    if (!tabClicked) throw new Error(`Cannot find ${currency} tab button`);
    await page.waitForTimeout(2000);

    // ---- Step 4: Expand all sections ----
    console.log(`[${uid}] Expanding all sections...`);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '全部展开');
      if (btn) btn.click();
    });
    await page.waitForTimeout(2500);

    // ---- Step 5: Read current values ----
    const cards = CARD_MAP[currency];
    if (!cards) throw new Error(`No card mapping for currency ${currency}`);

    const currentValues = await page.evaluate((cards) => {
      function findLimitInputs(cardTitle) {
        const all = Array.from(document.querySelectorAll('*'));
        const headings = all.filter(el => {
          const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
          return own === cardTitle;
        });
        for (const heading of headings) {
          let card = heading.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!card) break;
            if (card.innerText.includes('额度限制') && card.innerText.includes('单笔交易的下限与上限')) {
              const subHeadings = Array.from(card.querySelectorAll('*')).filter(el => {
                const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
                return own === '额度限制';
              });
              for (const sh of subHeadings) {
                let block = sh.parentElement;
                for (let j = 0; j < 8; j++) {
                  if (!block) break;
                  const inps = block.querySelectorAll('input[type="number"]');
                  if (inps.length >= 2) {
                    return { minVal: inps[0].value, maxVal: inps[1].value };
                  }
                  block = block.parentElement;
                }
              }
            }
            card = card.parentElement;
          }
        }
        return null;
      }
      return {
        deposit: findLimitInputs(cards.deposit),
        withdraw: findLimitInputs(cards.withdraw),
      };
    }, cards);

    console.log(`[${uid}] Current values: ${JSON.stringify(currentValues)}`);
    if (!currentValues.deposit) throw new Error(`Cannot find deposit card "${cards.deposit}"`);
    if (!currentValues.withdraw && !withdraw_unavailable) throw new Error(`Cannot find withdraw card "${cards.withdraw}"`);

    // ---- Step 6: Build list of individual field updates ----
    // Each update is ONE field (min or max). User instruction:
    //   "如果同時修改最高值跟最低值 先把最高值設定然後按一次儲存 再設置最低值按一次儲存"
    // So we save MAX first, then MIN, for each card.
    const fieldUpdates = [];
    const depMinOld = Number(currentValues.deposit.minVal);
    const depMaxOld = Number(currentValues.deposit.maxVal);

    if (depMaxOld !== deposit_max) {
      fieldUpdates.push({ cardTitle: cards.deposit, fieldIdx: 1, kind: 'depositMax', oldVal: currentValues.deposit.maxVal, newVal: deposit_max });
    }
    if (depMinOld !== deposit_min) {
      fieldUpdates.push({ cardTitle: cards.deposit, fieldIdx: 0, kind: 'depositMin', oldVal: currentValues.deposit.minVal, newVal: deposit_min });
    }

    if (!withdraw_unavailable && currentValues.withdraw) {
      const wdMinOld = Number(currentValues.withdraw.minVal);
      const wdMaxOld = Number(currentValues.withdraw.maxVal);
      if (wdMaxOld !== gp_withdraw_max) {
        fieldUpdates.push({ cardTitle: cards.withdraw, fieldIdx: 1, kind: 'withdrawMax', oldVal: currentValues.withdraw.maxVal, newVal: gp_withdraw_max });
      }
      if (wdMinOld !== gp_withdraw_min) {
        fieldUpdates.push({ cardTitle: cards.withdraw, fieldIdx: 0, kind: 'withdrawMin', oldVal: currentValues.withdraw.minVal, newVal: gp_withdraw_min });
      }
    }

    if (fieldUpdates.length === 0) {
      console.log(`[${uid}] No changes needed`);
      const depositShot = await scrollAndScreenshot(page, cards.deposit, `${currency} Deposit`);
      const withdrawShot = await scrollAndScreenshot(page, cards.withdraw, `${currency} Withdraw`);
      const caption = `✅ ${currency} — No changes needed, values are already correct.\n⏱ ${taipeiNow()}`;
      await sendMediaGroup(depositShot, withdrawShot, caption);
      return;
    }

    // ---- Step 7: Apply each field update one at a time ----
    for (const u of fieldUpdates) {
      console.log(`[${uid}] Updating ${u.kind} (${u.cardTitle}): ${u.oldVal} → ${u.newVal}`);
      const ok = await applyFieldUpdate(page, u.cardTitle, u.fieldIdx, u.newVal);
      if (!ok) throw new Error(`Failed to save ${u.kind} in card "${u.cardTitle}"`);
      changes.push({
        field: `${currency} ${labelOf(u.kind)}`,
        oldVal: u.oldVal,
        newVal: u.newVal,
      });
      await page.waitForTimeout(1000); // breathe between fields
    }

    // ---- Step 8: Screenshots + report ----
    console.log(`[${uid}] Taking screenshots...`);
    await page.waitForTimeout(1000);
    const depositShot = await scrollAndScreenshot(page, cards.deposit, `${currency} Deposit`);
    const withdrawShot = await scrollAndScreenshot(page, cards.withdraw, `${currency} Withdraw`);
    const caption = buildCaption(currency, changes, currentValues);
    await sendMediaGroup(depositShot, withdrawShot, caption);
    console.log(`[${uid}] Done!`);

  } catch (err) {
    console.error(`[${uid}] Error:`, err);
    try {
      const errShot = await page.screenshot({ fullPage: false });
      await sendSinglePhoto(errShot, `❌ ${currency} Update Failed\n\nError: ${err.message}`);
    } catch (e) {
      await reportCompletion({ uid, success: false, message: err.message, replyToMsgId });
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ---- Apply a single field update (change value + click 储存 + confirm dialog) ----
async function applyFieldUpdate(page, cardTitle, fieldIdx, newVal) {
  // Step 1: change the value in browser context
  const changed = await page.evaluate(({ cardTitle, fieldIdx, newVal }) => {
    const all = Array.from(document.querySelectorAll('*'));
    const headings = all.filter(el => {
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
      return own === cardTitle;
    });
    for (const heading of headings) {
      let card = heading.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!card) break;
        if (card.innerText.includes('额度限制') && card.innerText.includes('单笔交易的下限与上限')) {
          const subHeadings = Array.from(card.querySelectorAll('*')).filter(el => {
            const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
            return own === '额度限制';
          });
          for (const sh of subHeadings) {
            let block = sh.parentElement;
            for (let j = 0; j < 8; j++) {
              if (!block) break;
              const inps = block.querySelectorAll('input[type="number"]');
              if (inps.length >= 2) {
                const target = inps[fieldIdx];
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(target, String(newVal));
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
                target.dispatchEvent(new Event('blur', { bubbles: true }));
                // Mark this block so we can find it again to click 储存
                block.setAttribute('data-vf-active', '1');
                return true;
              }
              block = block.parentElement;
            }
          }
        }
        card = card.parentElement;
      }
    }
    return false;
  }, { cardTitle, fieldIdx, newVal });

  if (!changed) return false;
  await page.waitForTimeout(800); // wait for 储存 button to appear

  // Step 2: click the 储存 button inside the active limit block
  const saveClicked = await page.evaluate(() => {
    const block = document.querySelector('[data-vf-active="1"]');
    if (!block) return false;
    // The small 储存 has text-[11px] class. Find it specifically (NOT 套用).
    const saveBtn = Array.from(block.querySelectorAll('button')).find(b => {
      return b.innerText.trim() === '储存';
    });
    if (!saveBtn) return false;
    saveBtn.click();
    block.removeAttribute('data-vf-active');
    return true;
  });

  if (!saveClicked) return false;
  await page.waitForTimeout(1200); // wait for confirmation dialog

  // Step 3: click 储存 in confirmation dialog
  const confirmed = await page.evaluate(() => {
    // Find a dialog by looking for the 取消 button and its sibling 储存
    const cancelBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '取消');
    if (!cancelBtn) return false;
    // The confirm 储存 is the sibling of 取消 inside the dialog
    const dialogContainer = cancelBtn.closest('div[class*="rounded"]') || cancelBtn.parentElement;
    const dialogSaveBtn = Array.from(dialogContainer.querySelectorAll('button')).find(b => b.innerText.trim() === '储存');
    if (!dialogSaveBtn) return false;
    dialogSaveBtn.click();
    return true;
  });

  if (!confirmed) return false;
  await page.waitForTimeout(2000); // wait for save complete + dialog close
  return true;
}

// ---- Friendly labels for fields ----
function labelOf(kind) {
  switch (kind) {
    case 'depositMin': return 'Deposit Min';
    case 'depositMax': return 'Deposit Max';
    case 'withdrawMin': return 'Withdraw GP Min';
    case 'withdrawMax': return 'Withdraw GP Max';
    default: return kind;
  }
}

// ---- Build structured caption ----
function buildCaption(cur, changes, currentValues) {
  const depMin = changes.find(c => c.field.includes('Deposit Min'));
  const depMax = changes.find(c => c.field.includes('Deposit Max'));
  const wdMin = changes.find(c => c.field.includes('Withdraw GP Min'));
  const wdMax = changes.find(c => c.field.includes('Withdraw GP Max'));

  let t = `✅ ${cur} Limit Update Completed\n━━━━━━━━━━━━━━━━━━\n\n`;

  t += `💰 Deposit Settings\n`;
  t += `   Min: ${depMin ? depMin.oldVal + ' → ' + depMin.newVal + ' ✅' : (currentValues.deposit?.minVal || '—') + ' (no change)'}\n`;
  t += `   Max: ${depMax ? depMax.oldVal + ' → ' + depMax.newVal + ' ✅' : (currentValues.deposit?.maxVal || '—') + ' (no change)'}\n\n`;

  if (withdraw_unavailable) {
    t += `💸 Withdraw Settings\n`;
    t += `   ⛔ Suspended (Insufficient merchant balance)\n\n`;
  } else {
    t += `💸 Withdraw Settings\n`;
    t += `   Range: ${(withdraw_min || 0).toLocaleString()} – ${(withdraw_max || 0).toLocaleString()} ${cur}\n`;
    t += `   Min GP: ${wdMin ? wdMin.oldVal + ' → ' + wdMin.newVal + ' ✅' : (currentValues.withdraw?.minVal || '—') + ' (no change)'}\n`;
    t += `   Max GP: ${wdMax ? wdMax.oldVal + ' → ' + wdMax.newVal + ' ✅' : (currentValues.withdraw?.maxVal || '—') + ' (no change)'}\n\n`;
  }

  t += `⏱ ${taipeiNow()}`;
  return t;
}

// ---- Format current time in Taipei timezone (GMT+8) ----
function taipeiNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// ---- Scroll to a card by its title and take screenshot ----
async function scrollAndScreenshot(page, cardTitle, label) {
  if (cardTitle) {
    await page.evaluate((title) => {
      const all = Array.from(document.querySelectorAll('*'));
      const target = all.find(el => {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return own === title;
      });
      if (target) {
        let scrollTarget = target;
        for (let i = 0; i < 3; i++) {
          if (scrollTarget.parentElement) scrollTarget = scrollTarget.parentElement;
        }
        scrollTarget.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    }, cardTitle);
    await page.waitForTimeout(800);
  }
  console.log(`[${uid}] Screenshot: ${label}`);
  return await page.screenshot({ fullPage: false });
}

// ---- Send two screenshots as album (one message), reply to original ----
async function sendMediaGroup(depositBuf, withdrawBuf, caption) {
  const form = new FormData();
  form.append('chat_id', CS_GROUP_ID);
  if (replyToMsgId) {
    form.append('reply_to_message_id', String(replyToMsgId));
  }
  form.append('media', JSON.stringify([
    { type: 'photo', media: 'attach://deposit', caption: caption },
    { type: 'photo', media: 'attach://withdraw' },
  ]));
  form.append('deposit', depositBuf, { filename: 'deposit.png', contentType: 'image/png' });
  form.append('withdraw', withdrawBuf, { filename: 'withdraw.png', contentType: 'image/png' });

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, { method: 'POST', body: form });
}

// ---- Send single photo (for errors) ----
async function sendSinglePhoto(buf, caption) {
  const form = new FormData();
  form.append('chat_id', CS_GROUP_ID);
  form.append('caption', caption);
  form.append('photo', buf, { filename: 'error.png', contentType: 'image/png' });
  if (replyToMsgId) form.append('reply_to_message_id', String(replyToMsgId));
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
