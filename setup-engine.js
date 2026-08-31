// ================================================================
//  setup-engine.js — تشخیص Setup بر اساس ساختار بازار (نه اندیکاتور صرف)
//
//  فلسفه: به‌جای واکنش به هر تیک، فقط وقتی یک الگوی ساختاری کامل
//  می‌شود (شکست تأییدشده + ریتست + واکنش قیمت + هم‌جهتی با تایم‌فریم
//  بالاتر + R:R قابل‌قبول + تایید اندیکاتوری) یک Setup صادر می‌شود.
//  این Setup تا وقتی SL/TP نخورده یا ساختار واقعاً نقض نشده، دست‌نخورده باقی می‌ماند.
// ================================================================

window.DGSetupEngine = (function () {

  const DEFAULT_CONFIG = {
    pivotK: 3,                  // پنجره‌ی تشخیص پیوت (کندل چپ/راست)
    breakoutLookback: 30,       // چند کندل ۱ دقیقه‌ای به عقب دنبال آخرین شکست معتبر بگرد
    retestTolerance: 0.5,       // فاصله‌ی مجاز ریتست از سطح، بر حسب ضریب ATR
    slBufferAtr: 0.3,           // بافر اضافه‌ی حد ضرر بر حسب ATR
    minRR: 1.1,                 // حداقل نسبت ریسک به ریوارد قابل‌قبول برای صدور Setup
    minRiskAtrMult: 0.5,        // حداقل فاصله‌ی حد ضرر بر حسب ATR — رد کردن استاپ‌های خیلی تنگ
    minRiskPct: 0.00003,        // کف بسیار حداقلی صرفاً برای رد کردن استاپ‌های تقریباً صفر
    htfSlopeThreshold: 0.0015,  // آستانه‌ی شیب نرمالایزشده برای «روند قوی» در تایم‌فریم بالاتر
    fakeBreakoutConfirmBars: 2,  // چند کندل بعد از شکست را برای رد فیک‌بریک‌اوت بررسی کن

    // پارامترهای جدید برای تایید اندیکاتوری و تعیین TP محافظه‌کارانه
    minRsiConfirm: 55,          // RSI بالاتر از این برای long؛ برای short از کمتر از (100 - this) استفاده می‌شود
    macdHistThreshold: 0,       // آستانهٔ هیستوگرام MACD برای تایید جهت
    momentumThreshold: 0.002,   // آستانهٔ مومنتوم نسبی (مثلا�� 0.2% = 0.002)
    maxTpAtrMult: 6,            // حداکثر TP به صورت چند برابر ATR (اجتناب از اهداف دور)
    baseTpAtrMult: 2,           // TP پایه بر حسب ATR (وقتی مومنتوم خنثی است)
    strongMomentumTpMult: 3,    // وقتی مومنتوم قوی است اجازهٔ بیشتر برای TP
    confirmationNeeded: 2       // تعداد تایید لازم از اندیکاتورها/الگو برای armed شدن
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

  function chooseTpForEntry(price, measuredMove, structuralTp, atrVal, momentumVal, cfg, direction) {
    const sign = direction === 'long' ? 1 : -1;
    const baseTarget = structuralTp !== null ? structuralTp : measuredMove;

    const maxAllowed = price + sign * cfg.maxTpAtrMult * atrVal;
    const baseCand = price + sign * cfg.baseTpAtrMult * atrVal;
    const strongCand = price + sign * cfg.strongMomentumTpMult * atrVal;

    let tpCandidate = (momentumVal !== null && ((direction === 'long' && momentumVal > cfg.momentumThreshold) || (direction === 'short' && momentumVal < -cfg.momentumThreshold))) ? strongCand : baseCand;

    // اگر baseTarget وجود دارد و در جهت مناسب است، محدودش کن
    if (baseTarget !== null && ((direction === 'long' && baseTarget > price) || (direction === 'short' && baseTarget < price))) {
      tpCandidate = direction === 'long' ? Math.min(tpCandidate, baseTarget) : Math.max(tpCandidate, baseTarget);
    }

    // اطمینان از اینکه TP از حد مجاز عبور نکند
    if (direction === 'long') tpCandidate = Math.min(tpCandidate, maxAllowed);
    else tpCandidate = Math.max(tpCandidate, maxAllowed);

    // در نهایت اگر TP خیلی نزدیک یا نامناسب است، برگردان null
    if ((direction === 'long' && tpCandidate <= price) || (direction === 'short' && tpCandidate >= price)) return null;
    return tpCandidate;
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
      if (fake === true) { out.push({ direction: 'long', level: level.price, passed: false, failReason: 'شکست بعداً فیک از آب درآمد (قیمت برگشت داخل محدوده)'}); continue; }
      if (fake === null) continue; // هنوز داده‌ی کافی برای قضاوت نیست — اصلاً به‌عنوان الگو ثبت نکن

      // از نزدیک‌ترین کندل به الان به‌عقب بگرد تا تازه‌ترین ریتست معتبر را پیدا کند
      let matchedCand = null; let matchedIdx = -1;
      for (let r = uptoIndex; r > bIdx; r--) {
        const cand = candles1m[r];
        const nearLevel = cand.low <= level.price + atrVal * cfg.retestTolerance;
        const heldAbove = cand.close > level.price;
        const rejection = cand.close > cand.open;
        if (nearLevel && heldAbove && rejection) { matchedCand = cand; matchedIdx = r; break; }
      }
      if (!matchedCand) continue; // هنوز ریتستی شکل نگرفته — الگوی کامل نیست، ثبت نکن

      const cand = matchedCand;

      // محاسبهٔ اندیکاتورها در لحظهٔ ریتست
      const atrAt = window.DGIndicators.atr(candles1m, 14, matchedIdx);
      const rsiVal = window.DGIndicators.rsi(candles1m, 14, matchedIdx);
      const macdObj = window.DGIndicators.macd(candles1m, matchedIdx);
      const mom = window.DGIndicators.momentum(candles1m, 5, matchedIdx);
      const pattern = window.DGIndicators.detectCandlePattern(candles1m, matchedIdx);

      // تعیین SL اولیه
      const sl = Math.min(cand.low, level.price) - (atrAt || atrVal) * cfg.slBufferAtr;

      const nextResistances = highs.filter(h => h.price > price).sort((a, b) => a.price - b.price);
      const measuredMove = price + (candles1m[bIdx].close - level.price);
      const structuralTp = nextResistances[0] ? nextResistances[0].price : null;

      // انتخاب TP منطقی و محافظه‌کارانه با توجه به ATR و مومنتوم
      const tp = chooseTpForEntry(price, measuredMove, structuralTp, (atrAt || atrVal), mom, cfg, 'long');

      const risk = price - sl;
      const reward = tp !== null ? tp - price : -Infinity;

      const item = { direction: 'long', level: level.price, entry: price, sl, tp, createdAtTime: cand.time, passed: true, failReason: null, reasonTags: [] };

      if (!tp || risk <= 0 || reward <= 0) { item.passed = false; item.failReason = 'محاسبه‌ی حد سود/ضرر منطقی از آب درنیامد یا هدف غیرقابل‌دسترس بود'; out.push(item); continue; }

      if (risk < Math.max((atrAt || atrVal) * cfg.minRiskAtrMult, price * cfg.minRiskPct)) { item.passed = false; item.failReason = 'فاصله‌ی حد ضرر خیلی کم است (نویز بازار)'; out.push(item); continue; }

      const rr = reward / risk; item.rr = rr;
      if (rr < cfg.minRR) { item.passed = false; item.failReason = `نسبت سود به ریسک کافی نیست (${rr.toFixed(2)} به جای حداقل ${cfg.minRR})`; out.push(item); continue; }

      const bias5 = htfBias(htf5, cand.time, cfg);
      const bias15 = htfBias(htf15, cand.time, cfg);
      if (bias15 === 'down' && bias5 === 'down') { item.passed = false; item.failReason = 'هم بازه‌ی ۵ دقیقه و هم ۱۵ دقیقه مخالف این جهت‌اند'; out.push(item); continue; }

      // تاییدهای اندیکاتوری — حداقل confirmationNeeded از موارد زیر لازم است
      let confirms = 0;
      if (rsiVal !== null && rsiVal >= cfg.minRsiConfirm) confirms++;
      if (macdObj && macdObj.hist !== null && macdObj.hist > cfg.macdHistThreshold) confirms++;
      if (mom !== null && mom > cfg.momentumThreshold) confirms++;
      if (pattern === 'bullish_engulfing' || pattern === 'hammer') confirms++;

      if (confirms < cfg.confirmationNeeded) { item.passed = false; item.failReason = 'تایید اندیکاتوری کافی نبود'; out.push(item); continue; }

      item.reasonTags = ['قیمت از یک سقف مهم قیمتی عبور کرده', 'بعد از برگش�� به همون نقطه، دوباره خریدارها وارد شدن'];
      if (bias15 === 'up') item.reasonTags.push('HTF 15m: صعودی'); else if (bias15 === 'down') item.reasonTags.push('HTF 15m: نزولی');
      if (bias5 === 'up') item.reasonTags.push('HTF 5m: صعودی'); else if (bias5 === 'down') item.reasonTags.push('HTF 5m: نزولی');
      item.reasonTags.push(`RSI:${rsiVal !== null ? rsiVal.toFixed(0) : '—'}`);
      if (macdObj && macdObj.hist !== null) item.reasonTags.push(`MACD_hist:${macdObj.hist.toFixed(4)}`);
      if (mom !== null) item.reasonTags.push(`mom:${(mom*100).toFixed(2)}%`);
      if (pattern) item.reasonTags.push(`pattern:${pattern}`);

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
      if (fake === true) { out.push({ direction: 'short', level: level.price, passed: false, failReason: 'شکست بعداً فیک از آب درآمد (قیمت برگشت داخل محدوده)'}); continue; }
      if (fake === null) continue;

      let matchedCand = null; let matchedIdx = -1;
      for (let r = uptoIndex; r > bIdx; r--) {
        const cand = candles1m[r];
        const nearLevel = cand.high >= level.price - atrVal * cfg.retestTolerance;
        const heldBelow = cand.close < level.price;
        const rejection = cand.close < cand.open;
        if (nearLevel && heldBelow && rejection) { matchedCand = cand; matchedIdx = r; break; }
      }
      if (!matchedCand) continue;

      const cand = matchedCand;

      const atrAt = window.DGIndicators.atr(candles1m, 14, matchedIdx);
      const rsiVal = window.DGIndicators.rsi(candles1m, 14, matchedIdx);
      const macdObj = window.DGIndicators.macd(candles1m, matchedIdx);
      const mom = window.DGIndicators.momentum(candles1m, 5, matchedIdx);
      const pattern = window.DGIndicators.detectCandlePattern(candles1m, matchedIdx);

      const sl = Math.max(cand.high, level.price) + (atrAt || atrVal) * cfg.slBufferAtr;

      const nextSupports = lows.filter(l => l.price < price).sort((a, b) => b.price - a.price);
      const measuredMove = price - (level.price - candles1m[bIdx].close);
      const structuralTp = nextSupports[0] ? nextSupports[0].price : null;

      const tp = chooseTpForEntry(price, measuredMove, structuralTp, (atrAt || atrVal), mom, cfg, 'short');

      const risk = sl - price;
      const reward = tp !== null ? price - tp : -Infinity;

      const item = { direction: 'short', level: level.price, entry: price, sl, tp, createdAtTime: cand.time, passed: true, failReason: null, reasonTags: [] };

      if (!tp || risk <= 0 || reward <= 0) { item.passed = false; item.failReason = 'محاسبه‌ی حد سود/ضرر منطقی از آب درنیامد یا هدف غیرقابل‌دسترس بود'; out.push(item); continue; }

      if (risk < Math.max((atrAt || atrVal) * cfg.minRiskAtrMult, price * cfg.minRiskPct)) { item.passed = false; item.failReason = 'فاصله‌ی حد ضرر خیلی کم است (نویز بازار)'; out.push(item); continue; }

      const rr = reward / risk; item.rr = rr;
      if (rr < cfg.minRR) { item.passed = false; item.failReason = `نسبت سود به ریسک کافی نیست (${rr.toFixed(2)} به جای حداقل ${cfg.minRR})`; out.push(item); continue; }

      const bias5 = htfBias(htf5, cand.time, cfg);
      const bias15 = htfBias(htf15, cand.time, cfg);
      if (bias15 === 'up' && bias5 === 'up') { item.passed = false; item.failReason = 'هم بازه‌ی ۵ دقیقه و هم ۱۵ دقیقه مخالف این جهت‌اند'; out.push(item); continue; }

      let confirms = 0;
      if (rsiVal !== null && rsiVal <= (100 - cfg.minRsiConfirm)) confirms++;
      if (macdObj && macdObj.hist !== null && macdObj.hist < -cfg.macdHistThreshold) confirms++;
      if (mom !== null && mom < -cfg.momentumThreshold) confirms++;
      if (pattern === 'bearish_engulfing' || pattern === 'shooting_star') confirms++;

      if (confirms < cfg.confirmationNeeded) { item.passed = false; item.failReason = 'تایید اندیکاتوری کافی نبود'; out.push(item); continue; }

      item.reasonTags = ['قیمت از یک کف مهم قیمتی پایین‌تر رفته', 'بعد از برگشت به همون نقطه، دوباره فروشنده‌ها وارد شدند'];
      if (bias15 === 'down') item.reasonTags.push('HTF 15m: نزولی'); else if (bias15 === 'up') item.reasonTags.push('HTF 15m: صعودی');
      if (bias5 === 'down') item.reasonTags.push('HTF 5m: نزولی'); else if (bias5 === 'up') item.reasonTags.push('HTF 5m: صعودی');
      item.reasonTags.push(`RSI:${rsiVal !== null ? rsiVal.toFixed(0) : '—'}`);
      if (macdObj && macdObj.hist !== null) item.reasonTags.push(`MACD_hist:${macdObj.hist.toFixed(4)}`);
      if (mom !== null) item.reasonTags.push(`mom:${(mom*100).toFixed(2)}%`);
      if (pattern) item.reasonTags.push(`pattern:${pattern}`);

      out.push(item);
    }
    return out;
  }

  // اسکن برای Setup جدید — فقط وقتی هیچ Setup فعالی وجود ندارد صدا زده می‌شود.
  // خروجی: { armed: Setup یا null, patterns: همه‌ی الگوهای شناسایی‌شده (رد‌شده یا نه) }
  function scanForSetup(candles1m, uptoIndex, htf5, htf15, cfg = DEFAULT_CONFIG) {
    if (uptoIndex < cfg.pivotK * 2 + 20) return { armed: null, patterns: [] };
    const atrVal = window.DGIndicators.atr(candles1m, 14, uptoIndex);
    if (!atrVal) return { armed: null, patterns: [] };
    const { highs, lows } = window.DGStructure.getConfirmedPivots(candles1m, uptoIndex, cfg.pivotK);
    if (highs.length < 2 || lows.length < 2) return { armed: null, patterns: [] };

    const longCandidates = evaluateLongCandidates(candles1m, uptoIndex, highs, lows, atrVal, htf5, htf15, cfg);
    const shortCandidates = evaluateShortCandidates(candles1m, uptoIndex, highs, lows, atrVal, htf5, htf15, cfg);
    const patterns = [...longCandidates, ...shortCandidates].sort((a, b) => b.createdAtTime - a.createdAtTime);

    const armedRaw = longCandidates.find(c => c.passed) || shortCandidates.find(c => c.passed) || null;
    const armed = armedRaw ? {
      direction: armedRaw.direction,
      createdAtTime: armedRaw.createdAtTime,
      brokenLevel: armedRaw.level,
      entry: armedRaw.entry,
      sl: armedRaw.sl,
      tp: armedRaw.tp,
      rr: armedRaw.rr,
      reasonTags: armedRaw.reasonTags
    } : null;

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
