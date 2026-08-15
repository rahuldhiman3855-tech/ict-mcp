'use strict';

/**
 * Validation for the ICT annotation layer.
 *
 * The point of these annotations is to let a vision model judge a chart without
 * reading numbers off the price axis: the caller computes exact levels from the
 * OHLC array and we draw them, so the model sees structure already marked.
 *
 * Four primitives, each drawn by a different mechanism in `template.js`:
 *   boxes    time+price rectangles (order blocks, FVGs)   -> overlay canvas
 *   zones    full-width price bands (premium/discount)    -> overlay canvas
 *   lines    horizontal levels (PDH/PDL, equal highs)     -> createPriceLine
 *   markers  per-bar labels (BOS, CHoCH, sweeps)          -> setMarkers
 */

const LIMITS = { boxes: 40, zones: 6, lines: 30, markers: 40 };

/** Semantic defaults, so callers normally only supply geometry and a kind. */
const KIND_STYLES = {
  bullish_ob: { color: '#089981', fill: 0.16, label: 'Bull OB' },
  bearish_ob: { color: '#F23645', fill: 0.16, label: 'Bear OB' },
  bullish_fvg: { color: '#2962FF', fill: 0.13, label: 'FVG' },
  bearish_fvg: { color: '#FF6D00', fill: 0.13, label: 'FVG' },
  breaker: { color: '#AB47BC', fill: 0.14, label: 'Breaker' },
  liquidity: { color: '#787B86', fill: 0.10, label: 'Liquidity' },
  premium: { color: '#F23645', fill: 0.07, label: 'Premium' },
  discount: { color: '#089981', fill: 0.07, label: 'Discount' },
  equilibrium: { color: '#787B86', fill: 0.0, label: 'EQ' },
};

class AnnotationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const isNum = (v) => Number.isFinite(Number(v));

function requireNum(value, path) {
  if (!isNum(value)) throw new AnnotationError(`${path} must be a number`);
  return Number(value);
}

function optionalStr(value, path, max = 40) {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  if (s.length > max) throw new AnnotationError(`${path} must be at most ${max} characters`);
  return s;
}

/** Only accept colors we can safely drop into a canvas fillStyle. */
function color(value, path, fallback) {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new AnnotationError(`${path} must be a #rrggbb color`);
  return s;
}

function list(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AnnotationError(`annotations.${name} must be an array`);
  if (value.length > LIMITS[name]) {
    throw new AnnotationError(`annotations.${name} is limited to ${LIMITS[name]} entries`);
  }
  return value;
}

function styleFor(kind) {
  return KIND_STYLES[kind] || { color: '#787B86', fill: 0.12, label: kind || '' };
}

function parse(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AnnotationError('annotations must be an object');
  }

  const boxes = list(input.boxes, 'boxes').map((raw, i) => {
    const path = `annotations.boxes[${i}]`;
    const kind = String(raw.kind || '').toLowerCase();
    const style = styleFor(kind);
    const top = requireNum(raw.top, `${path}.top`);
    const bottom = requireNum(raw.bottom, `${path}.bottom`);
    const from = requireNum(raw.from, `${path}.from`);
    // An open-ended box (no `to`) extends to the right edge, which is how an
    // unmitigated order block should read.
    const to = raw.to === undefined || raw.to === null ? null : requireNum(raw.to, `${path}.to`);
    return {
      kind,
      // Tolerate inverted input rather than rejecting it; the caller's "top"
      // is whichever price is numerically greater.
      top: Math.max(top, bottom),
      bottom: Math.min(top, bottom),
      from,
      to,
      label: optionalStr(raw.label, `${path}.label`) ?? style.label,
      color: color(raw.color, `${path}.color`, style.color),
      fill: isNum(raw.fill) ? Math.min(Math.max(Number(raw.fill), 0), 1) : style.fill,
      dashed: raw.dashed === true,
    };
  });

  const zones = list(input.zones, 'zones').map((raw, i) => {
    const path = `annotations.zones[${i}]`;
    const kind = String(raw.kind || '').toLowerCase();
    const style = styleFor(kind);
    const top = requireNum(raw.top, `${path}.top`);
    const bottom = requireNum(raw.bottom, `${path}.bottom`);
    return {
      kind,
      top: Math.max(top, bottom),
      bottom: Math.min(top, bottom),
      label: optionalStr(raw.label, `${path}.label`) ?? style.label,
      color: color(raw.color, `${path}.color`, style.color),
      fill: isNum(raw.fill) ? Math.min(Math.max(Number(raw.fill), 0), 1) : style.fill,
    };
  });

  const lines = list(input.lines, 'lines').map((raw, i) => {
    const path = `annotations.lines[${i}]`;
    return {
      price: requireNum(raw.price, `${path}.price`),
      label: optionalStr(raw.label, `${path}.label`, 24) ?? '',
      color: color(raw.color, `${path}.color`, styleFor(String(raw.kind || '').toLowerCase()).color),
      dashed: raw.dashed !== false,
    };
  });

  const markers = list(input.markers, 'markers').map((raw, i) => {
    const path = `annotations.markers[${i}]`;
    const position = raw.position === 'belowBar' ? 'belowBar' : 'aboveBar';
    return {
      time: requireNum(raw.time, `${path}.time`),
      text: optionalStr(raw.text, `${path}.text`, 16) ?? '',
      position,
      color: color(raw.color, `${path}.color`, '#D1D4DC'),
      shape: position === 'belowBar' ? 'arrowUp' : 'arrowDown',
    };
  });

  if (!boxes.length && !zones.length && !lines.length && !markers.length) return null;
  return { boxes, zones, lines, markers };
}

module.exports = { parse, AnnotationError, LIMITS, KIND_STYLES };
