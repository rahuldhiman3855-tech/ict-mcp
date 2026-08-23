import { withNodeLogging } from "../logger.js";
import { fetchMultiTimeframeBars } from "../data/liveFeed.js";
import { structureBias } from "../agents/structureAgent.js";
import { orderflowBias } from "../agents/orderflowAgent.js";
import { getGeminiVerdict } from "../agents/geminiVerdictAgent.js";
import { premiumDiscount } from "../smcPrimitives.js";
import { TIMEFRAMES, TF_WEIGHTS, RISK } from "../config.js";

export function round(x, dp = 3) {
  const m = 10 ** dp;
  return Math.round(x * m) / m;
}

export const fetchDataNode = withNodeLogging("fetch_data", async (state, config, log) => {
  log.info({ event: "data_source", source: "live_charts_service", symbol: state.symbol }, "fetching live OHLC");
  const ohlc = await fetchMultiTimeframeBars(state.symbol);
  for (const tf of TIMEFRAMES) {
    log.debug({ event: "bars_loaded", tf, count: ohlc[tf].length });
  }
  return { ohlc };
});

export const structureAgentNode = withNodeLogging("structure_agent", async (state, config, log) => {
  const structure = {};
  for (const tf of TIMEFRAMES) {
    structure[tf] = structureBias(state.ohlc[tf], log.child({ tf }));
    log.info({ event: "structure_result", tf, bias: structure[tf].bias, score: structure[tf].score });
  }
  return { structure };
});

export const orderflowAgentNode = withNodeLogging("orderflow_agent", async (state, config, log) => {
  const orderflow = {};
  for (const tf of TIMEFRAMES) {
    orderflow[tf] = orderflowBias(state.ohlc[tf], log.child({ tf }));
    log.info({ event: "orderflow_result", tf, bias: orderflow[tf].bias, score: orderflow[tf].score });
  }
  return { orderflow };
});

export const consensusNode = withNodeLogging("consensus_node", async (state, config, log) => {
  const perTf = {};
  let composite = 0;
  let disagreement = 0;

  for (const tf of TIMEFRAMES) {
    const s1 = state.structure[tf];
    const s2 = state.orderflow[tf];
    const raw1 = s1.score * s1.confidence;
    const raw2 = s2.score * s2.confidence;
    const S = (raw1 + raw2) / 2;
    const D = Math.abs(raw1 - raw2);
    const w = TF_WEIGHTS[tf];
    composite += w * S;
    disagreement += w * D;
    perTf[tf] = { weight: w, structure: s1.bias, orderflow: s2.bias, S: round(S), D: round(D) };
    log.debug({ event: "consensus_tf", tf, raw1: round(raw1), raw2: round(raw2), S: round(S), D: round(D) });
  }

  const result = { perTimeframe: perTf, compositeScore: round(composite, 4), disagreement: round(disagreement, 4) };
  log.info({ event: "consensus_computed", compositeScore: result.compositeScore, disagreement: result.disagreement });
  return { consensus: result };
});

/**
 * Entry/stop/TP1/TP2 for whichever direction the composite score currently
 * points. Direction is already known by this point in the graph (consensus
 * runs before levels), so the plan — and its reward:risk ratio — can be
 * computed once here and gated on directly, instead of being built inside
 * trade_node where a bad R:R can no longer stop the trade.
 */
export function planTrade(direction, levels) {
  const ob = levels.nearest1hDemandOb;
  let entryZone, stop, tp1, tp2;

  if (direction === "BUY") {
    entryZone = ob ? [ob.bottom, ob.top] : levels.premiumDiscount.oteZone;
    stop = round((ob ? ob.bottom : levels.premiumDiscount.rangeLow) * 0.995, 1);
    tp1 = levels.buySideLiquidity;
    tp2 = round(tp1 * 1.02, 1);
  } else {
    entryZone = levels.premiumDiscount.oteZone;
    stop = round(levels.premiumDiscount.rangeHigh * 1.005, 1);
    tp1 = levels.sellSideLiquidity;
    tp2 = round(tp1 * 0.98, 1);
  }

  const entryMid = (entryZone[0] + entryZone[1]) / 2;
  const risk = Math.abs(entryMid - stop);
  const reward = Math.abs(tp1 - entryMid);
  const rewardRiskRatio = risk > 0 ? round(reward / risk, 2) : 0;

  return { direction, entryZone, stopLoss: stop, takeProfit1: tp1, takeProfit2: tp2, rewardRiskRatio };
}

export const levelsNode = withNodeLogging("levels_node", async (state, config, log) => {
  const daily = state.ohlc["1D"];
  const dealingLow = Math.min(...daily.map((b) => b.low));
  const dealingHigh = Math.max(...daily.map((b) => b.high));
  const price = state.ohlc["1H"][state.ohlc["1H"].length - 1].close;

  const pd = premiumDiscount(dealingLow, dealingHigh, price);
  const ob1h = state.orderflow["1H"].nearestObs;
  const fvg1h = state.orderflow["1H"].nearestFvgs;
  const bullishObs1h = ob1h.filter((o) => o.type === "bullish_ob");
  const nearestDemand = bullishObs1h.length ? bullishObs1h[bullishObs1h.length - 1] : null;

  const liquidityHigh = Math.max(...state.ohlc["4H"].map((b) => b.high));
  const liquidityLow = Math.min(...state.ohlc["4H"].slice(-15).map((b) => b.low));

  const levels = {
    currentPrice: price,
    premiumDiscount: pd,
    nearest1hDemandOb: nearestDemand,
    nearest1hFvg: fvg1h.length ? fvg1h[fvg1h.length - 1] : null,
    buySideLiquidity: round(liquidityHigh, 1),
    sellSideLiquidity: round(liquidityLow, 1),
  };
  levels.tradePlan = planTrade(state.consensus.compositeScore > 0 ? "BUY" : "SELL", levels);

  log.info({
    event: "levels_computed",
    currentPrice: price,
    zone: pd.zone,
    pctIntoRange: pd.pctIntoRange,
    rewardRiskRatio: levels.tradePlan.rewardRiskRatio,
  });
  return { levels };
});

