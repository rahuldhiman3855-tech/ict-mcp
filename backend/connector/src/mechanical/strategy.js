'use strict';

/**
 * Mechanical trend-following state machine. Pure functions only — no I/O,
 * no persistence. The caller loads/saves the "pending setup" state between
 * ticks.
 *
 * Bar arrays are chronological, oldest first; the last element is treated
 * as the most recently CLOSED candle.
 */

const { ema, donchian } = require('./indicators');

const closesOf = (bars) => bars.map((b) => b.close);

/** 1H regime: which direction (if any) is currently in play. */
function evaluateRegime(bars1h) {
  const closes = closesOf(bars1h);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const i = bars1h.length - 1;
  if (ema50[i] == null || ema200[i] == null) return 'none';

  if (ema50[i] > ema200[i] && closes[i] > ema50[i]) return 'bullish';
  if (ema50[i] < ema200[i] && closes[i] < ema50[i]) return 'bearish';
  return 'none';
}

/** Does the 15M trend agree with the 1H regime? */
function confirms15m(bars15m, regime) {
  if (regime === 'none') return false;
  const closes = closesOf(bars15m);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const i = bars15m.length - 1;
  if (ema50[i] == null || ema200[i] == null) return false;

  if (regime === 'bullish') return ema50[i] > ema200[i];
  return ema50[i] < ema200[i];
}

/** Has the latest closed 15M candle broken the prior 20-candle Donchian level? */
function detectBreakout(bars15m, regime) {
  if (regime === 'none') return null;
  const { highs, lows } = donchian(bars15m, 20);
  const i = bars15m.length - 1;
  const current = bars15m[i];

  if (regime === 'bullish' && highs[i] != null && current.close > highs[i]) {
    return { breakoutLevel: highs[i], breakoutDirection: 'BUY', breakoutAt: current.time };
  }
  if (regime === 'bearish' && lows[i] != null && current.close < lows[i]) {
    return { breakoutLevel: lows[i], breakoutDirection: 'SELL', breakoutAt: current.time };
  }
  return null;
}

/**
 * Given a pending breakout, check whether the latest candle satisfies the
 * retest + confirmation sequence, has merely entered the retest zone, or
 * whether too much time has passed and the setup should be abandoned.
 */
function checkRetest(bars15m, pending, atrValue, { retestZoneAtrMult, retestExpiryCandles }) {
  const breakoutIdx = bars15m.findIndex((b) => b.time === pending.breakoutAt);
  // Can't verify freshness if the breakout candle has aged out of the fetched
  // window — safer to expire than to confirm on stale/unknown context.
  if (breakoutIdx === -1) return { action: 'expired' };

  const candlesSinceBreakout = bars15m.length - 1 - breakoutIdx;
  if (candlesSinceBreakout > retestExpiryCandles) return { action: 'expired' };

  const last = bars15m[bars15m.length - 1];
  const prev = bars15m[bars15m.length - 2];
  if (!prev || atrValue == null) return { action: 'waiting' };

  const zoneLo = pending.breakoutLevel - retestZoneAtrMult * atrValue;
  const zoneHi = pending.breakoutLevel + retestZoneAtrMult * atrValue;
  const inZone = last.low <= zoneHi && last.high >= zoneLo;
  if (!inZone) return { action: 'waiting' };

  if (pending.breakoutDirection === 'BUY') {
    if (last.close > last.open && last.close > prev.high) {
      return { action: 'confirmed', entry: last.close };
    }
  } else {
    if (last.close < last.open && last.close < prev.low) {
      return { action: 'confirmed', entry: last.close };
    }
  }
  return { action: 'waiting' };
}

module.exports = { evaluateRegime, confirms15m, detectBreakout, checkRetest };
