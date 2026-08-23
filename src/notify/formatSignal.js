import { TIMEFRAMES } from "../config.js";
import { escapeHtml } from "./telegram.js";

/** Build the full HTML alert body for one BUY/SELL decision, including the leverage-risk warning. */
export function formatSignalMessage({ symbol, result, leverageRisks, paperPositionId }) {
  const d = result.decision;
  const emoji = d.action === "BUY" ? "🟢" : "🔴";

  const lines = [
    `${emoji} <b>${d.action} ${escapeHtml(symbol)}</b>`,
    `R:R ${d.rewardRiskRatio}:1  |  Composite ${d.compositeScore}  |  Disagreement ${d.disagreement}`,
    "",
    `Entry: ${d.entryZone[0]} – ${d.entryZone[1]}`,
    `Stop: ${d.stopLoss}`,
    `TP1: ${d.takeProfit1}`,
    `TP2: ${d.takeProfit2}`,
    "",
    `<b>Gemini verdict:</b> ${escapeHtml(d.geminiVerdict)}`,
    `<b>Reasoning:</b> ${escapeHtml(d.reasoning)}`,
    "",
    "<b>Per-timeframe:</b>",
    ...TIMEFRAMES.map((tf) => {
      const s = result.structure[tf];
      const o = result.orderflow[tf];
      return `  ${tf}: structure=${s.bias} (${s.score}) orderflow=${o.bias} (${o.score})`;
    }),
    "",
    "⚠️ <b>Leverage risk</b> (approx — ignores fees/maintenance margin):",
    ...leverageRisks.map((r) => {
      const flag = r.stopBeyondLiquidation ? "🛑 STOP UNREACHABLE — liquidation hits first" : "✅ stop is inside liquidation buffer";
      return `  ${r.leverage}x: liquidation ~${r.liquidationDistancePct}% move, your stop is ${r.stopDistancePct}% away — ${flag}`;
    }),
  ];

  if (paperPositionId) lines.push("", `Paper position opened: <code>${paperPositionId}</code>`);

  return lines.join("\n");
}
