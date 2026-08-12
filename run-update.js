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
  uid, currency, subChannel,   // subChannel: 'Alipay' | 'GOBAO' | null
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
// subTabs: if the currency has sub-channels (e.g. CNY split into Alipay/GOBAO),
//   map the subChannel key to the sub-tab BUTTON label prefix that must be clicked
//   AFTER selecting the currency tab. If null/absent, no sub-tab step is needed.
//
// For withdraw cards with a 「平台允许」 subsection (new CNY layout), the writer
// automatically targets the GP inputs adjacent to that label (not the 商户受理 inputs).
// Old-style cards without that subsection fall back to the first 2 inputs of the card.
const CARD_MAP = {
  INR: { subTabs: null, deposit: ['INR → GP', '储值设定'], withdraw: ['INR ↔ GP', 'GP → INR', '提领设定'] },
  PKR: { subTabs: null, deposit: '储值设定',                withdraw: ['PKR ↔ GP', 'GP → PKR', '提领设定'] },
  CNY: {
    subTabs: { Alipay: '支付宝 Alipay', GOBAO: '购宝 GOBAO' },
    deposit: '储值设定',
    withdraw: '提领设定',
  },
  THB: { subTabs: null, deposit: '储值设定',                withdraw: ['THB ↔ GP', 'GP → THB', '提领设定'] },
  PHP: { subTabs: null, deposit: '储值设定',                withdraw: ['PHP ↔ GP', 'GP → PHP', '提领设定'] },
  // VND: withdraw 卡片是舊式 「VND ↔ GP」,提领设定卡片是廠商能力(不動),故不加 '提领设定' 到 alternatives
  VND: { subTabs: null, deposit: '储值设定',                withdraw: ['VND ↔ GP', 'GP → VND'] },
  USD: { subTabs: null, deposit: null,                      withdraw: ['USD ↔ GP', 'GP → USD', '提领设定'] },
};

// Normalize a title spec (string or array) into an array
function titleList(spec) {
  if (!spec) return [];
  return Array.isArray(spec) ? spec : [spec];
}

