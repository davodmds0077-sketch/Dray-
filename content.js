// ================================================================
//  content.js — DaryaGold Scalping Analyzer (1m primary)
//
//  اصول این نسخه:
//  - تحلیل اصلی روی ۱ دقیقه؛ ۵ و ۱۵ دقیقه فقط Context/تأیید هستند.
//  - Setup فقط با بسته‌شدن کندل ۱ دقیقه‌ای اسکن می‌شود، نه با هر Tick؛
//    و تا SL/TP نخورد دست‌نخورده می‌ماند (بدون فلیکر، بدون سقف زمانی).
//  - اگر داده Stale/ناهماهنگ باشد (DELAYED/ERROR)، Setup جدیدی صادر
//    نمی‌شود.
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
  const from = now - 7 * 24 * 60 * 60; // تلاش برای ۷ روز؛ اگر سرور کمتر داشته باشد اشکالی ندارد
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
  wsSocket = new WebSocket(dataSource);

  wsSocket.addEventListener('open', () => {
    wsConnected = true;
    wsReconnectDelay = 1000;
    wsSocket.send(JSON.stringify({ action: 'SubAdd', subs: ['0~DaryaGold~MAZANEH~TMN'] }));
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
  resampler5.push(currentMinuteCandle);
  resampler15.push(currentMinuteCandle);

  // اسکن برای Setup جدید فقط روی کندل تازه‌بسته‌شده، و فقط اگر Setup فعالی نداریم و داده تازه است
  const status = getDataStatus();
  if (!activeSetup && status.level !== 'error' && status.level !== 'delayed') {
    tryScanForSetup();
  }
}

let lastDetectedPatterns = []; // آخرین لیست الگوهای شناسایی‌شده (برای نمایش، جدا از تصمیم نهایی)

function tryScanForSetup() {
  const idx = raw1m.length - 1;
  const result = window.DGSetupEngine.scanForSetup(raw1m, idx, resampler5.getAll(), resampler15.getAll(), CFG);
  lastDetectedPatterns = result.patterns;
  if (result.armed) {
    activeSetup = { ...result.armed, entryIndexInRaw: idx };
    lastResolution = null;
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

function renderAll() {
  renderLiveMonitor();
  renderContext();
  renderSetup();
  renderPatterns();
}

function renderLiveMonitor() {
  const el = document.getElementById('dgs-monitor');
  if (!el) return;
  const status = getDataStatus();
  const price = currentMinuteCandle ? currentMinuteCandle.close : (raw1m.at(-1)?.close ?? null);
  const ts = lastTickAt ? new Date(lastTickAt).toLocaleTimeString('fa-IR') : '—';
  el.innerHTML = `
    <div class="dgs-mon-label">قیمت لحظه‌ای مظنه</div>
    <div class="dgs-mon-price">${fmtNum(price)} <span class="dgs-mon-unit">تومان</span></div>
    <div class="dgs-mon-meta">
      <span class="dgs-badge dgs-badge-${status.level}">${status.label}</span>
      <span class="dgs-mon-ts">ساعت به‌روزرسانی: ${ts}</span>
    </div>
  `;
}

function renderContext() {
  const el = document.getElementById('dgs-context');
  if (!el) return;
  if (!resampler5 || !resampler15) { el.innerHTML = ''; return; }

  const c5 = resampler5.getAll();
  const c15 = resampler15.getAll();
  const trend5 = trendLabelFor(c5);
  const trend15 = trendLabelFor(c15);

  el.innerHTML = `
    <div class="dgs-ctx-item"><span>قدرت حرکت بازار (چند دقیقه‌ی اخیر):</span> <b>${trend5}</b></div>
    <div class="dgs-ctx-item"><span>قدرت حرکت بازار (بازه‌ی بزرگ‌تر):</span> <b>${trend15}</b></div>
  `;
}

function trendLabelFor(candles) {
  if (!candles || candles.length < 15) return 'داده کافی نیست';
  const { highs, lows } = window.DGStructure.getConfirmedPivots(candles, candles.length - 1, 3);
  const trend = window.DGStructure.classifyTrend(highs, lows);
  if (trend === 'uptrend') return '🟢 رو به بالا';
  if (trend === 'downtrend') return '🔴 رو به پایین';
  return '⚪ بدون جهت مشخص';
}

function renderSetup() {
  const el = document.getElementById('dgs-setup');
  if (!el) return;

  if (lastResolution && Date.now() - lastResolution.at < 5 * 60 * 1000) {
    const icon = lastResolution.outcome === 'TARGET_HIT' ? '✅' : '🛑';
    const text = lastResolution.outcome === 'TARGET_HIT' ? 'به حد سود رسید' : 'به حد ضرر رسید';
    el.innerHTML = `
      <div class="dgs-resolution ${lastResolution.outcome === 'TARGET_HIT' ? 'dgs-win' : 'dgs-loss'}">
        ${icon} پیشنهاد قبلی (${lastResolution.direction === 'long' ? 'خرید' : 'فروش'}) ${text} — قیمت خروج: ${fmtNum(lastResolution.exitPrice)} تومان
      </div>
      <div class="dgs-wait">⏳ صبر کنید — در حال بررسی بازار برای پیشنهاد بعدی...</div>
    `;
    return;
  }

  if (!activeSetup) {
    const status = getDataStatus();
    let reason = 'بازار الان الگوی کاملی برای ورود نداره. صبر کنید تا یک نقطه‌ی ورود مطمئن‌تر شکل بگیره.';
    if (status.level === 'delayed' || status.level === 'error') {
      reason = 'داده‌ی قیمت لحظه‌ای به‌روز نیست؛ تا وصل‌شدن دوباره‌ی داده، پیشنهاد جدیدی داده نمی‌شود.';
    } else if (lastDetectedPatterns.length > 0) {
      const nearest = lastDetectedPatterns[0];
      reason = `یک الگو دیده شد (${nearest.direction === 'long' ? 'خرید' : 'فروش'}) ولی هنوز به سیگنال قطعی تبدیل نشده. دلیل: ${nearest.failReason}`;
    }
    el.innerHTML = `<div class="dgs-wait">⏳ صبر کنید<div class="dgs-wait-reason">${reason}</div></div>`;
    return;
  }

  const s = activeSetup;
  const dirLabel = s.direction === 'long' ? '🟢 پیشنهاد خرید' : '🔴 پیشنهاد فروش';
  const dirFa = s.direction === 'long' ? 'خرید' : 'فروش';
  const elapsedMin = Math.max(0, Math.round((Date.now() / 1000 - s.createdAtTime) / 60));
  const strength = signalStrengthLabel(s);

  el.innerHTML = `
    <div class="dgs-setup-card dgs-setup-${s.direction}">
      <div class="dgs-setup-dir">${dirLabel}</div>
      <div class="dgs-setup-levels">
        <div>قیمت ورود: <b>${fmtNum(s.entry)} تومان</b></div>
        <div>حد سود <span class="dgs-hint">(اینجا رسید، معامله رو ببندید)</span>: <b>${fmtNum(s.tp)} تومان</b></div>
        <div>حد ضرر <span class="dgs-hint">(اینجا رسید، از معامله خارج شید)</span>: <b>${fmtNum(s.sl)} تومان</b></div>
      </div>
      <div class="dgs-setup-strength">قدرت سیگنال: <b class="dgs-strength-${strength.level}">${strength.label}</b></div>
      <div class="dgs-setup-invalid">⚠️ شرایط باطل شدن این پیشنهاد: اگر قیمت به حد ضرر (${fmtNum(s.sl)} تومان) برسه، این تحلیل دیگه معتبر نیست.</div>
      <div class="dgs-setup-reasons">دلیل این پیشنهاد: ${s.reasonTags.join('، ')}</div>
      <div class="dgs-setup-meta">از ${elapsedMin} دقیقه پیش فعاله — تا رسیدن به حد سود یا حد ضرر باز می‌مونه.</div>
    </div>
  `;
}

// قدرت سیگنال را با زبان ساده نشان می‌دهد؛ هر جا آمار واقعی بک‌تست موجود باشد از همان استفاده می‌شود
function signalStrengthLabel(s) {
  if (cachedBacktest && !cachedBacktest.error) {
    const dirStats = s.direction === 'long' ? cachedBacktest.long : cachedBacktest.short;
    if (dirStats && dirStats.count >= 15) {
      if (dirStats.winRate >= 55) return { label: 'نسبتاً قوی', level: 'high' };
      if (dirStats.winRate >= 40) return { label: 'متوسط', level: 'medium' };
      return { label: 'ضعیف — با احتیاط', level: 'low' };
    }
  }
  return { label: 'هنوز آمار کافی نیست (پایین رو ببینید)', level: 'unknown' };
}

// همه‌ی الگوهای شناسایی‌شده‌ی اخیر را نشان می‌دهد — چه به سیگنال تبدیل شده باشند چه نه
function renderPatterns() {
  const el = document.getElementById('dgs-patterns');
  if (!el) return;

  if (!lastDetectedPatterns || lastDetectedPatterns.length === 0) {
    el.innerHTML = `<div class="dgs-muted dgs-patterns-empty">فعلاً هیچ الگوی شکست/ریتستی روی نمودار شناسایی نشده.</div>`;
    return;
  }

  const rows = lastDetectedPatterns.slice(0, 5).map(p => {
    const dirFa = p.direction === 'long' ? 'خرید' : 'فروش';
    const icon = p.passed ? '✅' : '⚪';
    const statusText = p.passed ? 'تبدیل به پیشنهاد شد' : p.failReason;
    return `<div class="dgs-pattern-row ${p.passed ? 'dgs-pattern-passed' : ''}">
      <span>${icon} ${dirFa} — نزدیک قیمت ${fmtNum(p.level)} تومان</span>
      <span class="dgs-pattern-status">${statusText}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="dgs-patterns-title">الگوهای شناسایی‌شده‌ی اخیر روی نمودار:</div>${rows}`;
}



function renderBacktestPanel() {
  const box = document.getElementById('dgs-backtest-results');
  if (!box) return;

  if (backtestRunning) {
    box.innerHTML = `<div class="dgs-muted">⏳ در حال بررسی عملکرد سیستم روی ${raw1m.length} کندل گذشته...</div>`;
    return;
  }
  if (!cachedBacktest) {
    box.innerHTML = `<div class="dgs-muted">هنوز بررسی نشده. روی دکمه‌ی «بررسی عملکرد گذشته» بزنید.</div>`;
    return;
  }

  const r = cachedBacktest;

  function metricRow(title, m) {
    if (!m || m.count === 0) return `<div class="dgs-bt-row"><b>${title}:</b> <span class="dgs-muted">هنوز نمونه‌ی کافی نداریم</span></div>`;
    const expectancySign = m.expectancy >= 0 ? 'مثبت (سودده)' : 'منفی (ضررده)';
    return `
      <div class="dgs-bt-block">
        <div class="dgs-bt-title">${title} <span class="dgs-conf dgs-conf-${m.confidence.level}">${m.confidence.label}</span></div>
        <div class="dgs-bt-grid">
          <div>تعداد نمونه: <b>${m.count}</b></div>
          <div>درصد موفقیت: <b>${fmtPct(m.winRate)}</b></div>
          <div>نسبت سود به ضرر: <b>${m.profitFactor === null ? 'خیلی زیاد' : m.profitFactor.toFixed(2)}</b></div>
          <div>نتیجه‌ی میانگین هر معامله: <b>${expectancySign} (${fmtR(m.expectancy)})</b></div>
          <div>نسبت سود به ریسک هر معامله: <b>${m.avgRR.toFixed(2)}</b></div>
          <div>بدترین ضررِ پشت‌سرهم: <b>${m.maxDrawdownR.toFixed(1)} برابر ریسک یک معامله</b></div>
        </div>
      </div>`;
  }

  let html = '';
  html += `<div class="dgs-bt-subtitle">نتیجه‌ی کلی</div>`;
  html += metricRow('همه‌ی پیشنهادها (با احتساب هزینه‌ی واقعی معامله)', r.overall);
  html += metricRow('فقط پیشنهادهای خرید', r.long);
  html += metricRow('فقط پیشنهادهای فروش', r.short);
  html += `<hr class="dgs-hr">`;
  html += `<div class="dgs-bt-subtitle">آیا نتیجه پایدار بوده یا فقط یک دوره‌ی خاص خوب بوده؟</div>`;
  html += metricRow('نیمه‌ی قدیمی‌تر داده‌ها', r.walkForward.firstHalf);
  html += metricRow('نیمه‌ی تازه‌تر داده‌ها', r.walkForward.secondHalf);
  html += `<hr class="dgs-hr">`;
  html += `<div class="dgs-bt-subtitle">تأثیر هزینه‌ی واقعی معامله روی نتیجه</div>`;
  html += `<div class="dgs-bt-row">با احتساب هزینه‌ی هر معامله (${fmtNum(r.slippageAbs)} تومان هر طرف): نتیجه‌ی میانگین هر معامله = ${fmtR(r.overall.expectancy)}</div>`;
  html += metricRow('اگر هیچ هزینه‌ای نبود (فقط برای مقایسه، در واقعیت این‌طور نیست)', r.idealNoCost);
  html += `<div class="dgs-disclaimer">⚠️ این اعداد از رفتار گذشته‌ی همین قیمت به‌دست اومده و تضمینی برای آینده نیست. اگر برچسب کنار هر بخش گفت «نمونه کم»، به اون عدد کمتر تکیه کنید.</div>`;

  box.innerHTML = html;
}

async function runBacktestNow() {
  if (backtestRunning) return;
  backtestRunning = true;
  renderBacktestPanel();

  // برای این‌که UI فریز نشود، یک تیک به Event Loop می‌دهیم
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

// ============================ رابط کاربری ============================

function createPanel() {
  const panel = document.createElement('div');
  panel.id = 'dgs-panel';
  panel.innerHTML = `
    <div id="dgs-header">
      <span class="dgs-title">⚡ دستیار معامله‌ی داریاگلد (کوتاه‌مدت)</span>
      <button id="dgs-minimize" title="جمع کردن">➖</button>
    </div>
    <div id="dgs-body">
      <div id="dgs-monitor" class="dgs-monitor"></div>
      <div id="dgs-context" class="dgs-context"></div>
      <div id="dgs-setup" class="dgs-setup"></div>
      <div id="dgs-patterns" class="dgs-patterns"></div>

      <button id="dgs-details-toggle" class="dgs-details-btn">آمار بک‌تست ▾</button>
      <div id="dgs-details" class="dgs-details" style="display:none;">
        <div class="dgs-bt-controls">
          <label>Slippage فرضی (تومان هر طرف):</label>
          <input id="dgs-slippage-input" type="number" placeholder="پیش‌فرض خودکار" />
          <button id="dgs-run-backtest">اجرای بک‌تست</button>
        </div>
        <div id="dgs-backtest-results"></div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('dgs-minimize').addEventListener('click', () => {
    const body = document.getElementById('dgs-body');
    const btn = document.getElementById('dgs-minimize');
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? 'block' : 'none';
    btn.textContent = hidden ? '➖' : '⬆';
  });

  document.getElementById('dgs-details-toggle').addEventListener('click', () => {
    const box = document.getElementById('dgs-details');
    const btn = document.getElementById('dgs-details-toggle');
    const open = box.style.display !== 'none';
    box.style.display = open ? 'none' : 'block';
    btn.textContent = open ? 'آمار بک‌تست ▾' : 'بستن آمار ▴';
  });

  document.getElementById('dgs-run-backtest').addEventListener('click', runBacktestNow);

  setupDragging(panel, document.getElementById('dgs-header'));
}

function setupDragging(panel, header) {
  let dragging = false, offX = 0, offY = 0;
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = Math.max(0, e.clientX - offX) + 'px';
    panel.style.top = Math.max(0, e.clientY - offY) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

// ============================ شروع ============================

async function init() {
  createPanel();
  resampler5 = window.DGTimeframe.createResampler(5);
  resampler15 = window.DGTimeframe.createResampler(15);

  renderLiveMonitor();
  renderSetup();

  raw1m = await fetchHistorical1m();
  for (const c of raw1m) { resampler5.push(c); resampler15.push(c); }

  connectWebSocket();
  renderAll();

  // آپدیت دوره‌ای کل پنل حتی بدون Tick جدید (تشخیص DELAYED/ERROR، انقضای بنر نتیجه، زمان سپری‌شده‌ی Setup)
  setInterval(renderAll, 1000);
}

init();
