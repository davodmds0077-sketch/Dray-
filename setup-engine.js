// ================================================================
//  setup-engine.js — تشخیص Setup بر اساس ساختار بازار (نه اندیکاتور صرف)
//
//  فلسفه: به‌جای واکنش به هر تیک، فقط وقتی یک الگوی ساختاری کامل
//  می‌شود (شکست تأییدشده + ریتست + واکنش قیمت + هم‌جهتی با تایم‌فریم
//  بالاتر + R:R قابل‌قبول) یک Setup صادر می‌شود. این Setup تا وقتی
//  SL/TP نخورده یا ساختار واقعاً نقض نشده، دست‌نخورده باقی می‌ماند.
// ================================================================

window.DGSetupEngine = (function () {

  const DEFAULT_CONFIG = {
    pivotK: 3,                  // پنجره‌ی تشخیص پیوت (کندل چپ/راست)
    breakoutLookback: 30,       // چند کندل ۱ دقیقه‌ای به عقب دنبال آخرین شکست معتبر بگرد
    retestTolerance: 0.5,       // فاصله‌ی مجاز ریتست از سطح، بر حسب ضریب ATR
    slBufferAtr: 0.3,           // بافر اضافه‌ی حد ضرر بر حسب ATR
    minRR: 1.1,                 // حداقل نسبت ریسک به ریوارد قابل‌قبول برای صدور Setup
    minRiskAtrMult: 0.5,        // حداقل فاصله‌ی حد ضرر بر حسب ATR — رد کردن استاپ‌های خیلی تنگ که Slippage آن‌ها را بی‌معنی می‌کند
    minRiskPct: 0.00003,        // کف بسیار حداقلی صرفاً برای رد کردن استاپ‌های تقریباً صفر؛ فیلتر اصلی همان ATR است
    htfSlopeThreshold: 0.0015,  // آستانه‌ی شیب نرمالایزشده برای «روند قوی» در تایم‌فریم بالاتر
    fakeBreakoutConfirmBars: 2  // چند کندل بعد از شکست را برای رد فیک‌بریک‌اوت بررسی کن
  };

  function findRecentBreakout(candles1m, uptoIndex, level, direction, lookback) {
    const start = Math.max(1, uptoIndex - lookback);
    for (let i = uptoIndex; i >= start; i--) {
      if (window.DGStructure.isRawBreakout(candles1m[i], level, direction)) return i;
    }
    return -1;
  }

  function htfBias(htfCandles, uptoTime, cfg) {
    const usable = htfCandles.filter(c => c.time <= uptoTime);
    if (usable.length < 10) return 'unknown';
    const slope = window.DGIndicators.trendSlope(usable, usable.length - 1, 20);
    if (slope > cfg.htfSlopeThreshold) return 'up';
    if (slope < -cfg.htfSlopeThreshold) return 'down';
    return 'flat';
  }

  // همه‌ی الگوهای «شکست + ریتست تأییدشده» را برمی‌گرداند — چه شرایط کامل صدور Setup را
  // داشته باشند چه نه. این تابع تشخیصِ الگو را از تصمیم نهایی (صدور/عدم‌صدور) جدا می‌کند.
  function evaluateLongCandidates(candles1m, uptoIndex, highs, lows, atrVal, htf5, htf15, cfg) {
    const price = candles1m[uptoIndex].close;
    const brokenResistances = highs.filter(h => h.price < price).sort((a, b) => b.price - a.price).slice(0, 3);
    const out = [];

    for (const level of brokenResistances) {
      const bIdx = findRecentBreakout(candles1m, uptoIndex, level.price, 'up', cfg.breakoutLookback);
      if (bIdx === -1 || bIdx <= level.i) continue;

      const fake = window.DGStructure.checkFakeBreakout(candles1m, bIdx, level.price, 'up', cfg.fakeBreakoutConfirmBars);
      if (fake === true) { out.push({ direction: 'long', level: level.price, passed: false, failReason: 'شکست بعداً فیک از آب درآمد (قیمت برگشت داخل محدوده)' }); continue; }
      if (fake === null) continue; // هنوز داده‌ی کافی برای قضاوت نیست — اصلاً به‌عنوان الگو ثبت نکن

      // از نزدیک‌ترین کندل به الان به‌عقب بگرد تا تازه‌ترین ریتست معتبر را پیدا کند
      let matchedCand = null;
      for (let r = uptoIndex; r > bIdx; r--) {
        const cand = candles1m[r];
        const nearLevel = cand.low <= level.price + atrVal * cfg.retestTolerance;
        const heldAbove = cand.close > level.price;
        const rejection = cand.close > cand.open;
        if (nearLevel && heldAbove && rejection) { matchedCand = cand; break; }
      }
      if (!matchedCand) continue; // هنوز ریتستی شکل نگرفته — الگوی کامل نیست، ثبت نکن

      const cand = matchedCand;
      const sl = Math.min(cand.low, level.price) - atrVal * cfg.slBufferAtr;
      const nextResistances = highs.filter(h => h.price > price).sort((a, b) => a.price - b.price);
      const measuredMove = price + (candles1m[bIdx].close - level.price);
      const structuralTp = nextResistances[0] ? nextResistances[0].price : null;
      const tp = structuralTp && structuralTp > measuredMove ? structuralTp : measuredMove;
      const risk = price - sl, reward = tp - price;

      const item = { direction: 'long', level: level.price, entry: price, sl, tp, createdAtTime: cand.time, passed: true, failReason: null, reasonTags: [] };

      if (risk <= 0 || reward <= 0) { item.passed = false; item.failReason = 'محاسبه‌ی حد سود/ضرر منطقی از آب درنیامد'; out.push(item); continue; }
      if (risk < Math.max(atrVal * cfg.minRiskAtrMult, price * cfg.minRiskPct)) { item.passed = false; item.failReason = 'فاصله‌ی حد ضرر خیلی کم است (نویز بازار می‌تونه اشتباهی فعالش کنه)'; out.push(item); continue; }
      const rr = reward / risk;
      item.rr = rr;
      if (rr < cfg.minRR) { item.passed = false; item.failReason = `نسبت سود به ریسک کافی نیست (${rr.toFixed(2)} به جای حداقل ${cfg.minRR})`; out.push(item); continue; }

      const bias5 = htfBias(htf5, cand.time, cfg);
      const bias15 = htfBias(htf15, cand.time, cfg);
      if (bias15 === 'down' && bias5 === 'down') { item.passed = false; item.failReason = 'هم بازه‌ی ۵ دقیقه و هم ۱۵ دقیقه مخالف این جهت‌اند'; out.push(item); continue; }

      item.reasonTags = ['قیمت از یک سقف مهم قیمتی عبور کرده', 'بعد از برگشت به همون نقطه، دوباره خریدارها وارد شدن',
        bias15 === 'up' ? 'حرکت بازار در بازه‌ی زمانی بزرگ‌تر هم رو به بالاست' : 'حرکت بازار در بازه‌ی بزرگ‌تر خنثی است (مخالف نیست)',
        bias5 === 'up' ? 'حرکت اخیر بازار هم رو به بالاست' : 'حرکت اخیر بازار خنثی است (مخالف نیست)'];
      out.push(item);
    }
    return out;
  }

  function evaluateShortCandidates(candles1m, uptoIndex, highs, lows, atrVal, htf5, htf15, cfg) {
    const price = candles1m[uptoIndex].close;
    const brokenSupports = lows.filter(l => l.price > price).sort((a, b) => a.price - b.price).slice(0, 3);
    const out = [];

    for (const level of brokenSupports) {
      const bIdx = findRecentBreakout(candles1m, uptoIndex, level.price, 'down', cfg.breakoutLookback);
      if (bIdx === -1 || bIdx <= level.i) continue;

      const fake = window.DGStructure.checkFakeBreakout(candles1m, bIdx, level.price, 'down', cfg.fakeBreakoutConfirmBars);
      if (fake === true) { out.push({ direction: 'short', level: level.price, passed: false, failReason: 'شکست بعداً فیک از آب درآمد (قیمت برگشت داخل محدوده)' }); continue; }
      if (fake === null) continue;

      let matchedCand = null;
      for (let r = uptoIndex; r > bIdx; r--) {
        const cand = candles1m[r];
        const nearLevel = cand.high >= level.price - atrVal * cfg.retestTolerance;
        const heldBelow = cand.close < level.price;
        const rejection = cand.close < cand.open;
        if (nearLevel && heldBelow && rejection) { matchedCand = cand; break; }
      }
      if (!matchedCand) continue;

      const cand = matchedCand;
      const sl = Math.max(cand.high, level.price) + atrVal * cfg.slBufferAtr;
      const nextSupports = lows.filter(l => l.price < price).sort((a, b) => b.price - a.price);
      const measuredMove = price - (level.price - candles1m[bIdx].close);
      const structuralTp = nextSupports[0] ? nextSupports[0].price : null;
      const tp = structuralTp && structuralTp < measuredMove ? structuralTp : measuredMove;
      const risk = sl - price, reward = price - tp;

      const item = { direction: 'short', level: level.price, entry: price, sl, tp, createdAtTime: cand.time, passed: true, failReason: null, reasonTags: [] };

      if (risk <= 0 || reward <= 0) { item.passed = false; item.failReason = 'محاسبه‌ی حد سود/ضرر منطقی از آب درنیامد'; out.push(item); continue; }
      if (risk < Math.max(atrVal * cfg.minRiskAtrMult, price * cfg.minRiskPct)) { item.passed = false; item.failReason = 'فاصله‌ی حد ضرر خیلی کم است (نویز بازار می‌تونه اشتباهی فعالش کنه)'; out.push(item); continue; }
      const rr = reward / risk;
      item.rr = rr;
      if (rr < cfg.minRR) { item.passed = false; item.failReason = `نسبت سود به ریسک کافی نیست (${rr.toFixed(2)} به جای حداقل ${cfg.minRR})`; out.push(item); continue; }

      const bias5 = htfBias(htf5, cand.time, cfg);
      const bias15 = htfBias(htf15, cand.time, cfg);
      if (bias15 === 'up' && bias5 === 'up') { item.passed = false; item.failReason = 'هم بازه‌ی ۵ دقیقه و هم ۱۵ دقیقه مخالف این جهت‌اند'; out.push(item); continue; }

      item.reasonTags = ['قیمت از یک کف مهم قیمتی پایین‌تر رفته', 'بعد از برگشت به همون نقطه، دوباره فروشنده‌ها وارد شدن',
        bias15 === 'down' ? 'حرکت بازار در بازه‌ی زمانی بزرگ‌تر هم رو به پایین است' : 'حرکت بازار در بازه‌ی بزرگ‌تر خنثی است (مخالف نیست)',
        bias5 === 'down' ? 'حرکت اخیر بازار هم رو به پایین است' : 'حرکت اخیر بازار خنثی است (مخالف نیست)'];
      out.push(item);
    }
    return out;
  }

  // اسکن برای Setup جدید — فقط وقتی هیچ Setup فعالی وجود ندارد صدا زده می‌شود.
  // خروجی: { armed: Setup یا null, patterns: همه‌ی الگوهای شناسایی‌شده (رد‌شده یا نه) }
  function scanForSetup(candles1m, uptoIndex, htf5, htf15, cfg) {
    if (uptoIndex < cfg.pivotK * 2 + 20) return { armed: null, patterns: [] };
    const atrVal = window.DGIndicators.atr(candles1m, 14, uptoIndex);
    if (!atrVal) return { armed: null, patterns: [] };
    const { highs, lows } = window.DGStructure.getConfirmedPivots(candles1m, uptoIndex, cfg.pivotK);
    if (highs.length < 2 || lows.length < 2) return { armed: null, patterns: [] };

    const longCandidates = evaluateLongCandidates(candles1m, uptoIndex, highs, lows, atrVal, htf5, htf15, cfg);
    const shortCandidates = evaluateShortCandidates(candles1m, uptoIndex, highs, lows, atrVal, htf5, htf15, cfg);
    const patterns = [...longCandidates, ...shortCandidates].sort((a, b) => b.createdAtTime - a.createdAtTime);

    const armedRaw = longCandidates.find(c => c.passed) || shortCandidates.find(c => c.passed) || null;
    const armed = armedRaw ? { direction: armedRaw.direction, createdAtTime: armedRaw.createdAtTime, brokenLevel: armedRaw.level, entry: armedRaw.entry, sl: armedRaw.sl, tp: armedRaw.tp, rr: armedRaw.rr, reasonTags: armedRaw.reasonTags } : null;

    return { armed, patterns };
  }

  // بررسی این‌که آیا Setup فعال با قیمت جاری (لحظه‌ای) تسویه شده یا نه
  function checkResolution(setup, priceForCheck) {
    if (!setup) return null;
    if (setup.direction === 'long') {
      if (priceForCheck <= setup.sl) return 'STOPPED';
      if (priceForCheck >= setup.tp) return 'TARGET_HIT';
    } else {
      if (priceForCheck >= setup.sl) return 'STOPPED';
      if (priceForCheck <= setup.tp) return 'TARGET_HIT';
    }
    return null;
  }

  return { DEFAULT_CONFIG, scanForSetup, checkResolution };

})();
