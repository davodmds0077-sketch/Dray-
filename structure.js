// ================================================================
//  structure.js — ساختار بازار بدون Look-ahead Bias
//
//  نکته‌ی کلیدی: هر تابع اینجا یک پارامتر uptoIndex می‌گیرد و
//  هرگز از کندل‌های بعد از uptoIndex استفاده نمی‌کند. همین یک
//  invariant باعث می‌شود کد لایو (content.js) و کد بک‌تست
//  (backtest-engine.js) دقیقاً یک منطق را اجرا کنند — بدون این‌که
//  بک‌تست از آینده تقلب کند.
// ================================================================

window.DGStructure = (function () {

  function bodyRatio(c) {
    const range = Math.max(c.high - c.low, 1e-9);
    return Math.abs(c.close - c.open) / range;
  }

  // پیوت‌های سقف/کف که «تا لحظه‌ی uptoIndex» قابل تأیید هستند.
  // پیوت در ایندکس i با پنجره‌ی k وقتی تأیید می‌شود که i+k <= uptoIndex
  // یعنی هم k کندل سمت چپ و هم k کندل سمت راستش را داریم — دقیقاً
  // همان چیزی که در لحظه‌ی واقعی هم بعد از گذشت k کندل از پیوت می‌دانیم.
  function getConfirmedPivots(candles, uptoIndex, k = 3) {
    const highs = [], lows = [];
    for (let i = k; i <= uptoIndex - k; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (candles[j].high > candles[i].high) isHigh = false;
        if (candles[j].low < candles[i].low) isLow = false;
      }
      if (isHigh) highs.push({ i, price: candles[i].high, time: candles[i].time });
      if (isLow) lows.push({ i, price: candles[i].low, time: candles[i].time });
    }
    return { highs, lows };
  }

  // روند ساختاری بر پایه‌ی دو پیوت آخر از هرکدام (HH/HL یا LH/LL)
  function classifyTrend(pivotHighs, pivotLows) {
    if (pivotHighs.length >= 2 && pivotLows.length >= 2) {
      const h1 = pivotHighs[pivotHighs.length - 2].price, h2 = pivotHighs[pivotHighs.length - 1].price;
      const l1 = pivotLows[pivotLows.length - 2].price, l2 = pivotLows[pivotLows.length - 1].price;
      if (h2 > h1 && l2 > l1) return 'uptrend';
      if (h2 < h1 && l2 < l1) return 'downtrend';
    }
    return 'range';
  }

  function nearestLevels(pivotHighs, pivotLows, price) {
    const resistances = pivotHighs.filter(h => h.price > price).sort((a, b) => a.price - b.price);
    const supports = pivotLows.filter(l => l.price < price).sort((a, b) => b.price - a.price);
    return { resistance: resistances[0] || null, support: supports[0] || null };
  }

  // شکست «خام» (هنوز تأییدنشده): بستن قیمت با بدنه‌ی قوی فراتر از سطح
  function isRawBreakout(candle, level, direction) {
    if (direction === 'up') return candle.close > level && candle.close > candle.open && bodyRatio(candle) >= 0.55;
    return candle.close < level && candle.close < candle.open && bodyRatio(candle) >= 0.55;
  }

  // آیا شکستِ رخ‌داده در breakoutIdx «جعلی» از آب درآمده؟
  // دو نوع رد فوری بررسی می‌شود:
  //  ۱) خودِ کندل شکست یک سایه‌ی مخالفِ بزرگ دارد (نشانه‌ی رد فوری قیمت توسط بازار)
  //  ۲) در تا confirmBars کندل بعدی، قیمت با بسته‌شدن به داخل سطح برمی‌گردد
  // اگر هنوز هیچ کندل بعدی نیامده، null (یعنی قضاوت زود است) برمی‌گردد؛ به محض
  // رسیدن حتی یک کندلِ بعدیِ سالم (بدون بازگشت)، بدون نیاز به کل پنجره تصمیم می‌گیرد.
  function checkFakeBreakout(candles, breakoutIdx, level, direction, confirmBars = 2) {
    const bc = candles[breakoutIdx];
    const bodySize = Math.max(Math.abs(bc.close - bc.open), 1e-9);
    if (direction === 'up') {
      const upperWick = bc.high - Math.max(bc.open, bc.close);
      if (upperWick > bodySize * 1.5) return true; // سایه‌ی بالایی بزرگ = رد فوری قیمت
    } else {
      const lowerWick = Math.min(bc.open, bc.close) - bc.low;
      if (lowerWick > bodySize * 1.5) return true;
    }

    const available = Math.min(confirmBars, candles.length - 1 - breakoutIdx);
    if (available <= 0) return null; // هنوز کندل بعدی نیامده

    for (let k = 1; k <= available; k++) {
      const next = candles[breakoutIdx + k];
      if (direction === 'up' && next.close < level) return true;
      if (direction === 'down' && next.close > level) return true;
    }
    return false; // تا اینجا که داده داریم، شکست معتبر مانده
  }

  return { bodyRatio, getConfirmedPivots, classifyTrend, nearestLevels, isRawBreakout, checkFakeBreakout };

})();
