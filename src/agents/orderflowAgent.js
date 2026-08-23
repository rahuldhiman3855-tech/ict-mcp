import { findFvgs, findOrderBlocks } from "../smcPrimitives.js";

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Order Flow agent — FVG / Order Block proximity and freshness scoring. */
export function orderflowBias(bars, log) {
  // dropMitigated / dropInvalidated default true: only live zones score.
  const fvgs = findFvgs(bars);
  const obs = findOrderBlocks(bars);
  const price = bars[bars.length - 1].close;

  let score = 0;
  let weightSum = 0;

  for (const f of fvgs.slice(-6)) {
    const d = f.type === "bullish" ? 1 : -1;
    const mid = (f.top + f.bottom) / 2;
    const w = Math.max(0.1, 1 - (Math.abs(price - mid) / price) * 5);
    score += d * w;
    weightSum += w;
  }

  for (const o of obs.slice(-6)) {
    const d = o.type === "bullish_ob" ? 1 : -1;
    const mid = (o.top + o.bottom) / 2;
    const proximityW = Math.max(0.1, 1 - (Math.abs(price - mid) / price) * 5);
    const freshnessW = o.tested ? 0.5 : 0.8; // fresh/untested OBs weigh more
    const w = proximityW * freshnessW;
    score += d * w;
    weightSum += w;
  }

  const norm = weightSum > 0 ? clamp(score / weightSum, -1, 1) : 0;
  const bias = norm > 0.15 ? "BULLISH" : norm < -0.15 ? "BEARISH" : "NEUTRAL";
  const confidence = round3(Math.min(0.85, 0.3 + Math.abs(norm) * 0.5));

  log?.debug({
    event: "orderflow_bias_computed",
    bias,
    score: round3(norm),
    fvgCount: fvgs.length,
    obCount: obs.length,
  });

  return {
    bias,
    score: round3(norm),
    confidence,
    fvgCount: fvgs.length,
    obCount: obs.length,
    nearestFvgs: fvgs.slice(-3),
    nearestObs: obs.slice(-3),
  };
}
