'use strict';

/**
 * Pure indicator math on {time,open,high,low,close,volume} bar arrays.
 */

function ema(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;
  const k = 2 / (length + 1);
  let prev = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = prev;
  for (let i = length; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing, as used by the classic ATR/RSI definitions. */
function rma(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;
  let prev = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = prev;
  for (let i = length; i < values.length; i++) {
    prev = (prev * (length - 1) + values[i]) / length;
    out[i] = prev;
  }
  return out;
}

/** True range per bar, then Wilder-smoothed into ATR. */
function atr(bars, length = 14) {
  const tr = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose),
    );
  });
  return rma(tr, length);
}

/**
 * Rolling highest-high / lowest-low over `length` bars BEFORE index i
 * (the bar at i itself is excluded — this is what makes it a breakout
 * level rather than a trivial self-inclusive max/min).
 */
function donchian(bars, length = 20) {
  const highs = new Array(bars.length).fill(null);
  const lows = new Array(bars.length).fill(null);
  for (let i = length; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - length; j < i; j++) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    highs[i] = hi;
    lows[i] = lo;
  }
  return { highs, lows };
}

module.exports = { ema, rma, atr, donchian };
