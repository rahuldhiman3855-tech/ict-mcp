/**
 * Approximate liquidation distance at a given leverage, compared against
 * this decision's actual stop-loss distance.
 *
 * This exists because of a real, non-obvious failure mode: the strategy's
 * stop-loss is placed at a structural level (an order block edge, a range
 * boundary) — typically 0.5%-2% away from entry for these instruments. At
 * 100x leverage, roughly a 1% adverse move liquidates an isolated-margin
 * position; at 200x, roughly 0.5%. That means for a lot of real setups, the
 * exchange liquidates the position *before* price ever reaches the
 * strategy's own stop — the stop-loss becomes decorative, and the real risk
 * (100% of margin) triggers earlier and silently, with no chance to manage
 * it. This computation exists to make that visible per-signal, not to size
 * a position.
 *
 * The 100/leverage figure ignores maintenance margin and fees, so it's an
 * upper bound on how far price can move before liquidation — real
 * liquidation is typically a little closer than this. Treat every number
 * here as "at least this bad," not exact.
 */
export function computeLeverageRisk({ entryZone, stopLoss, direction }, leverageLevels) {
  const entryMid = (entryZone[0] + entryZone[1]) / 2;
  const stopDistancePct = (Math.abs(entryMid - stopLoss) / entryMid) * 100;

  return leverageLevels.map((leverage) => {
    const liquidationDistancePct = 100 / leverage;
    const stopBeyondLiquidation = stopDistancePct > liquidationDistancePct;
    return {
      leverage,
      direction,
      stopDistancePct: round2(stopDistancePct),
      liquidationDistancePct: round2(liquidationDistancePct),
      stopBeyondLiquidation,
    };
  });
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
