'use strict';

/**
 * Deterministic scoring layer between the two independent HTF agents and the
 * arbiter. Pure functions, no I/O, no LLM — the composite bias score and
 * disagreement index have to be exact and reproducible, not something a
 * model "computes" in prose.
 */

const TIMEFRAMES = ['1W', '1D', '4H', '1H'];

// Higher timeframes dominate macro direction; lower ones set up the
// immediate swing. Must sum to 1.0.
const WEIGHTS = { '1W': 0.40, '1D': 0.30, '4H': 0.20, '1H': 0.10 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const byTimeframe = (assessments) =>
  Object.fromEntries((assessments || []).map((a) => [a.timeframe, a]));

/**
 * @param {Array<{timeframe, bias_score, confidence}>} agent1Assessments
 * @param {Array<{timeframe, bias_score, confidence}>} agent2Assessments
 * @returns {{ perTimeframe: Array, compositeBiasScore: number, globalDisagreement: number }}
 */
function computeConsensus(agent1Assessments, agent2Assessments) {
  const a1 = byTimeframe(agent1Assessments);
  const a2 = byTimeframe(agent2Assessments);

  const perTimeframe = [];
  let cbs = 0;
  let gdm = 0;

  for (const tf of TIMEFRAMES) {
    const e1 = a1[tf];
    const e2 = a2[tf];
    // A timeframe either agent failed to score contributes 0 — missing data
    // must not silently masquerade as a neutral, confident read.
    const raw1 = e1 ? clamp(Number(e1.bias_score) || 0, -1, 1) * clamp(Number(e1.confidence) || 0, 0, 1) : 0;
    const raw2 = e2 ? clamp(Number(e2.bias_score) || 0, -1, 1) * clamp(Number(e2.confidence) || 0, 0, 1) : 0;

    const S = (raw1 + raw2) / 2;
    const D = Math.abs(raw1 - raw2);
    const W = WEIGHTS[tf];

    cbs += W * S;
    gdm += W * D;

    perTimeframe.push({
      timeframe: tf,
      weight: W,
      agent1: e1 ? { bias: e1.bias, bias_score: e1.bias_score, confidence: e1.confidence } : null,
      agent2: e2 ? { bias: e2.bias, bias_score: e2.bias_score, confidence: e2.confidence } : null,
      rawScore1: raw1,
      rawScore2: raw2,
      S,
      D,
      missing: !e1 || !e2,
    });
  }

  return {
    perTimeframe,
    compositeBiasScore: clamp(cbs, -1, 1),
    globalDisagreement: clamp(gdm, 0, 1),
  };
}

module.exports = { computeConsensus, TIMEFRAMES, WEIGHTS };
