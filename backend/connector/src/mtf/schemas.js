'use strict';

const TIMEFRAME_ASSESSMENT_ITEM = {
  type: 'object',
  properties: {
    timeframe: { type: 'string', enum: ['1W', '1D', '4H', '1H'] },
    bias: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
    bias_score: { type: 'number', description: '-1.0 (strongly bearish) to +1.0 (strongly bullish)' },
    confidence: { type: 'number', description: '0.0 to 1.0' },
    support: { type: 'array', items: { type: 'number' } },
    resistance: { type: 'array', items: { type: 'number' } },
    poi: { type: 'string', description: 'Point of interest, e.g. "1.0835 Bullish FVG"' },
    market_structure: { type: 'string' },
    trend_state: { type: 'string' },
  },
  required: ['timeframe', 'bias', 'bias_score', 'confidence'],
};

/**
 * Agent 1 (Gemini, vision): scores all four HTF charts AND reads the 15M
 * execution chart in one call, so Gemini only needs one vision call per run
 * instead of two. execution_reading is handed to the Cohere arbiter as text
 * — the arbiter never sees an image itself.
 */
const VISION_AGENT_TOOL_NAME = 'submit_vision_reading';
const VISION_AGENT_TOOL_DESCRIPTION =
  'Submit your reading of all five attached charts. Always call this exactly once — never answer in prose instead.';

const VISION_AGENT_SCHEMA = {
  type: 'object',
  properties: {
    assessments: {
      type: 'array',
      description: 'One entry per HTF timeframe (1W, 1D, 4H, 1H), in that order.',
      items: TIMEFRAME_ASSESSMENT_ITEM,
    },
    execution_reading: {
      type: 'object',
      description: 'What the 15M chart (the fifth image) actually shows right now.',
      properties: {
        trigger_found: { type: 'boolean' },
        trigger_type: { type: 'string', enum: ['FAIR_VALUE_GAP', 'LIQUIDITY_SWEEP', 'BREAK_OF_STRUCTURE', 'CHANGE_OF_CHARACTER', 'SWING_FAILURE_PATTERN', 'NONE'] },
        direction: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NONE'] },
        key_level: { type: 'number' },
        description: { type: 'string', description: 'Plain-text account of what is visible: levels, candle behavior, why it does or does not qualify as a trigger.' },
      },
      required: ['trigger_found', 'description'],
    },
  },
  required: ['assessments', 'execution_reading'],
};

/**
 * Agent 2 (Cohere, text-only): independently scores the same four
 * timeframes from raw OHLC numbers instead of pixels — genuine cross-
 * modality independence from Agent 1, not just a second vendor doing the
 * identical vision task.
 */
const TEXT_AGENT_TOOL_NAME = 'submit_timeframe_scores';
const TEXT_AGENT_TOOL_DESCRIPTION =
  'Submit your independent assessment of all four higher timeframes, reasoned from the candle data. Always call this exactly once — never answer in prose instead.';

const TEXT_AGENT_SCHEMA = {
  type: 'object',
  properties: {
    assessments: {
      type: 'array',
      description: 'One entry per HTF timeframe (1W, 1D, 4H, 1H).',
      items: TIMEFRAME_ASSESSMENT_ITEM,
    },
  },
  required: ['assessments'],
};

/** The arbiter's final trade decision, matching the 15M execution layer. */
const ARBITER_TOOL_NAME = 'submit_mtf_decision';
const ARBITER_TOOL_DESCRIPTION =
  'Submit the final trade decision as structured data. Always call this exactly once with your conclusion — never answer in prose instead.';

const ARBITER_SCHEMA = {
  type: 'object',
  properties: {
    matched_scenario: { type: 'string', description: 'Which numbered scenario from the rulebook this matches, e.g. "Scenario 3: Macro Long, 1H Pullback"' },
    decision: { type: 'string', enum: ['BUY', 'SELL', 'BUY_LIMIT', 'SELL_LIMIT', 'NO_TRADE'] },
    entry_price: { type: 'number' },
    stop_loss: { type: 'number' },
    take_profit_1: { type: 'number' },
    take_profit_2: { type: 'number' },
    risk_reward_ratio: { type: 'number', description: 'Reward divided by risk, e.g. 3.67 for 1:3.67' },
    risk_multiplier: { type: 'number', description: '0 to 1.0x, per the scenario rulebook' },
    trigger_condition: { type: 'string' },
    invalidation: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['matched_scenario', 'decision', 'rationale'],
};

module.exports = {
  VISION_AGENT_TOOL_NAME,
  VISION_AGENT_TOOL_DESCRIPTION,
  VISION_AGENT_SCHEMA,
  TEXT_AGENT_TOOL_NAME,
  TEXT_AGENT_TOOL_DESCRIPTION,
  TEXT_AGENT_SCHEMA,
  ARBITER_TOOL_NAME,
  ARBITER_TOOL_DESCRIPTION,
  ARBITER_SCHEMA,
};