function depositTitlesArr(cards) { return titleList(cards.deposit); }
function withdrawTitlesArr(cards) { return titleList(cards.withdraw); }

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

    // ---- Step 3b: Click sub-tab if this currency has sub-channels (e.g. CNY) ----
    const cardsForCurrency = CARD_MAP[currency];
    if (!cardsForCurrency) throw new Error(`No card mapping for currency ${currency}`);
    if (cardsForCurrency.subTabs) {
      if (!subChannel) throw new Error(`${currency} requires subChannel in payload`);
      const subTabLabel = cardsForCurrency.subTabs[subChannel];
      if (!subTabLabel) throw new Error(`Unknown subChannel "${subChannel}" for ${currency}`);
      console.log(`[${uid}] Switching to sub-tab "${subTabLabel}"...`);
      const subTabClicked = await page.evaluate((label) => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.innerText.trim().startsWith(label));
        if (btn) { btn.click(); return true; }
        return false;
      }, subTabLabel);
      if (!subTabClicked) throw new Error(`Cannot find sub-tab button "${subTabLabel}"`);
      await page.waitForTimeout(1500);
    }

    // ---- Step 4: Expand all sections ----
    console.log(`[${uid}] Expanding all sections...`);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === '全部展开');
      if (btn) btn.click();
    });
    await page.waitForTimeout(2500);

    // ---- Step 5: Read current values ----
    const cards = cardsForCurrency; // already validated above

    const currentValues = await page.evaluate((cardsSpec) => {
      // ============================================================
      // Helpers (redefined inside evaluate — page context)
      // ============================================================

      // Find candidate elements whose "own text" (direct text-node children joined) === value.
      // Prefer SPAN matches; fallback to any element with matching own text.
      function findHeadingCandidates(text) {
        const spans = Array.from(document.querySelectorAll('span'));
        const spanHits = spans.filter(s => s.textContent.trim() === text);
        if (spanHits.length) return spanHits;
        const all = Array.from(document.querySelectorAll('*'));
        return all.filter(el => {
          const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
          return own === text;
        });
      }

      // Walk up from a heading to find the card wrapper.
      // Card wrapper qualifies if:
      //   - contains "额度限制"
      //   - starts with cardTitle text (so the heading is at the top of it)
      //   - textContent is not too large (avoid walking to page root)
      //   - does NOT contain any excludeTitles (to distinguish sibling cards)
      function findCardWrapper(heading, cardTitle, excludeTitles) {
        let card = heading.parentElement;
        for (let i = 0; i < 10; i++) {
          if (!card) break;
          const text = (card.textContent || '').trim();
          if (text.length > 8000) break;
          if (text.startsWith(cardTitle) && /额度限制/.test(text)) {
            // Reject if this wrapper contains another card's title (means we walked too far)
            let hasOther = false;
            for (const other of excludeTitles) {
              if (other && text.includes(other)) { hasOther = true; break; }
            }
            if (!hasOther) return card;
          }
          card = card.parentElement;
        }
        return null;
      }

      // Locate the 2 target inputs inside a card.
      // For withdraw cards with a "平台允许" sub-block, we want the GP inputs
      // adjacent to that label (NOT the 商户受理 ¥ inputs).
      // For everything else (deposit, old-style withdraw), use the first 2 inputs.
      function findTargetInputs(card, kind) {
        if (kind === 'withdraw') {
          // Try: find "平台允许" span; walk up to smallest block with >=2 inputs
          //      that does NOT contain 商户受理 text (to skip merchant block)
          const spans = Array.from(card.querySelectorAll('span'));
          const platformSpan = spans.find(s => s.textContent.trim() === '平台允许');
          if (platformSpan) {
            let p = platformSpan.parentElement;
            for (let i = 0; i < 6; i++) {
              if (!p) break;
              const containsMerchant = /商户受理/.test(p.textContent || '');
              const inps = p.querySelectorAll('input[type="number"]');
              if (inps.length >= 2 && !containsMerchant) {
                return [inps[0], inps[1]];
              }
              p = p.parentElement;
            }
          }
        }
        // Fallback (deposit, or old-style withdraw): first 2 inputs in the card
        const allInputs = card.querySelectorAll('input[type="number"]');
        if (allInputs.length >= 2) return [allInputs[0], allInputs[1]];
        return null;
      }

      // Try each candidate title from titleSpec; return the first one that resolves inputs.
      function findLimitInputs(titleSpec, kind, excludeTitles) {
        const titles = Array.isArray(titleSpec) ? titleSpec : (titleSpec ? [titleSpec] : []);
        for (const t of titles) {
          const candidates = findHeadingCandidates(t);
          for (const heading of candidates) {
            const card = findCardWrapper(heading, t, excludeTitles);
            if (!card) continue;
            const inputs = findTargetInputs(card, kind);
            if (inputs) {
              return { minVal: inputs[0].value, maxVal: inputs[1].value, matchedTitle: t };
            }
          }
        }
        return null;
      }

      // When looking for deposit card, exclude any withdraw-card titles from the wrapper
      // (and vice versa) — so we don't accidentally walk up to a wrapper containing both.
      const depositTitles = Array.isArray(cardsSpec.deposit) ? cardsSpec.deposit : (cardsSpec.deposit ? [cardsSpec.deposit] : []);
      const withdrawTitles = Array.isArray(cardsSpec.withdraw) ? cardsSpec.withdraw : (cardsSpec.withdraw ? [cardsSpec.withdraw] : []);

      return {
        deposit: findLimitInputs(cardsSpec.deposit, 'deposit', withdrawTitles),
        withdraw: findLimitInputs(cardsSpec.withdraw, 'withdraw', depositTitles),
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
        fieldUpdates.push({ cardTitle: depositCardTitle, cardKind: 'deposit', excludeTitles: withdrawTitlesArr(cards), fieldIdx: 1, kind: 'depositMax', oldVal: currentValues.deposit.maxVal, newVal: deposit_max });
      }
      if (depMinOld !== deposit_min) {
        fieldUpdates.push({ cardTitle: depositCardTitle, cardKind: 'deposit', excludeTitles: withdrawTitlesArr(cards), fieldIdx: 0, kind: 'depositMin', oldVal: currentValues.deposit.minVal, newVal: deposit_min });
      }
    }

    if (!withdraw_unavailable && currentValues.withdraw) {
      const wdMinOld = Number(currentValues.withdraw.minVal);
      const wdMaxOld = Number(currentValues.withdraw.maxVal);
      if (wdMaxOld !== gp_withdraw_max) {
        fieldUpdates.push({ cardTitle: withdrawCardTitle, cardKind: 'withdraw', excludeTitles: depositTitlesArr(cards), fieldIdx: 1, kind: 'withdrawMax', oldVal: currentValues.withdraw.maxVal, newVal: gp_withdraw_max });
      }
      if (wdMinOld !== gp_withdraw_min) {
        fieldUpdates.push({ cardTitle: withdrawCardTitle, cardKind: 'withdraw', excludeTitles: depositTitlesArr(cards), fieldIdx: 0, kind: 'withdrawMin', oldVal: currentValues.withdraw.minVal, newVal: gp_withdraw_min });
      }
    }

    if (fieldUpdates.length === 0) {
      console.log(`[${uid}] No changes needed`);
      const label = subChannel ? `${currency} (${subChannel})` : currency;
      const caption = `✅ ${label} — No changes needed, values are already correct.\n⏱ ${taipeiNow()}`;
      await sendCardScreenshots(page, cards, caption);
      return;
    }

    // ---- Step 7: Apply each field update one at a time ----
    for (const u of fieldUpdates) {
      console.log(`[${uid}] Updating ${u.kind} (${u.cardTitle}): ${u.oldVal} → ${u.newVal}`);
      const ok = await applyFieldUpdate(page, u.cardTitle, u.cardKind, u.excludeTitles, u.fieldIdx, u.newVal);
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
      const label = subChannel ? `${currency} (${subChannel})` : currency;
      await sendSinglePhoto(errShot, `❌ ${label} Update Failed\n\nError: ${err.message}`);
    } catch (e) {
      await reportCompletion({ uid, success: false, message: err.message, replyToMsgId });
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ---- Apply a single field update (change value + click 储存 + confirm dialog) ----
async function applyFieldUpdate(page, cardTitle, cardKind, excludeTitles, fieldIdx, newVal) {
  // Step 1: change the value in browser context
  const changed = await page.evaluate(({ cardTitle, cardKind, excludeTitles, fieldIdx, newVal }) => {
    // ---- Helpers (page context) ----
    function findHeadingCandidates(text) {
      const spans = Array.from(document.querySelectorAll('span'));
      const spanHits = spans.filter(s => s.textContent.trim() === text);
      if (spanHits.length) return spanHits;
      const all = Array.from(document.querySelectorAll('*'));
      return all.filter(el => {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return own === text;
      });
    }

    function findCardWrapper(heading, cardTitle, excludeTitles) {
      let card = heading.parentElement;
      for (let i = 0; i < 10; i++) {
        if (!card) break;
        const text = (card.textContent || '').trim();
        if (text.length > 8000) break;
        if (text.startsWith(cardTitle) && /额度限制/.test(text)) {
          let hasOther = false;
          for (const other of excludeTitles) {
            if (other && text.includes(other)) { hasOther = true; break; }
          }
          if (!hasOther) return card;
        }
        card = card.parentElement;
      }
      return null;
    }

    // Locate the target input BLOCK (not just the input) — we need the block for the 储存 button
    // Returns { block, targetInput }
    function findTargetBlock(card, kind, fieldIdx) {
      if (kind === 'withdraw') {
        const spans = Array.from(card.querySelectorAll('span'));
        const platformSpan = spans.find(s => s.textContent.trim() === '平台允许');
        if (platformSpan) {
          let p = platformSpan.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!p) break;
            const containsMerchant = /商户受理/.test(p.textContent || '');
            const inps = p.querySelectorAll('input[type="number"]');
            if (inps.length >= 2 && !containsMerchant) {
              return { block: p, targetInput: inps[fieldIdx] };
            }
            p = p.parentElement;
          }
        }
      }
      // Fallback: 额度限制 sub-heading → walk up to smallest 2-input block
      const subHeadings = Array.from(card.querySelectorAll('*')).filter(el => {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return /额度限制$/.test(own);
      });
      for (const sh of subHeadings) {
        let block = sh.parentElement;
        for (let j = 0; j < 8; j++) {
          if (!block) break;
          const inps = block.querySelectorAll('input[type="number"]');
          if (inps.length >= 2) {
            return { block, targetInput: inps[fieldIdx] };
          }
          block = block.parentElement;
        }
      }
      return null;
    }

    // ---- Main ----
    const candidates = findHeadingCandidates(cardTitle);
    for (const heading of candidates) {
      const card = findCardWrapper(heading, cardTitle, excludeTitles);
      if (!card) continue;
      const found = findTargetBlock(card, cardKind, fieldIdx);
      if (!found) continue;
      const { block, targetInput } = found;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(targetInput, String(newVal));
      targetInput.dispatchEvent(new Event('input', { bubbles: true }));
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      targetInput.dispatchEvent(new Event('blur', { bubbles: true }));
      // Mark this block so we can find the 储存 button later
      block.setAttribute('data-vf-active', '1');
      return true;
    }
    return false;
  }, { cardTitle, cardKind, excludeTitles, fieldIdx, newVal });

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
  const label = subChannel ? `${cur} (${subChannel})` : cur;

  let t = `✅ ${label} Limit Update Completed\n━━━━━━━━━━━━━━━━━━\n\n`;

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
  const depositExcludes = titleList(cards.deposit);
  const withdrawExcludes = titleList(cards.withdraw);
  const withdrawShot = await scrollAndScreenshotAny(page, cards.withdraw, depositExcludes, `${currency} Withdraw`);
  if (cards.deposit) {
    const depositShot = await scrollAndScreenshotAny(page, cards.deposit, withdrawExcludes, `${currency} Deposit`);
    await sendMediaGroup(depositShot, withdrawShot, caption);
  } else {
    await sendSinglePhoto(withdrawShot, caption);
  }
}