/**
 * Cheap, purely mechanical pre-check. Gemini is a paid, network-dependent
 * call, so it's only worth invoking once the composite/disagreement/zone
 * math already clears the bar for a trade — no point spending a call (or an
 * LLM veto) on a setup the mechanical rules already reject.
 *
 * Pure by design: no logging, no state shape, just consensus+levels in,
 * {route, reason} out — so it's directly unit-testable against synthetic
 * numbers without constructing a graph state or a logger.
 */
export function evaluateMechanicalGate(consensus, levels) {
  const { compositeScore: composite, disagreement } = consensus;
  const pd = levels.premiumDiscount;

  if (Math.abs(composite) < RISK.minCompositeEdge) return { route: "wait", reason: "No composite edge — sit out." };
  if (disagreement > RISK.maxDisagreement)
    return {
      route: "wait",
      reason: `Structure vs order-flow disagreement too high (${disagreement}) — low conviction.`,
    };
  if (composite > 0 && pd.zone === "PREMIUM" && pd.pctIntoRange > RISK.maxPremiumEntryPct)
    return {
      route: "wait",
      reason: `Bullish bias but price is ${pd.pctIntoRange}% into premium — poor R:R, wait for a retrace.`,
    };
  if (composite < 0 && pd.zone === "DISCOUNT" && pd.pctIntoRange < RISK.minDiscountEntryPct)
    return {
      route: "wait",
      reason: `Bearish bias but price is only ${pd.pctIntoRange}% into range — poor R:R for shorts here.`,
    };

  const { rewardRiskRatio } = levels.tradePlan;
  if (rewardRiskRatio < RISK.minRewardRiskRatio)
    return {
      route: "wait",
      reason: `Reward:risk too low (${rewardRiskRatio}:1 < required ${RISK.minRewardRiskRatio}:1) — skip.`,
    };

  return {
    route: "trade",
    reason: `Composite edge, acceptable disagreement, price zone acceptable, R:R ${rewardRiskRatio}:1.`,
  };
}

export const mechanicalGateNode = withNodeLogging("mechanical_gate", async (state, config, log) => {
  const { route, reason } = evaluateMechanicalGate(state.consensus, state.levels);
  log.info({ event: "mechanical_gate_decision", route, reason });
  return { route, risk: { reason } };
});

export function mechanicalRouteDecision(state) {
  return state.route;
}

export const geminiVerdictNode = withNodeLogging("gemini_verdict", async (state, config, log) => {
  const geminiVerdict = await getGeminiVerdict(
    {
      symbol: state.symbol,
      consensus: state.consensus,
      levels: state.levels,
      structure: state.structure,
      orderflow: state.orderflow,
    },
    log
  );
  return { geminiVerdict };
});

/**
 * Only reached when the mechanical gate already said "trade" — can veto it,
 * never originate one. Pure: mechanical reason + gemini verdict in,
 * {route, reason} out.
 */
export function evaluateFinalGate(mechanicalReason, gemini) {
  if (gemini.verdict === "VETO") {
    return { route: "wait", reason: `Mechanical edge present, but Gemini vetoed: ${gemini.reasoning}` };
  }

  const reason = gemini.verdict === "CONFIRM"
    ? `${mechanicalReason} Gemini confirmed: ${gemini.reasoning}`
    : `${mechanicalReason} Gemini neutral/unavailable.`;
  return { route: "trade", reason };
}

export const finalGateNode = withNodeLogging("final_gate", async (state, config, log) => {
  const { route, reason } = evaluateFinalGate(state.risk.reason, state.geminiVerdict);
  log.info({ event: "final_gate_decision", route, reason });
  return { route, risk: { reason } };
});

export function routeDecision(state) {
  return state.route;
}

export const tradeNode = withNodeLogging("trade_node", async (state, config, log) => {
  const c = state.consensus;
  const plan = state.levels.tradePlan;

  const decision = {
    action: plan.direction,
    confidence: round(Math.min(0.95, 0.5 + Math.abs(c.compositeScore)), 3),
    entryZone: plan.entryZone,
    stopLoss: plan.stopLoss,
    takeProfit1: plan.takeProfit1,
    takeProfit2: plan.takeProfit2,
    rewardRiskRatio: plan.rewardRiskRatio,
    compositeScore: c.compositeScore,
    disagreement: c.disagreement,
    geminiVerdict: state.geminiVerdict.verdict ?? "SKIPPED_NO_MECHANICAL_EDGE",
    reasoning: state.risk.reason,
  };
  log.warn({ event: "trade_signal", ...decision }, `TRADE SIGNAL: ${plan.direction} @ ${plan.entryZone}`);
  return { decision };
});

export const waitNode = withNodeLogging("wait_node", async (state, config, log) => {
  const c = state.consensus;
  const lv = state.levels;
  const decision = {
    action: "WAIT",
    compositeScore: c.compositeScore,
    disagreement: c.disagreement,
    watchZone: lv.premiumDiscount.oteZone,
    watchOb: lv.nearest1hDemandOb,
    geminiVerdict: state.geminiVerdict.verdict ?? "SKIPPED_NO_MECHANICAL_EDGE",
    reasoning: state.risk.reason,
  };
  log.info({ event: "wait_signal", ...decision }, "WAIT: no trade this run");
  return { decision };
});
