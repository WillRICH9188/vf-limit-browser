// ============================================================
// VF Limit Bot - Render Headless Browser Service
// 功能：接收 Worker 指令 → 無頭瀏覽器登入後台 → 修改限額 → 截圖回報
// ============================================================

const express = require('express');
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const ADMIN_URL = 'https://admin7777777.voteflux.com';
const FIAT_URL = `${ADMIN_URL}/zh/fiat-settings`;

// 環境變數
const SHARED_SECRET = process.env.SHARED_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

// 健康檢查（Render 用）
app.get('/', (req, res) => res.send('VF Limit Browser Service is running.'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// 更新端點
app.post('/update', async (req, res) => {
  // 驗證 shared secret
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    uid, currency, deposit_min, deposit_max,
    gp_withdraw_min, gp_withdraw_max, withdraw_unavailable,
    callbackUrl, botToken, csGroupId,
  } = req.body;

  // 立即回覆（避免 Worker 超時）
  res.json({ status: 'started', uid });

  // 背景執行
  executeUpdate({
    uid, currency, deposit_min, deposit_max,
    gp_withdraw_min, gp_withdraw_max, withdraw_unavailable,
    callbackUrl, botToken, csGroupId,
  }).catch(err => {
    console.error('Update failed:', err);
    // 通知失敗
    reportCompletion(callbackUrl, {
      uid, success: false, message: err.message,
    }).catch(console.error);
  });
});

// ---- 主執行邏輯 ----
async function executeUpdate(params) {
  const {
    uid, currency, deposit_min, deposit_max,
    gp_withdraw_min, gp_withdraw_max, withdraw_unavailable,
    callbackUrl, botToken, csGroupId,
  } = params;

  console.log(`[${uid}] Starting update for ${currency}...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  const changes = [];

  try {
    // ---- Step 1: 登入 ----
    console.log(`[${uid}] Navigating to admin panel...`);
    await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // 判斷是否需要登入（有沒有登入表單）
    const loginForm = await page.$('input[type="password"]');
    if (loginForm) {
      console.log(`[${uid}] Login required, logging in...`);
      // 尋找帳號和密碼欄位
      const emailInput = await page.$('input[type="email"], input[type="text"], input[name="email"], input[name="username"]');
      const passInput = await page.$('input[type="password"]');

      if (emailInput) await emailInput.fill(ADMIN_USER);
      if (passInput) await passInput.fill(ADMIN_PASS);

      // 點登入按鈕
      const loginBtn = await page.$('button[type="submit"], button:has-text("登入"), button:has-text("Login"), button:has-text("登录")');
      if (loginBtn) await loginBtn.click();

      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // ---- Step 2: 進入 fiat-settings ----
    console.log(`[${uid}] Navigating to fiat settings...`);
    await page.goto(FIAT_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // ---- Step 3: 切到對應幣種分頁 ----
    console.log(`[${uid}] Switching to ${currency} tab...`);
    const tabBtn = await page.$(`button:has-text("${currency}")`);
    if (!tabBtn) throw new Error(`找不到 ${currency} 分頁按鈕`);
    await tabBtn.click();
    await page.waitForTimeout(1500);

    // ---- Step 4: 讀取所有輸入欄位 ----
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

    // ---- Step 5: 確定要改哪些欄位 ----
    const updates = getFieldUpdates(currency, inputData, {
      deposit_min, deposit_max, gp_withdraw_min, gp_withdraw_max, withdraw_unavailable,
    });

    if (updates.length === 0) {
      console.log(`[${uid}] No changes needed`);
      await sendScreenshot(page, botToken, csGroupId, `📸 ${currency} 無需變更，數值已正確`);
      await reportCompletion(callbackUrl, { uid, success: true, message: '數值已是最新，無需修改', changes: [] });
      await browser.close();
      return;
    }

    // ---- Step 6: 逐一修改並儲存 ----
    for (const u of updates) {
      console.log(`[${uid}] Updating field ${u.idx}: ${u.oldVal} → ${u.newVal} (${u.field})`);

      // 設定新值（用 React 方式）
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

      // 找到這個欄位旁的儲存按鈕並點擊
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

      // 點確認對話框的儲存按鈕
      const confirmBtn = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.trim() === '储存');
        if (btns.length > 0) {
          btns[btns.length - 1].click();
          return true;
        }
        return false;
      });

      await page.waitForTimeout(2000);

      changes.push({ field: u.field, oldVal: u.oldVal, newVal: u.newVal });
    }

    // ---- Step 7: 截圖 ----
    console.log(`[${uid}] Taking screenshot...`);
    await page.waitForTimeout(1000);
    await sendScreenshot(page, botToken, csGroupId, `📸 ${currency} 限額更新完成`);

    // ---- Step 8: 回報完成 ----
    await reportCompletion(callbackUrl, { uid, success: true, changes });

    console.log(`[${uid}] Done!`);
  } catch (err) {
    console.error(`[${uid}] Error:`, err);
    // 錯誤截圖
    try {
      await sendScreenshot(page, botToken, csGroupId, `❌ ${currency} 更新失敗截圖`);
    } catch (e) { /* ignore */ }
    throw err;
  } finally {
    await browser.close();
  }
}

// ---- 確定要改哪些欄位 ----
function getFieldUpdates(currency, inputData, target) {
  const updates = [];

  if (currency === 'INR') {
    // INR → GP: 单笔最低金额, 单笔最高金额
    const minDep = inputData.find(i => i.section.includes('INR') && i.section.includes('GP') && i.label.includes('最低金额'));
    const maxDep = inputData.find(i => i.section.includes('INR') && i.section.includes('GP') && i.label.includes('最高金额'));
    // GP → INR: 单笔最低 GP, 单笔最高 GP
    const minGP = inputData.find(i => i.section.includes('GP') && i.section.includes('INR') && i.label.includes('最低') && i.label.includes('GP'));
    const maxGP = inputData.find(i => i.section.includes('GP') && i.section.includes('INR') && i.label.includes('最高') && i.label.includes('GP'));

    if (minDep && Number(minDep.value) !== target.deposit_min) {
      updates.push({ idx: minDep.idx, field: 'INR→GP 单笔最低金额', oldVal: minDep.value, newVal: target.deposit_min });
    }
    if (maxDep && Number(maxDep.value) !== target.deposit_max) {
      updates.push({ idx: maxDep.idx, field: 'INR→GP 单笔最高金额', oldVal: maxDep.value, newVal: target.deposit_max });
    }
    if (!target.withdraw_unavailable && target.gp_withdraw_min !== null) {
      if (minGP && Number(minGP.value) !== target.gp_withdraw_min) {
        updates.push({ idx: minGP.idx, field: 'GP→INR 单笔最低GP', oldVal: minGP.value, newVal: target.gp_withdraw_min });
      }
      if (maxGP && Number(maxGP.value) !== target.gp_withdraw_max) {
        updates.push({ idx: maxGP.idx, field: 'GP→INR 单笔最高GP', oldVal: maxGP.value, newVal: target.gp_withdraw_max });
      }
    }
  }

  if (currency === 'PKR') {
    // 储值设定: 单笔最低储值, 单笔最高储值
    const minDep = inputData.find(i => i.section.includes('储值') && i.label.includes('最低储值'));
    const maxDep = inputData.find(i => i.section.includes('储值') && i.label.includes('最高储值'));
    // GP → PKR: 单笔最低 GP, 单笔最高 GP
    const minGP = inputData.find(i => i.section.includes('GP') && i.label.includes('最低') && i.label.includes('GP'));
    const maxGP = inputData.find(i => i.section.includes('GP') && i.label.includes('最高') && i.label.includes('GP'));

    if (minDep && Number(minDep.value) !== target.deposit_min) {
      updates.push({ idx: minDep.idx, field: 'PKR 单笔最低储值', oldVal: minDep.value, newVal: target.deposit_min });
    }
    if (maxDep && Number(maxDep.value) !== target.deposit_max) {
      updates.push({ idx: maxDep.idx, field: 'PKR 单笔最高储值', oldVal: maxDep.value, newVal: target.deposit_max });
    }
    if (!target.withdraw_unavailable && target.gp_withdraw_min !== null) {
      if (minGP && Number(minGP.value) !== target.gp_withdraw_min) {
        updates.push({ idx: minGP.idx, field: 'GP→PKR 单笔最低GP', oldVal: minGP.value, newVal: target.gp_withdraw_min });
      }
      if (maxGP && Number(maxGP.value) !== target.gp_withdraw_max) {
        updates.push({ idx: maxGP.idx, field: 'GP→PKR 单笔最高GP', oldVal: maxGP.value, newVal: target.gp_withdraw_max });
      }
    }
  }

  if (currency === 'CNY') {
    // 储值设定: 单笔最低储值, 单笔最高储值
    const minDep = inputData.find(i => i.section.includes('储值') && i.label.includes('最低储值'));
    const maxDep = inputData.find(i => i.section.includes('储值') && i.label.includes('最高储值'));
    // CNY ↔ GP: 单笔最低提领 GP, 单笔最高提领 GP
    const minGP = inputData.find(i => i.label.includes('最低') && i.label.includes('GP'));
    const maxGP = inputData.find(i => i.label.includes('最高') && i.label.includes('GP'));

    if (minDep && Number(minDep.value) !== target.deposit_min) {
      updates.push({ idx: minDep.idx, field: 'CNY 单笔最低储值', oldVal: minDep.value, newVal: target.deposit_min });
    }
    if (maxDep && Number(maxDep.value) !== target.deposit_max) {
      updates.push({ idx: maxDep.idx, field: 'CNY 单笔最高储值', oldVal: maxDep.value, newVal: target.deposit_max });
    }
    if (!target.withdraw_unavailable && target.gp_withdraw_min !== null) {
      if (minGP && Number(minGP.value) !== target.gp_withdraw_min) {
        updates.push({ idx: minGP.idx, field: 'CNY↔GP 单笔最低提领GP', oldVal: minGP.value, newVal: target.gp_withdraw_min });
      }
      if (maxGP && Number(maxGP.value) !== target.gp_withdraw_max) {
        updates.push({ idx: maxGP.idx, field: 'CNY↔GP 单笔最高提领GP', oldVal: maxGP.value, newVal: target.gp_withdraw_max });
      }
    }
  }

  return updates;
}

// ---- 發送截圖到客服群 ----
async function sendScreenshot(page, botToken, chatId, caption) {
  const screenshotBuffer = await page.screenshot({ fullPage: false });
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('photo', screenshotBuffer, { filename: 'screenshot.png', contentType: 'image/png' });

  await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
}

// ---- 回報完成 ----
async function reportCompletion(callbackUrl, data) {
  if (!callbackUrl) return;
  await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ---- 啟動服務 ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`VF Limit Browser Service running on port ${PORT}`);
});