// Try each candidate title until we get a real element screenshot (not fallback viewport)
async function scrollAndScreenshotAny(page, titleSpec, excludeTitles, label) {
  const titles = Array.isArray(titleSpec) ? titleSpec : (titleSpec ? [titleSpec] : [null]);
  for (const t of titles) {
    const found = await page.evaluate((title) => {
      if (!title) return false;
      const spans = Array.from(document.querySelectorAll('span'));
      if (spans.some(s => s.textContent.trim() === title)) return true;
      const all = Array.from(document.querySelectorAll('*'));
      return all.some(el => {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return own === title;
      });
    }, t);
    if (found || t === titles[titles.length - 1]) {
      return await scrollAndScreenshot(page, t, excludeTitles, label);
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
// excludeTitles: the OTHER card's title candidates (deposit vs withdraw) so we
// don't accidentally mark a wrapper containing both cards.
async function scrollAndScreenshot(page, cardTitle, excludeTitles, label) {
  console.log(`[${uid}] Screenshot: ${label} (card="${cardTitle}")`);
  if (!cardTitle) return await page.screenshot({ fullPage: false });

  // 1) Mark the target card with a data attribute so we can locate it from Playwright
  const marked = await page.evaluate(({ title, excludeTitles }) => {
    // Clear any prior mark
    document.querySelectorAll('[data-vf-shot]').forEach(el => el.removeAttribute('data-vf-shot'));

    // Prefer SPAN with exact textContent; fall back to own-text-node match
    let headings = Array.from(document.querySelectorAll('span')).filter(s => s.textContent.trim() === title);
    if (!headings.length) {
      const all = Array.from(document.querySelectorAll('*'));
      headings = all.filter(el => {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return own === title;
      });
    }

    for (const heading of headings) {
      let card = heading.parentElement;
      let bestCard = null;
      for (let i = 0; i < 10; i++) {
        if (!card) break;
        const text = (card.textContent || '').trim();
        if (text.length > 8000) break;
        if (text.startsWith(title) && /额度限制/.test(text)) {
          let hasOther = false;
          for (const other of excludeTitles) {
            if (other && text.includes(other)) { hasOther = true; break; }
          }
          if (!hasOther) { bestCard = card; break; }
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
  }, { title: cardTitle, excludeTitles });

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
