import { findSwings } from "../smcPrimitives.js";

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Market Structure agent — BOS / CHoCH read off ATR-filtered swings. */
export function structureBias(bars, log) {
  const { highs, lows } = findSwings(bars, { minAtrMult: 1.0 });
  if (highs.length < 2 || lows.length < 2) {
    log?.debug({ event: "structure_insufficient_data", highs: highs.length, lows: lows.length });
    return { bias: "NEUTRAL", score: 0, confidence: 0.2, note: "insufficient swing data" };
  }

  const [, lastHigh] = highs[highs.length - 1];
  const [, prevHigh] = highs[highs.length - 2];
  const [, lastLow] = lows[lows.length - 1];
  const [, prevLow] = lows[lows.length - 2];
  const close = bars[bars.length - 1].close;

  let score;
  if (lastHigh > prevHigh && lastLow > prevLow) score = 0.6; // HH + HL
  else if (lastHigh < prevHigh && lastLow < prevLow) score = -0.6; // LH + LL
  else score = 0.0; // mixed -> possible CHoCH forming

  let note = "Structure holding, no fresh break";
  if (close > lastHigh) {
    score = Math.min(1.0, score + 0.3);
    note = "Bullish BOS: close broke above prior swing high";
  } else if (close < lastLow) {
    score = Math.max(-1.0, score - 0.3);
    note = "Bearish BOS: close broke below prior swing low";
  }

  const bias = score > 0.15 ? "BULLISH" : score < -0.15 ? "BEARISH" : "NEUTRAL";
  const confidence = round3(Math.min(0.9, 0.4 + Math.abs(score) * 0.5));

  log?.debug({ event: "structure_bias_computed", bias, score: round3(score), lastHigh, lastLow, note });
  return { bias, score: round3(score), confidence, note, lastSwingHigh: lastHigh, lastSwingLow: lastLow };
}
