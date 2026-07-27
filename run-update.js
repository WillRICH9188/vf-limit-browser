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

// Card titles that contain the 额度限制 (or 提款额度限制) sub-block per currency.
// Each field can be a single string OR an array of alternatives (for handling backend renames).
// If deposit is null, the currency's deposit is fixed denominations — we skip deposit updates.
const CARD_MAP = {
  INR: { deposit: ['INR → GP', '储值设定'],   withdraw: ['INR ↔ GP', 'GP → INR']  },
  PKR: { deposit: '储值设定',                  withdraw: ['PKR ↔ GP', 'GP → PKR']  },
  CNY: { deposit: '储值设定',                  withdraw: ['CNY ↔ GP', 'GP → CNY']  },
  THB: { deposit: '储值设定',                  withdraw: ['THB ↔ GP', 'GP → THB']  },
  USD: { deposit: null,                       withdraw: ['USD ↔ GP', 'GP → USD']  },
};

// Normalize a title spec (string or array) into an array
function titleList(spec) {
  if (!spec) return [];
  return Array.isArray(spec) ? spec : [spec];
}

// Sub-block heading that holds the min/max inputs. Backend renamed
// deposit's is still "额度限制", withdraw's is now "提款额度限制".
// Accept either — anything ending with "额度限制".
const LIMIT_SUBHEADING_REGEX = /额度限制$/;

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

    const currentValues = await page.evaluate((cardsSpec) => {
      // Count "额度限制"-suffix sub-headings within an element
      function countLimitSubHeadings(el) {
        return Array.from(el.querySelectorAll('*')).filter(x => {
          const own = Array.from(x.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
          return /额度限制$/.test(own);
        }).length;
      }

      function findLimitInputsForTitle(cardTitle) {
        if (!cardTitle) return null;
        const all = Array.from(document.querySelectorAll('*'));
        const headings = all.filter(el => {
          const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
          return own === cardTitle;
        });
        for (const heading of headings) {
          let card = heading.parentElement;
          let bestCard = null;
          // Walk up looking for the SMALLEST wrapper that contains:
          //   1. Some 额度限制/提款额度限制 sub-heading, AND
          //   2. Only ONE such sub-heading (so we know we're in a single card, not a multi-card wrapper)
          // Use textContent so we don't miss collapsed/hidden text.
          for (let i = 0; i < 10; i++) {
            if (!card) break;
            if (/额度限制/.test(card.textContent)) {
              const count = countLimitSubHeadings(card);
              if (count === 1) {
                bestCard = card;
                break; // smallest wrapper found
              }
              if (count > 1) {
                // Walked into a wrapper that contains multiple cards → back off
                break;
              }
            }
            card = card.parentElement;
          }
          if (!bestCard) continue;

          // Sub-heading matches "额度限制" or "提款额度限制" (anything ending with 额度限制)
          const subHeadings = Array.from(bestCard.querySelectorAll('*')).filter(el => {
            const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
            return /额度限制$/.test(own);
          });
          for (const sh of subHeadings) {
            let block = sh.parentElement;
            for (let j = 0; j < 8; j++) {
              if (!block) break;
              const inps = block.querySelectorAll('input[type="number"]');
              if (inps.length >= 2) {
                return { minVal: inps[0].value, maxVal: inps[1].value, matchedTitle: cardTitle };
              }
              block = block.parentElement;
            }
          }
        }
        return null;
      }

      // Try each candidate title until one works
      function findLimitInputs(titleSpec) {
        const titles = Array.isArray(titleSpec) ? titleSpec : (titleSpec ? [titleSpec] : []);
        for (const t of titles) {
          const found = findLimitInputsForTitle(t);
          if (found) return found;
        }
        return null;
      }

      return {
        deposit: findLimitInputs(cardsSpec.deposit),
        withdraw: findLimitInputs(cardsSpec.withdraw),
      };
    }, cards);

    console.log(`[${uid}] Current values: ${JSON.stringify(currentValues)}`);
    // Only require deposit card if this currency has one (USD has cards.deposit = null)
    if (cards.deposit && !currentValues.deposit) throw new Error(`Cannot find deposit card "${JSON.stringify(cards.deposit)}"`);
    if (!currentValues.withdraw && !withdraw_unavailable) throw new Error(`Cannot find withdraw card "${JSON.stringify(cards.withdraw)}"`);

    // Use the ACTUAL matched card title for updates (may differ from primary spec if backend renamed)
    const depositCardTitle = currentValues.deposit?.matchedTitle || (Array.isArray(cards.deposit) ? cards.deposit[0] : cards.deposit);
    const withdrawCardTitle = currentValues.withdraw?.matchedTitle || (Array.isArray(cards.withdraw) ? cards.withdraw[0] : cards.withdraw);

    // ---- Step 6: Build list of individual field updates ----
    // Each update is ONE field (min or max). User instruction:
    //   "如果同時修改最高值跟最低值 先把最高值設定然後按一次儲存 再設置最低值按一次儲存"
    // So we save MAX first, then MIN, for each card.
    const fieldUpdates = [];

    // Deposit updates — skipped entirely if this currency has fixed denominations (USD)
    if (cards.deposit && currentValues.deposit && deposit_min !== null && deposit_max !== null) {
      const depMinOld = Number(currentValues.deposit.minVal);
      const depMaxOld = Number(currentValues.deposit.maxVal);
      if (depMaxOld !== deposit_max) {
        fieldUpdates.push({ cardTitle: depositCardTitle, fieldIdx: 1, kind: 'depositMax', oldVal: currentValues.deposit.maxVal, newVal: deposit_max });
      }
      if (depMinOld !== deposit_min) {
        fieldUpdates.push({ cardTitle: depositCardTitle, fieldIdx: 0, kind: 'depositMin', oldVal: currentValues.deposit.minVal, newVal: deposit_min });
      }
    }

    if (!withdraw_unavailable && currentValues.withdraw) {
      const wdMinOld = Number(currentValues.withdraw.minVal);
      const wdMaxOld = Number(currentValues.withdraw.maxVal);
      if (wdMaxOld !== gp_withdraw_max) {
        fieldUpdates.push({ cardTitle: withdrawCardTitle, fieldIdx: 1, kind: 'withdrawMax', oldVal: currentValues.withdraw.maxVal, newVal: gp_withdraw_max });
      }
      if (wdMinOld !== gp_withdraw_min) {
        fieldUpdates.push({ cardTitle: withdrawCardTitle, fieldIdx: 0, kind: 'withdrawMin', oldVal: currentValues.withdraw.minVal, newVal: gp_withdraw_min });
      }
    }

    if (fieldUpdates.length === 0) {
      console.log(`[${uid}] No changes needed`);
      const caption = `✅ ${currency} — No changes needed, values are already correct.\n⏱ ${taipeiNow()}`;
      await sendCardScreenshots(page, cards, caption);
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
    const caption = buildCaption(currency, changes, currentValues);
    await sendCardScreenshots(page, cards, caption);
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
    // Count "额度限制"-suffix sub-headings within an element
    function countLimitSubHeadings(el) {
      return Array.from(el.querySelectorAll('*')).filter(x => {
        const own = Array.from(x.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return /额度限制$/.test(own);
      }).length;
    }

    const all = Array.from(document.querySelectorAll('*'));
    const headings = all.filter(el => {
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
      return own === cardTitle;
    });
    for (const heading of headings) {
      let card = heading.parentElement;
      let bestCard = null;
      // Walk up looking for the SMALLEST wrapper that contains exactly ONE 额度限制 sub-heading.
      // This means we're inside a single card — safe to write.
      for (let i = 0; i < 10; i++) {
        if (!card) break;
        if (/额度限制/.test(card.textContent)) {
          const count = countLimitSubHeadings(card);
          if (count === 1) { bestCard = card; break; }
          if (count > 1) { break; } // walked into multi-card wrapper — abort
        }
        card = card.parentElement;
      }
      if (!bestCard) continue;

      const subHeadings = Array.from(bestCard.querySelectorAll('*')).filter(el => {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return /额度限制$/.test(own);
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
            // Mark this block so we can find the 储存 button later
            block.setAttribute('data-vf-active', '1');
            return true;
          }
          block = block.parentElement;
        }
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

  // Deposit (skipped for USD — fixed denominations)
  if (currentValues.deposit) {
    t += `💰 Deposit Settings\n`;
    t += `   Min: ${depMin ? depMin.oldVal + ' → ' + depMin.newVal + ' ✅' : (currentValues.deposit?.minVal || '—') + ' (no change)'}\n`;
    t += `   Max: ${depMax ? depMax.oldVal + ' → ' + depMax.newVal + ' ✅' : (currentValues.deposit?.maxVal || '—') + ' (no change)'}\n\n`;
  } else {
    t += `💰 Deposit: Fixed denominations (not auto-updated)\n\n`;
  }

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

// ---- Send card screenshots (one or two cards depending on whether deposit is skipped) ----
// Handles array titles: tries each candidate until one works.
async function sendCardScreenshots(page, cards, caption) {
  const withdrawShot = await scrollAndScreenshotAny(page, cards.withdraw, `${currency} Withdraw`);
  if (cards.deposit) {
    // Two cards → media group (album)
    const depositShot = await scrollAndScreenshotAny(page, cards.deposit, `${currency} Deposit`);
    await sendMediaGroup(depositShot, withdrawShot, caption);
  } else {
    // USD: only withdraw card → single photo
    await sendSinglePhoto(withdrawShot, caption);
  }
}

// Try each candidate title until we get a real element screenshot (not fallback viewport)
async function scrollAndScreenshotAny(page, titleSpec, label) {
  const titles = Array.isArray(titleSpec) ? titleSpec : (titleSpec ? [titleSpec] : [null]);
  for (const t of titles) {
    // Check if this title can be found first
    const found = await page.evaluate((title) => {
      if (!title) return false;
      const all = Array.from(document.querySelectorAll('*'));
      return all.some(el => {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return own === title;
      });
    }, t);
    if (found || t === titles[titles.length - 1]) {
      return await scrollAndScreenshot(page, t, label);
    }
  }
  return await page.screenshot({ fullPage: false });
}

// ---- Format current time in Taipei timezone (GMT+8) ----
function taipeiNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// ---- Take an element-bounded screenshot of the specified card ----
// Finds the smallest container that holds the card title AND its 额度限制 block,
// scrolls it into view, then captures using its bounding box.
async function scrollAndScreenshot(page, cardTitle, label) {
  console.log(`[${uid}] Screenshot: ${label} (card="${cardTitle}")`);
  if (!cardTitle) return await page.screenshot({ fullPage: false });

  // 1) Mark the target card with a data attribute so we can locate it from Playwright
  const marked = await page.evaluate((title) => {
    // Clear any prior mark
    document.querySelectorAll('[data-vf-shot]').forEach(el => el.removeAttribute('data-vf-shot'));

    const all = Array.from(document.querySelectorAll('*'));
    const headings = all.filter(el => {
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
      return own === title;
    });

    // Count "额度限制"-suffix sub-headings within an element
    function countLimitSubHeadingsShot(el) {
      return Array.from(el.querySelectorAll('*')).filter(x => {
        const own = Array.from(x.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return /额度限制$/.test(own);
      }).length;
    }

    for (const heading of headings) {
      let card = heading.parentElement;
      let bestCard = null;
      for (let i = 0; i < 10; i++) {
        if (!card) break;
        if (/额度限制/.test(card.textContent)) {
          const count = countLimitSubHeadingsShot(card);
          if (count === 1) { bestCard = card; break; }
          if (count > 1) { break; }
        }
        card = card.parentElement;
      }
      if (bestCard) {
        bestCard.setAttribute('data-vf-shot', '1');
        bestCard.scrollIntoView({ behavior: 'instant', block: 'start' });
        return true;
      }
    }
    return false;
  }, cardTitle);

  if (!marked) {
    console.log(`[${uid}] Could not locate card "${cardTitle}", falling back to viewport screenshot`);
    return await page.screenshot({ fullPage: false });
  }

  await page.waitForTimeout(600);
  const handle = await page.$('[data-vf-shot="1"]');
  if (!handle) {
    return await page.screenshot({ fullPage: false });
  }

  // 2) Capture only the card's bounding box
  let shot;
  try {
    shot = await handle.screenshot();
  } catch (e) {
    console.log(`[${uid}] Element screenshot failed (${e.message}), falling back to viewport`);
    shot = await page.screenshot({ fullPage: false });
  }

  // 3) Clean up marker
  await page.evaluate(() => {
    document.querySelectorAll('[data-vf-shot]').forEach(el => el.removeAttribute('data-vf-shot'));
  });

  return shot;
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
