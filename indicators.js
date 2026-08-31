// ================================================================
//  indicators.js — حداقل ابزار موردنیاز (بقیه حذف شد تا کد شلوغ نباشه)
//  افزوده: RSI, EMA, MACD, Momentum، شناسایی الگوهای کندلی ساده
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

  // EMA helper — بازگشتی روی آرایه‌ی مقادیر
  function ema(vals, period) {
    const out = new Array(vals.length).fill(null);
    const alpha = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (i === 0) { prev = v; out[i] = v; continue; }
      if (prev === null) { prev = v; out[i] = v; continue; }
      prev = (v * alpha) + (prev * (1 - alpha));
      out[i] = prev;
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

  // RSI با فرمول وایلدر — مقدار در uptoIndex
  function rsi(candles, period = 14, uptoIndex = null) {
    const end = uptoIndex === null ? candles.length - 1 : uptoIndex;
    if (end < period) return null;
    const closesArr = closes(candles);
    let gains = 0, losses = 0;
    // ابتدا مقدار اولیه را محاسبه کن
    for (let i = 1; i <= period; i++) {
      const diff = closesArr[i] - closesArr[i - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    if (end === period) return avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i <= end; i++) {
      const diff = closesArr[i] - closesArr[i - 1];
      const g = diff > 0 ? diff : 0;
      const l = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // MACD ساده — بازگشت مقدار هیستوگرام در uptoIndex
  function macd(candles, uptoIndex = null, fast = 12, slow = 26, signal = 9) {
    const end = uptoIndex === null ? candles.length - 1 : uptoIndex;
    const closesArr = closes(candles).slice(0, end + 1);
    if (closesArr.length < slow) return null;
    const emaFast = ema(closesArr, fast);
    const emaSlow = ema(closesArr, slow);
    const macdLine = closesArr.map((_, i) => (emaFast[i] === null || emaSlow[i] === null) ? null : emaFast[i] - emaSlow[i]);
    const signalLine = ema(macdLine.map(v => v === null ? 0 : v), signal);
    const i = macdLine.length - 1;
    const macdVal = macdLine[i];
    const sigVal = signalLine[i];
    const hist = (macdVal === null || sigVal === null) ? null : macdVal - sigVal;
    return { macd: macdVal, signal: sigVal, hist };
  }

  // مومنتوم ساده — تغییر درصدی بین close و close قبل N کندل
  function momentum(candles, period = 5, uptoIndex = null) {
    const end = uptoIndex === null ? candles.length - 1 : uptoIndex;
    if (end < period) return null;
    const c = candles[end].close;
    const prev = candles[end - period].close;
    if (prev === 0) return 0;
    return (c - prev) / prev;
  }

  // الگوهای کندلی ساده در اندیس idx (مثل Bullish Engulfing, Hammer, Shooting Star)
  function detectCandlePattern(candles, idx) {
    if (idx <= 0 || idx >= candles.length) return null;
    const c = candles[idx];
    const p = candles[idx - 1];

    const body = Math.abs(c.close - c.open);
    const range = Math.max(c.high - c.low, 1e-9);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;

    // Bullish Engulfing
    if (c.close > c.open && p.close < p.open && c.close > p.open && c.open < p.close) return 'bullish_engulfing';
    // Bearish Engulfing
    if (c.close < c.open && p.close > p.open && c.open > p.close && c.close < p.open) return 'bearish_engulfing';
    // Hammer / Pinbar پایین
    if (body < range * 0.4 && lowerWick > body * 2 && lowerWick > upperWick) return 'hammer';
    // Shooting star / Pinbar بالا
    if (body < range * 0.4 && upperWick > body * 2 && upperWick > lowerWick) return 'shooting_star';

    return null;
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

  return { closes, sma, ema, atr, rsi, macd, momentum, detectCandlePattern, trendSlope };

})();
