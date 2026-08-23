/**
 * SMC / ICT primitives — pure OHLC math, no chart image required.
 * This is a 1:1 port of the (already-hardened) Python version: ATR-normalized
 * thresholds instead of flat percentages, plus FVG mitigation and order-block
 * invalidation tracking baked in from the start rather than bolted on later.
 */

export function atr(bars, period = 14) {
  if (bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const { high: h, low: l } = bars[i];
    const prevClose = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  const window = trs.length >= period ? trs.slice(-period) : trs;
  return window.length ? window.reduce((a, b) => a + b, 0) / window.length : 0;
}

function rawPivots(bars, left, right) {
  const highs = [];
  const lows = [];
  for (let i = left; i < bars.length - right; i++) {
    const window = bars.slice(i - left, i + right + 1);
    const h = bars[i].high;
    const l = bars[i].low;
    if (h === Math.max(...window.map((w) => w.high))) highs.push([i, h]);
    if (l === Math.min(...window.map((w) => w.low))) lows.push([i, l]);
  }
  return { highs, lows };
}

/**
 * Collapse raw pivots into an alternating H/L sequence, dropping any leg whose
 * amplitude is below minAmplitude. This is what fixes '(left,right) window
 * size changes the structure read' — legs below the volatility floor are
 * treated as noise instead of promoted to swing points.
 */
function zigzagFilter(highs, lows, minAmplitude) {
  if (minAmplitude <= 0) return { highs, lows };
  const points = [...highs.map(([i, p]) => [i, p, "H"]), ...lows.map(([i, p]) => [i, p, "L"])].sort(
    (a, b) => a[0] - b[0]
  );
  if (!points.length) return { highs, lows };
  const kept = [points[0]];
  for (let idx = 1; idx < points.length; idx++) {
    const pt = points[idx];
    const last = kept[kept.length - 1];
    if (pt[2] === last[2]) {
      if ((pt[2] === "H" && pt[1] > last[1]) || (pt[2] === "L" && pt[1] < last[1])) {
        kept[kept.length - 1] = pt;
      }
      continue;
    }
    if (Math.abs(pt[1] - last[1]) >= minAmplitude) kept.push(pt);
  }
  return {
    highs: kept.filter((p) => p[2] === "H").map(([i, p]) => [i, p]),
    lows: kept.filter((p) => p[2] === "L").map(([i, p]) => [i, p]),
  };
}

/**
 * Swing highs/lows filtered by a minimum amplitude of minAtrMult * ATR.
 * Self-normalizes across timeframes: '1x ATR' means the same relative
 * significance on 1H as on 1W, no separate constant per timeframe.
 */
export function findSwings(bars, { left = 2, right = 2, minAtrMult = 1.0, atrPeriod = 14 } = {}) {
  const { highs, lows } = rawPivots(bars, left, right);
  const atrVal = atr(bars, atrPeriod);
  return zigzagFilter(highs, lows, atrVal * minAtrMult);
}

/**
 * 3-candle imbalance: candle1 high/low vs candle3 low/high.
 * A gap is 'mitigated' once later price trades back into it — at that point
 * it stops being a live imbalance and is dropped by default instead of
 * staying in the score forever.
 */
export function findFvgs(bars, { dropMitigated = true } = {}) {
  const fvgs = [];
  for (let i = 2; i < bars.length; i++) {
    const c1 = bars[i - 2];
    const c3 = bars[i];
    let gap = null;
    if (c1.high < c3.low) {
      gap = { type: "bullish", top: c3.low, bottom: c1.high, index: i };
    } else if (c1.low > c3.high) {
      gap = { type: "bearish", top: c1.low, bottom: c3.high, index: i };
    }
    if (!gap) continue;
    const later = bars.slice(i + 1);
    gap.mitigated =
      gap.type === "bullish" ? later.some((b) => b.low <= gap.bottom) : later.some((b) => b.high >= gap.top);
    fvgs.push(gap);
  }
  return dropMitigated ? fvgs.filter((f) => !f.mitigated) : fvgs;
}

/**
 * Last opposite-colored candle immediately before an impulsive move.
 * 'Impulsive' = move > impulseAtrMult * ATR (ATR-scaled, not a flat percent),
 * so the same rule is comparable across 1H and 1W. Tracks 'tested' (price
 * returned once — normal, expected for an OB entry) vs 'invalidated' (price
 * closed through it against the expected direction — zone is dead).
 */
export function findOrderBlocks(
  bars,
  { lookahead = 3, impulseAtrMult = 1.2, atrPeriod = 14, dropInvalidated = true } = {}
) {
  const atrVal = atr(bars, atrPeriod);
  if (atrVal <= 0) return [];
  const threshold = atrVal * impulseAtrMult;
  const obs = [];
  for (let i = 0; i < bars.length - lookahead; i++) {
    const c = bars[i];
    const fwd = bars.slice(i + 1, i + 1 + lookahead);
    if (!fwd.length) continue;
    const move = fwd[fwd.length - 1].close - c.close;
    let ob = null;
    if (c.close < c.open && move > threshold) {
      ob = { type: "bullish_ob", top: c.high, bottom: c.low, index: i };
    } else if (c.close > c.open && move < -threshold) {
      ob = { type: "bearish_ob", top: c.high, bottom: c.low, index: i };
    }
    if (!ob) continue;
    const later = bars.slice(i + 1);
    if (ob.type === "bullish_ob") {
      ob.invalidated = later.some((b) => b.close < ob.bottom);
      ob.tested = later.some((b) => b.low <= ob.top);
    } else {
      ob.invalidated = later.some((b) => b.close > ob.top);
      ob.tested = later.some((b) => b.high >= ob.bottom);
    }
    obs.push(ob);
  }
  return dropInvalidated ? obs.filter((o) => !o.invalidated) : obs;
}

export function premiumDiscount(low, high, price) {
  const rng = high - low;
  if (rng <= 0) return {};
  const pct = (price - low) / rng;
  const oteTop = high - rng * 0.618;
  const oteBottom = high - rng * 0.79;
  return {
    rangeLow: round1(low),
    rangeHigh: round1(high),
    pctIntoRange: round1(pct * 100),
    zone: pct > 0.5 ? "PREMIUM" : "DISCOUNT",
    equilibrium: round1(low + rng * 0.5),
    oteZone: [round1(oteBottom), round1(oteTop)],
  };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
