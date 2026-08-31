// ================================================================
//  indicators.js — حداقل ابزار موردنیاز (بقیه حذف شد تا کد شلوغ نباشه)
// ================================================================

window.DGIndicators = (function () {

  function closes(candles) { return candles.map(c => c.close); }

  function sma(vals, period) {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= period) sum -= vals[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  // ATR (Average True Range) تا ایندکس مشخص — برای بافر حد ضرر و اندازه‌گیری نوسان
  function atr(candles, period = 14, uptoIndex = null) {
    const end = uptoIndex === null ? candles.length - 1 : uptoIndex;
    if (end < period) return null;
    const trs = [];
    for (let i = 1; i <= end; i++) {
      const c = candles[i], prev = candles[i - 1];
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
    }
    // میانگین وایلدر روی کل بازه‌ی موجود تا period آخر
    let value = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) value = (value * (period - 1) + trs[i]) / period;
    return value;
  }

  // شیب نرمالایز‌شده‌ی رگرسیون خطی روی N کندل آخرِ تا ایندکس مشخص (برای تشخیص روند کانتکست)
  function trendSlope(candles, uptoIndex, window_ = 20) {
    const end = uptoIndex === null ? candles.length - 1 : uptoIndex;
    const start = Math.max(0, end - window_ + 1);
    const slice = candles.slice(start, end + 1);
    const n = slice.length;
    if (n < 3) return 0;
    const ys = slice.map(c => c.close);
    const xMean = (n - 1) / 2;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - xMean) * (ys[i] - yMean); den += (i - xMean) ** 2; }
    const slope = den === 0 ? 0 : num / den;
    return yMean === 0 ? 0 : slope / yMean;
  }

  return { closes, sma, atr, trendSlope };

})();
