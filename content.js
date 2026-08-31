// ================================================================
//  content.js — DaryaGold Scalping Analyzer (1m primary)
//
//  اصول این نسخه:
//  - تحلیل اصلی روی ۱ دقیقه؛ ۵ و ۱۵ دقیقه فقط Context/تأیید هستند.
//  - Setup فقط با بسته‌شدن کندل ۱ دقیقه‌ای اسکن می‌شود، نه با هر Tick؛
//    و تا SL/TP نخورد دست‌نخورده می‌ماند (بدون فلیکر، بدون سقف زمانی).
//  - اگر داده Stale/ناهماهنگ باشد (DELAYED/ERROR)، Setup جدیدی صادر
//    نمیشود.
//  - اعتبار همیشه از بک‌تست واقعی (رویدادمحور، با Slippage) می‌آید،
//    نه یک عدد ساختگی.
// ================================================================

console.log('⚡ DaryaGold Scalping Analyzer بارگذاری شد');

const CFG = { ...window.DGSetupEngine.DEFAULT_CONFIG };
const MAX_1M_CANDLES = 4000; // ~۶۶ ساعت؛ کافی برای ساختار ۱ دقیقه‌ای، بدون فشار زیاد به مرورگر

let raw1m = [];                 // کندل‌های ۱ دقیقه‌ای بسته‌شده (بدون کندل در حال شکل‌گیری)
let currentMinuteCandle = null; // کندل ۱ دقیقه‌ای در حال شکل‌گیری از روی Tick های زنده
let resampler5, resampler15;    // Resampler های Incremental برای Context (بدون Look-ahead)

let activeSetup = null;         // { direction, entry, sl, tp, rr, reasonTags, createdAtTime, entryIndexInRaw }
let lastResolution = null;      // آخرین نتیجه‌ی بسته‌شده، برای نمایش موقت به کاربر

let wsSocket = null;
let wsConnected = false;
let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT = 30000;
let lastTickAt = null;          // Date.now() آخرین Tick دریافتی
let dataSource = 'wss://tv.daryagold.com/ohlc/';

let cachedBacktest = null;      // آخرین گزارش بک‌تست (فقط با درخواست کاربر ساخته می‌شود)
let backtestRunning = false;

// ============================ داده‌ی تاریخی ============================

async function fetchHistorical1m() {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 7 * 24 * 60 * 60; // تلاش برای ۷ رو��؛ اگر سرور کمتر داشته باشد اشکالی ندارد
  const url = `https://tv.daryagold.com/api/data/histoday/?e=DaryaGold&fsym=MAZANEH&tsym=TMN&toTs=${now}&fromTs=${from}&resolution=1`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.Response === 'Success' && Array.isArray(data.Data)) {
      return data.Data
        .map(item => ({ time: item.time, open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume || 0 }))
        .sort((a, b) => a.time - b.time);
    }
  } catch (e) {
    console.warn('[Scalper] خطا در دریافت تاریخچه:', e);
  }
  return [];
}

// ============================ اتصال زنده ============================

function connectWebSocket() {
  if (wsSocket && (wsSocket.readyState === WebSocket.OPEN || wsSocket.readyState === WebSocket.CONNECTING)) return;
  try {
    wsSocket = new WebSocket(dataSource);
  } catch (e) {
    console.warn('[Scalper] WebSocket ایجاد نشد:', e);
    wsConnected = false;
    return;
  }

  wsSocket.addEventListener('open', () => {
    wsConnected = true;
    wsReconnectDelay = 1000;
    try { wsSocket.send(JSON.stringify({ action: 'SubAdd', subs: ['0~DaryaGold~MAZANEH~TMN'] })); } catch (e) { /* ignore */ }
    renderAll();
  });

  wsSocket.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.TYPE === '0' && data.FSYM === 'MAZANEH' && data.TSYM === 'TMN') {
        const price = parseFloat(data.P);
        if (!isNaN(price)) onTick(price);
      }
    } catch (e) { /* نادیده گرفته می‌شود */ }
  });

  wsSocket.addEventListener('close', () => {
    wsConnected = false;
    renderAll();
    setTimeout(() => {
      connectWebSocket();
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT);
    }, wsReconnectDelay);
  });

  wsSocket.addEventListener('error', () => { if (wsSocket) wsSocket.close(); });
}

