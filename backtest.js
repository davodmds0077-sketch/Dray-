// ================================================================
//  backtest.js — بک‌تست رویدادمحور (نه فقط نگاه به N کندل بعد)
//
//  اصول رعایت‌شده طبق درخواست:
//  - همان تابع scanForSetup که در لایو استفاده می‌شود، اینجا هم صدا
//    زده می‌شود (کد مشترک) تا هیچ Look-ahead Bias ایجاد نشود.
//  - هر لحظه فقط یک Setup باز است؛ تا SL/TP نخورد، اسکن جدید متوقف است
//    (دقیقاً مثل رفتار زنده — بدون سقف زمانی/تعداد کندل).
//  - وقتی در یک کندل هم SL و هم TP لمس شده باشند، فرض محافظه‌کارانه
//    این است که SL زودتر خورده (نه خوش‌بینانه TP).
//  - Slippage روی قیمت ورود و خروج اعمال می‌شود (به ضرر معامله‌گر).
//  - نتیجه به‌صورت R-multiple ثبت می‌شود تا معیارهای استاندارد
//    (Win Rate, Profit Factor, Expectancy, Max Drawdown) قابل‌محاسبه باشد.
//  - تقسیم Walk-Forward: تاریخچه به دو نیمه‌ی زمانی تقسیم می‌شود تا
//    مشخص شود عملکرد فقط مخصوص یک برهه‌ی خاص نبوده (Out-of-Sample check).
//    توجه: چون این سیستم پارامتر فیت‌شده روی داده ندارد (قوانین ثابت‌اند)،
//    خطر Overfitting به معنای کلاسیک محدودتر است؛ این تقسیم صرفاً برای
//    اطمینان از پایداری رفتار در طول زمان است، نه انتخاب بهترین پارامتر.
// ================================================================

