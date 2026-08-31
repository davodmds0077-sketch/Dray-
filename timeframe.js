// ================================================================
//  timeframe.js — تجمیع کندل‌های ۱ دقیقه‌ای به بازه‌های بزرگ‌تر
//  نسخه‌ی incremental برای استفاده در حلقه‌ی زنده/بک‌تست (بدون
//  محاسبه‌ی مجدد کل تاریخچه در هر قدم)
// ================================================================

window.DGTimeframe = (function () {

  function resample(candles1m, minutes) {
    if (minutes === 1) return candles1m.slice();
    const groups = new Map();
    for (const c of candles1m) {
      const bucket = Math.floor(c.time / (minutes * 60)) * (minutes * 60);
      if (!groups.has(bucket)) {
        groups.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      } else {
        const g = groups.get(bucket);
        g.high = Math.max(g.high, c.high);
        g.low = Math.min(g.low, c.low);
        g.close = c.close;
        g.volume += c.volume;
      }
    }
    return [...groups.values()].sort((a, b) => a.time - b.time);
  }

  function createResampler(minutes) {
    const closed = [];
    let current = null;

    function push(c) {
      const bucket = Math.floor(c.time / (minutes * 60)) * (minutes * 60);
      if (!current || current.time !== bucket) {
        if (current) closed.push(current);
        current = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      } else {
        current.high = Math.max(current.high, c.high);
        current.low = Math.min(current.low, c.low);
        current.close = c.close;
        current.volume += c.volume;
      }
    }

    return {
      push,
      getClosed: () => closed,
      getAll: () => (current ? [...closed, current] : closed)
    };
  }

  return { resample, createResampler };

})();