function onTick(price) {
  lastTickAt = Date.now();
  const minuteStart = Math.floor(lastTickAt / 60000) * 60000;

  if (!currentMinuteCandle || currentMinuteCandle.startMs !== minuteStart) {
    if (currentMinuteCandle) closeCurrentCandle();
    currentMinuteCandle = { startMs: minuteStart, time: Math.floor(minuteStart / 1000), open: price, high: price, low: price, close: price, volume: 1 };
  } else {
    currentMinuteCandle.high = Math.max(currentMinuteCandle.high, price);
    currentMinuteCandle.low = Math.min(currentMinuteCandle.low, price);
    currentMinuteCandle.close = price;
    currentMinuteCandle.volume += 1;
  }

  // فقط تسویه‌ی Setup فعال با هر Tick بررسی می‌شود (نه صدور Setup جدید) —
  // این دقیقاً همان چیزی‌ست که SL/TP واقعی باید با آن لمس شوند، نه با کندل بسته‌شده.
  checkActiveSetupAgainstPrice(price);
  updatePriceUI(price);
  renderAll();
}

function closeCurrentCandle() {
  raw1m.push(currentMinuteCandle);
  if (raw1m.length > MAX_1M_CANDLES) raw1m.shift();
  if (resampler5) resampler5.push(currentMinuteCandle);
  if (resampler15) resampler15.push(currentMinuteCandle);

  // اسکن برای Setup جدید فقط روی کندل تازه‌بسته‌شده، و فقط اگر Setup فعالی نداریم و داده تازه است
  const status = getDataStatus();
  if (!activeSetup && status.level !== 'error' && status.level !== 'delayed') {
    tryScanForSetup();
  }
}

let lastDetectedPatterns = []; // آخرین لیست الگوهای شناسایی‌شده (برای نمایش، جدا از تصمیم نهایی)

function tryScanForSetup() {
  const idx = raw1m.length - 1;
  const htf5 = resampler5 ? resampler5.getAll() : [];
  const htf15 = resampler15 ? resampler15.getAll() : [];
  const result = window.DGSetupEngine.scanForSetup(raw1m, idx, htf5, htf15, CFG);
  lastDetectedPatterns = result.patterns;
  if (!result.armed) return;

  // بررسی سریع اندیکاتوری روی کندل ورودی قبل از armed شدن
  const entryIdx = idx;
  const rsiVal = window.DGIndicators.rsi(raw1m, 14, entryIdx);
  const macdObj = window.DGIndicators.macd(raw1m, entryIdx);
  const mom = window.DGIndicators.momentum(raw1m, 5, entryIdx);
  const pattern = window.DGIndicators.detectCandlePattern(raw1m, entryIdx);

  let confirms = 0;
  if (result.armed.direction === 'long') {
    if (rsiVal !== null && rsiVal >= CFG.minRsiConfirm) confirms++;
    if (macdObj && macdObj.hist !== null && macdObj.hist > CFG.macdHistThreshold) confirms++;
    if (mom !== null && mom > CFG.momentumThreshold) confirms++;
    if (pattern === 'bullish_engulfing' || pattern === 'hammer') confirms++;
  } else {
    if (rsiVal !== null && rsiVal <= (100 - CFG.minRsiConfirm)) confirms++;
    if (macdObj && macdObj.hist !== null && macdObj.hist < -CFG.macdHistThreshold) confirms++;
    if (mom !== null && mom < -CFG.momentumThreshold) confirms++;
    if (pattern === 'bearish_engulfing' || pattern === 'shooting_star') confirms++;
  }

  if (confirms >= CFG.confirmationNeeded) {
    activeSetup = { ...result.armed, entryIndexInRaw: entryIdx };
    lastResolution = null;
  } else {
    // رد کردن به عنوان مسلح‌شده؛ الگو به عنوان "شناسایی‌شده ولی ردشده" در lastDetectedPatterns باقی می‌ماند
  }
}

function checkActiveSetupAgainstPrice(price) {
  if (!activeSetup) return;
  const outcome = window.DGSetupEngine.checkResolution(activeSetup, price);
  if (outcome) {
    lastResolution = { outcome, direction: activeSetup.direction, entry: activeSetup.entry, exitPrice: price, at: Date.now() };
    activeSetup = null;
  }
}

// ============================ وضعیت داده‌ی زنده ============================