window.DGBacktest = (function () {

  function closeTrade(trades, setup, rawExitPrice, exitIdx, candles1m, outcome, slippageAbs) {
    let entryPrice = setup.entry;
    let exitPrice = rawExitPrice;

    if (setup.direction === 'long') {
      entryPrice += slippageAbs;   // خرید کمی گران‌تر از قیمت لحظه‌ی تصمیم
      exitPrice -= slippageAbs;    // فروش کمی ارزان‌تر
    } else {
      entryPrice -= slippageAbs;
      exitPrice += slippageAbs;
    }

    const risk = Math.abs(setup.entry - setup.sl);
    const pnl = setup.direction === 'long' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const rMultiple = risk > 0 ? pnl / risk : 0;

    trades.push({
      direction: setup.direction,
      entryIndex: setup.entryIndex,
      exitIndex: exitIdx,
      entryTime: candles1m[setup.entryIndex].time,
      exitTime: candles1m[exitIdx].time,
      entryPrice, exitPrice,
      sl: setup.sl, tp: setup.tp,
      plannedRR: setup.rr,
      outcome, rMultiple,
      reasonTags: setup.reasonTags
    });
  }

  // opts: { slippageAbs: عدد ثابت به تومان به‌ازای هر پایه (پیش‌فرض محافظه‌کارانه) }
  function runFullBacktest(candles1m, cfg, opts = {}) {
    const slippageAbs = opts.slippageAbs ?? Math.max(1, Math.round((candles1m.at(-1)?.close || 1000000) * 0.00003));
    const resampler5 = window.DGTimeframe.createResampler(5);
    const resampler15 = window.DGTimeframe.createResampler(15);

    let activeSetup = null;
    const trades = [];
    let filteredFakeouts = 0;

    for (let i = 0; i < candles1m.length; i++) {
      resampler5.push(candles1m[i]);
      resampler15.push(candles1m[i]);

      const c = candles1m[i];

      if (activeSetup) {
        const dir = activeSetup.direction;
        const hitSL = dir === 'long' ? c.low <= activeSetup.sl : c.high >= activeSetup.sl;
        const hitTP = dir === 'long' ? c.high >= activeSetup.tp : c.low <= activeSetup.tp;

        if (hitSL) {
          // فرض محافظه‌کارانه: اگر هر دو در یک کندل لمس شدند، SL زودتر خورده
          closeTrade(trades, activeSetup, activeSetup.sl, i, candles1m, 'STOPPED', slippageAbs);
          activeSetup = null;
        } else if (hitTP) {
          closeTrade(trades, activeSetup, activeSetup.tp, i, candles1m, 'TARGET_HIT', slippageAbs);
          activeSetup = null;
        }
        // در غیر این صورت: بدون سقف زمانی/تعداد کندل، معامله باز می‌ماند
        continue;
      }

      if (i < cfg.pivotK * 2 + 20) continue;

      const htf5 = resampler5.getAll();
      const htf15 = resampler15.getAll();
      const result = window.DGSetupEngine.scanForSetup(candles1m, i, htf5, htf15, cfg);
      const candidate = result.armed;
      if (candidate) {
        activeSetup = { ...candidate, entryIndex: i };
      }
    }

    return { trades, filteredFakeouts, slippageAbs };
  }

  function computeMetrics(trades) {
    if (!trades || trades.length === 0) {
      return { count: 0, winRate: null, profitFactor: null, expectancy: null, avgRR: null, maxDrawdownR: null };
    }
    const wins = trades.filter(t => t.rMultiple > 0);
    const losses = trades.filter(t => t.rMultiple <= 0);
    const grossProfit = wins.reduce((s, t) => s + t.rMultiple, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0));

    let equity = 0, peak = 0, maxDD = 0;
    for (const t of trades) {
      equity += t.rMultiple;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak - equity);
    }

    return {
      count: trades.length,
      winRate: (wins.length / trades.length) * 100,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
      expectancy: trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length,
      avgRR: trades.reduce((s, t) => s + t.plannedRR, 0) / trades.length,
      maxDrawdownR: maxDD
    };
  }

  function confidenceFromCount(count) {
    if (count < 10) return { label: 'داده ناکافی برای نتیجه‌گیری آماری', level: 'none' };
    if (count < 25) return { label: 'نمونه کم — با احتیاط بخوانید', level: 'low' };
    if (count < 50) return { label: 'نمونه متوسط', level: 'medium' };
    return { label: 'نمونه نسبتاً قابل‌قبول (هنوز تضمین نیست)', level: 'high' };
  }

  // تقسیم Walk-Forward بر اساس زمان کندل‌ها (نه تعداد ترید) برای اعتبارسنجی خارج از نمونه
  function walkForwardSplit(trades, candles1m) {
    if (!candles1m.length) return { first: [], second: [] };
    const midTime = candles1m[Math.floor(candles1m.length / 2)].time;
    return {
      first: trades.filter(t => t.entryTime < midTime),
      second: trades.filter(t => t.entryTime >= midTime)
    };
  }

  function fullReport(candles1m, cfg, opts) {
    const { trades, slippageAbs } = runFullBacktest(candles1m, cfg, opts);
    const overall = computeMetrics(trades);
    const longTrades = trades.filter(t => t.direction === 'long');
    const shortTrades = trades.filter(t => t.direction === 'short');
    const { first, second } = walkForwardSplit(trades, candles1m);

    // اجرای مقایسه‌ای بدون هزینه/لغزش — فقط برای نشان دادن سهم هزینه‌ی اجرا در نتیجه
    const idealRun = runFullBacktest(candles1m, cfg, { slippageAbs: 0 });
    const idealMetrics = computeMetrics(idealRun.trades);

    return {
      slippageAbs,
      trades,
      overall: { ...overall, confidence: confidenceFromCount(overall.count) },
      long: { ...computeMetrics(longTrades), confidence: confidenceFromCount(longTrades.length) },
      short: { ...computeMetrics(shortTrades), confidence: confidenceFromCount(shortTrades.length) },
      walkForward: {
        firstHalf: { ...computeMetrics(first), confidence: confidenceFromCount(first.length) },
        secondHalf: { ...computeMetrics(second), confidence: confidenceFromCount(second.length) }
      },
      idealNoCost: { ...idealMetrics, confidence: confidenceFromCount(idealMetrics.count) }
    };
  }

  return { runFullBacktest, computeMetrics, confidenceFromCount, walkForwardSplit, fullReport };

})();