function getDataStatus() {
  if (!wsConnected) return { label: '🔴 قطع است — داده به‌روز نیست', level: 'error' };
  if (lastTickAt === null) return { label: '🟡 در انتظار اولین داده...', level: 'delayed' };
  const delta = Date.now() - lastTickAt;
  if (delta <= 3000) return { label: '🟢 داده به‌روز است', level: 'live' };
  if (delta <= 10000) return { label: '🔵 داده به‌روز است', level: 'synced' };
  if (delta <= 30000) return { label: '🟠 داده کمی تأخیر دارد', level: 'delayed' };
  return { label: '🔴 داده قدیمی است — صبر کنید', level: 'error' };
}

// ============================ رندر ============================

function fmtNum(n) { return (n === null || n === undefined || isNaN(n)) ? '—' : Math.round(n).toLocaleString(); }
function fmtPct(n, digits = 1) { return (n === null || n === undefined) ? '—' : `${n.toFixed(digits)}٪`; }
function fmtR(n) { return (n === null || n === undefined) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`; }

// Minimal UI — create a simple panel so users can see status and basic info.
let _panelRoot = null;
function createPanel() {
  if (document.getElementById('dgs-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'dgs-panel';
  panel.innerHTML = `
    <div id="dgs-header">
      <div class="dgs-title">DaryaGold Scalping Analyzer</div>
      <button id="dgs-close">✕</button>
    </div>
    <div id="dgs-body">
      <div class="dgs-monitor">
        <div class="dgs-mon-price" id="dgs-price">—</div>
        <div class="dgs-mon-meta">
          <div class="dgs-mon-ts" id="dgs-status">در حال آماده‌سازی...</div>
          <div id="dgs-badge" class="dgs-badge dgs-badge-error">—</div>
        </div>
      </div>
      <div id="dgs-setup-area"></div>
      <div class="dgs-patterns" id="dgs-patterns"></div>
      <div style="margin-top:8px">
        <div class="dgs-bt-controls">
          <label>Slippage:</label>
          <input id="dgs-slippage-input" placeholder="مثلا 10" />
          <button id="dgs-run-backtest">Run Backtest</button>
        </div>
      </div>
      <div id="dgs-backtest-result" style="margin-top:8px;font-size:12px;color:#cbd5e1"></div>
    </div>
  `;
  document.body.appendChild(panel);
  _panelRoot = panel;

  panel.querySelector('#dgs-close').addEventListener('click', () => { panel.remove(); _panelRoot = null; });
  panel.querySelector('#dgs-run-backtest').addEventListener('click', () => { runBacktestNow(); });
}

function updatePriceUI(price) {
  try {
    if (!_panelRoot) return;
    const priceEl = document.getElementById('dgs-price');
    if (priceEl) priceEl.textContent = price !== undefined ? price.toLocaleString() : '—';
    const statusEl = document.getElementById('dgs-status');
    const badgeEl = document.getElementById('dgs-badge');
    const status = getDataStatus();
    if (statusEl) statusEl.textContent = status.label;
    if (badgeEl) {
      badgeEl.className = 'dgs-badge';
      if (status.level === 'live') badgeEl.classList.add('dgs-badge-live');
      else if (status.level === 'synced') badgeEl.classList.add('dgs-badge-synced');
      else if (status.level === 'delayed') badgeEl.classList.add('dgs-badge-delayed');
      else badgeEl.classList.add('dgs-badge-error');
    }
  } catch (e) { /* silent */ }
}

function renderLiveMonitor() {
  updatePriceUI(currentMinuteCandle ? currentMinuteCandle.close : (raw1m.at(-1)?.close || '—'));
}

function renderContext() {
  // reserved for HTF context — show counts
  if (!_panelRoot) return;
  const area = document.getElementById('dgs-setup-area');
  if (!area) return;
  const htf5Count = resampler5 ? resampler5.getAll().length : 0;
  const htf15Count = resampler15 ? resampler15.getAll().length : 0;
  area.innerHTML = `<div style="font-size:12px;color:#94a3b8">HTF5: ${htf5Count} bars · HTF15: ${htf15Count} bars · 1m: ${raw1m.length} bars</div>`;
}

function renderSetup() {
  if (!_panelRoot) return;
  const container = document.getElementById('dgs-setup-area');
  if (!container) return;
  if (activeSetup) {
    container.innerHTML = `
      <div class="dgs-setup-card ${activeSetup.direction === 'long' ? 'dgs-setup-long' : 'dgs-setup-short'}">
        <div class="dgs-setup-dir">${activeSetup.direction === 'long' ? 'LONG' : 'SHORT'}</div>
        <div class="dgs-setup-levels">Entry: ${fmtNum(activeSetup.entry)} · SL: ${fmtNum(activeSetup.sl)} · TP: ${fmtNum(activeSetup.tp)} · RR: ${activeSetup.rr ? activeSetup.rr.toFixed(2) : '—'}</div>
        <div class="dgs-setup-reasons">${(activeSetup.reasonTags || []).join(' · ')}</div>
      </div>
    `;
  } else if (lastResolution) {
    const cls = lastResolution.outcome === 'TARGET_HIT' ? 'dgs-win' : 'dgs-loss';
    container.innerHTML = `<div class="dgs-resolution ${cls}">Latest: ${lastResolution.outcome} @ ${fmtNum(lastResolution.exitPrice)}</div>`;
  } else {
    container.innerHTML = '';
  }
}

function renderPatterns() {
  if (!_panelRoot) return;
  const box = document.getElementById('dgs-patterns');
  if (!box) return;
  if (!lastDetectedPatterns || lastDetectedPatterns.length === 0) {
    box.innerHTML = `<div class="dgs-patterns-title">الگوها</div><div class="dgs-patterns-empty">— هیچ الگویی شناسایی نشده</div>`;
    return;
  }
  const rows = lastDetectedPatterns.slice(0, 10).map(p => {
    const passed = p.passed ? 'dgs-pattern-passed' : '';
    const title = `${p.direction.toUpperCase()} @ ${fmtNum(p.level)}`;
    const status = p.passed ? 'PASSED' : (p.failReason || 'REJECTED');
    return `<div class="dgs-pattern-row ${passed}"><div>${title}</div><div class="dgs-pattern-status">${status}</div></div>`;
  });
  box.innerHTML = `<div class="dgs-patterns-title">الگوها</div>${rows.join('')}`;
}

function renderBacktestPanel() {
  if (!_panelRoot) return;
  const el = document.getElementById('dgs-backtest-result');
  if (!el) return;
  if (backtestRunning) { el.textContent = 'بکتست در حال اجرا...'; return; }
  if (!cachedBacktest) { el.textContent = 'نتیجه‌ای موجود نیست.'; return; }
  const o = cachedBacktest.overall || {};
  el.innerHTML = `
    <div>Trades: ${o.count || 0} · WinRate: ${o.winRate ? o.winRate.toFixed(1) + '%' : '—'}</div>
    <div>Expectancy: ${o.expectancy ? o.expectancy.toFixed(2) + 'R' : '—'} · MaxDD: ${o.maxDrawdownR !== null ? o.maxDrawdownR.toFixed(2) + 'R' : '—'}</div>
  `;
}

function renderAll() {
  renderLiveMonitor();
  renderContext();
  renderSetup();
  renderPatterns();
  renderBacktestPanel();
}

// باقیٔ فایل بدون تغییر — UI و backtest trigger همان قبلی است

async function runBacktestNow() {
  if (backtestRunning) return;
  backtestRunning = true;
  renderBacktestPanel();

  await new Promise(r => setTimeout(r, 30));

  try {
    const slippageInput = document.getElementById('dgs-slippage-input');
    const customSlippage = slippageInput && slippageInput.value ? parseFloat(slippageInput.value) : undefined;
    const opts = customSlippage !== undefined && !isNaN(customSlippage) ? { slippageAbs: customSlippage } : {};
    cachedBacktest = window.DGBacktest.fullReport(raw1m, CFG, opts);
  } catch (e) {
    console.error('[Scalper] خطا در بک‌تست:', e);
    cachedBacktest = null;
  }
  backtestRunning = false;
  renderBacktestPanel();
}

// ----------------- Initialization -----------------
(async function initScalper() {
  try {
    createPanel();

    // create resamplers
    resampler5 = window.DGTimeframe.createResampler(5);
    resampler15 = window.DGTimeframe.createResampler(15);

    // try to fetch historical candles and seed internal state
    const hist = await fetchHistorical1m();
    if (hist && hist.length) {
      raw1m = hist.slice(-MAX_1M_CANDLES);
      for (const c of raw1m) {
        resampler5.push(c);
        resampler15.push(c);
      }
    }

    renderAll();
    connectWebSocket();

    // periodic UI update in case no ticks arrive
    setInterval(() => { renderAll(); }, 2000);
  } catch (e) {
    console.error('[Scalper] خطا در init:', e);
  }
})();
