'use strict';

const fs = require('fs');
const path = require('path');

const LIB = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'vendor', 'lightweight-charts.standalone.production.js'),
  'utf8',
);

/**
 * Palette lifted from the captured TradingView bundles
 * (dump1/assets/static.tradingview.com/static/bundles/*.css).
 */
const THEMES = {
  dark: {
    bg: '#131722',
    panel: '#1E222D',
    text: '#D1D4DC',
    muted: '#787B86',
    grid: '#2A2E39',
    border: '#2A2E39',
    up: '#089981',
    down: '#F23645',
    volumeUp: 'rgba(8,153,129,0.5)',
    volumeDown: 'rgba(242,54,69,0.5)',
    watermark: 'rgba(209,212,220,0.06)',
  },
  light: {
    bg: '#FFFFFF',
    panel: '#F8F9FD',
    text: '#131722',
    muted: '#787B86',
    grid: '#E0E3EB',
    border: '#E0E3EB',
    up: '#089981',
    down: '#F23645',
    volumeUp: 'rgba(8,153,129,0.5)',
    volumeDown: 'rgba(242,54,69,0.5)',
    watermark: 'rgba(19,23,34,0.05)',
  },
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * JSON destined for a <script> body. Escaping the closing-tag sequence and the
 * line separators keeps a hostile symbol string from breaking out of the tag.
 */
const jsonForScript = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

function buildHtml(config) {
  const theme = THEMES[config.theme] || THEMES.dark;
  const payload = jsonForScript({ ...config, theme });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: ${theme.bg};
    color: ${theme.text};
    font-family: -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #shot { width: ${config.width}px; background: ${theme.bg}; overflow: hidden; }
  #header {
    display: flex; align-items: baseline; gap: 10px;
    padding: 12px 14px 10px; border-bottom: 1px solid ${theme.border};
  }
  #symbol { font-size: 17px; font-weight: 700; letter-spacing: .2px; }
  #interval {
    font-size: 11px; font-weight: 600; color: ${theme.muted};
    border: 1px solid ${theme.border}; border-radius: 3px; padding: 2px 6px;
  }
  #desc { font-size: 12px; color: ${theme.muted}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  #quote { margin-left: auto; display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
  #last { font-size: 17px; font-weight: 700; }
  #change { font-size: 12px; font-weight: 600; }
  .pane { position: relative; }
  .pane + .pane { border-top: 1px solid ${theme.border}; }
  .legend {
    position: absolute; top: 6px; left: 10px; z-index: 3;
    display: flex; gap: 12px; flex-wrap: wrap;
    font-size: 11px; font-weight: 600; pointer-events: none;
  }
  .legend span { text-shadow: 0 0 3px ${theme.bg}; }
  .annotation-layer { position: absolute; top: 0; left: 0; z-index: 2; pointer-events: none; }
  #watermark {
    position: absolute; inset: 0; z-index: 1;
    display: flex; align-items: center; justify-content: center;
    font-size: ${Math.round(config.width / 14)}px; font-weight: 800;
    color: ${theme.watermark}; pointer-events: none; user-select: none;
  }
  #footer {
    display: flex; justify-content: space-between;
    padding: 7px 14px 9px; border-top: 1px solid ${theme.border};
    font-size: 10px; color: ${theme.muted};
  }
</style>
</head>
<body>
<div id="shot">
  <div id="header">
    <div id="symbol">${escapeHtml(config.title)}</div>
    <div id="interval">${escapeHtml(config.intervalLabel)}</div>
    <div id="desc">${escapeHtml(config.description || '')}</div>
    <div id="quote"><div id="last"></div><div id="change"></div></div>
  </div>
  <div id="panes"></div>
  <div id="footer"><span>${escapeHtml(config.footer || '')}</span><span id="range"></span></div>
</div>

<script>${LIB}</script>
<script>
(function () {
  var cfg = ${payload};
  var t = cfg.theme;
  var bars = cfg.bars;
  var LWC = LightweightCharts;

  // Enough digits to show the smallest tick this instrument actually moves in.
  function precisionFor(values) {
    var maxDecimals = 0;
    for (var i = 0; i < values.length; i++) {
      var s = String(values[i]);
      var dot = s.indexOf('.');
      if (dot !== -1) maxDecimals = Math.max(maxDecimals, s.length - dot - 1);
      if (maxDecimals >= 8) break;
    }
    return Math.min(maxDecimals, 8);
  }
  var precision = cfg.precision != null ? cfg.precision : precisionFor(bars.map(function (b) { return b.close; }));
  var minMove = Math.pow(10, -precision);

  var charts = [];
  var panesEl = document.getElementById('panes');

  function baseOptions(height, showTime, withLogo) {
    return {
      width: cfg.width,
      height: height,
      layout: {
        background: { type: 'solid', color: t.bg },
        textColor: t.muted,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, sans-serif',
        fontSize: 11,
        // The library stamps an attribution logo per chart instance; on a
        // stacked layout that means one per pane, so keep only the top one.
        attributionLogo: !!withLogo,
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: {
        borderColor: t.border,
        // Identical minimum width on every pane keeps the stacked charts
        // aligned on a common left edge.
        minimumWidth: cfg.scaleWidth,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor: t.border,
        visible: showTime,
        timeVisible: cfg.intraday,
        secondsVisible: false,
        rightOffset: 2,
        fixLeftEdge: true,
      },
      crosshair: { mode: LWC.CrosshairMode.Hidden },
      handleScroll: false,
      handleScale: false,
      localization: { priceFormatter: function (p) { return p.toFixed(precision); } },
    };
  }

  function makePane(height, showTime, className, withLogo) {
    var wrap = document.createElement('div');
    wrap.className = 'pane' + (className ? ' ' + className : '');
    panesEl.appendChild(wrap);
    var chart = LWC.createChart(wrap, baseOptions(height, showTime, withLogo));
    charts.push(chart);
    return { wrap: wrap, chart: chart };
  }

  function legend(wrap, items) {
    if (!items.length) return;
    var el = document.createElement('div');
    el.className = 'legend';
    items.forEach(function (item) {
      var span = document.createElement('span');
      span.textContent = item.text;
      span.style.color = item.color || t.muted;
      el.appendChild(span);
    });
    wrap.appendChild(el);
  }

  var subPanes = cfg.panes || [];
  var priceHeight = cfg.height
    - 44 /* header */
    - 26 /* footer */
    - subPanes.reduce(function (sum, p) { return sum + p.height; }, 0);
  priceHeight = Math.max(priceHeight, 140);

  // ---- price pane -----------------------------------------------------
  var price = makePane(priceHeight, subPanes.length === 0, 'price', true);

  if (cfg.watermark) {
    var wm = document.createElement('div');
    wm.id = 'watermark';
    wm.textContent = cfg.watermark;
    price.wrap.appendChild(wm);
  }

  var candles = price.chart.addCandlestickSeries({
    upColor: t.up, downColor: t.down,
    borderUpColor: t.up, borderDownColor: t.down,
    wickUpColor: t.up, wickDownColor: t.down,
    priceFormat: { type: 'price', precision: precision, minMove: minMove },
  });
  candles.setData(bars);

  if (cfg.showVolume) {
    var volume = price.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    // Pin volume into the bottom fifth of the price pane, TradingView style.
    price.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      visible: false,
    });
    volume.setData(bars.map(function (b) {
      return { time: b.time, value: b.volume, color: b.close >= b.open ? t.volumeUp : t.volumeDown };
    }));
  }

  var priceLegend = [];
  (cfg.overlays || []).forEach(function (s) {
    var series = price.chart.addLineSeries({
      color: s.color,
      lineWidth: s.lineWidth || 2,
      lineStyle: s.lineStyle || 0,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    series.setData(s.data);
    priceLegend.push({ text: s.title, color: s.color });
  });
  legend(price.wrap, priceLegend);

  // ---- indicator panes ------------------------------------------------
  subPanes.forEach(function (pane, idx) {
    var isLast = idx === subPanes.length - 1;
    var made = makePane(pane.height, isLast, 'study', false);
    var items = [];
    var anchor = null;

    pane.series.forEach(function (s) {
      var series = s.kind === 'histogram'
        ? made.chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false })
        : made.chart.addLineSeries({
            color: s.color, lineWidth: s.lineWidth || 2,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          });
      series.setData(s.data);
      anchor = anchor || series;
      if (s.kind !== 'histogram') items.push({ text: s.title, color: s.color });
    });

    (pane.levels || []).forEach(function (level) {
      if (!anchor) return;
      anchor.createPriceLine({
        price: level.value, color: level.color,
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '',
      });
    });

    // Whitespace across every bar time gives this pane the same logical index
    // space as the price pane, so fitContent lines the two up exactly.
    made.chart.addLineSeries({ lastValueVisible: false, priceLineVisible: false })
      .setData(bars.map(function (b) { return { time: b.time }; }));

    // A bounded oscillator (RSI) should keep a fixed 0-100 axis rather than
    // rescaling to whatever the window happens to contain. Overriding the
    // series' autoscale info is what pins it; disabling autoScale outright
    // would instead freeze the scale at its pre-data state.
    if (pane.range && anchor) {
      anchor.applyOptions({
        autoscaleInfoProvider: function () {
          return { priceRange: { minValue: pane.range.min, maxValue: pane.range.max } };
        },
      });
      made.chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
    }

    legend(made.wrap, items.length ? items : [{ text: pane.title, color: t.muted }]);
  });

  // ---- header quote + footer range ------------------------------------
  var first = bars[0], last = bars[bars.length - 1];
  var delta = last.close - first.open;
  var pct = first.open ? (delta / first.open) * 100 : 0;
  var sign = delta >= 0 ? '+' : '';
  document.getElementById('last').textContent = last.close.toFixed(precision);
  var changeEl = document.getElementById('change');
  changeEl.textContent = sign + delta.toFixed(precision) + ' (' + sign + pct.toFixed(2) + '%)';
  changeEl.style.color = delta >= 0 ? t.up : t.down;
  document.getElementById('last').style.color = delta >= 0 ? t.up : t.down;

  function stamp(sec) {
    var d = new Date(sec * 1000);
    var s = d.toISOString().slice(0, 10);
    return cfg.intraday ? s + ' ' + d.toISOString().slice(11, 16) : s;
  }
  document.getElementById('range').textContent =
    stamp(first.time) + '  →  ' + stamp(last.time) + '  ·  ' + bars.length + ' bars';

  charts.forEach(function (c) { c.timeScale().fitContent(); });

  // ---- ICT annotation layer -------------------------------------------
  // Levels are computed upstream from the OHLC array and drawn here, so a
  // vision model can judge the chart without reading the price axis.

  function rgba(hex, alpha) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function drawAnnotations() {
    var ann = cfg.annotations;
    if (!ann) return;

    // Native mechanisms first: these get proper axis labels for free.
    (ann.lines || []).forEach(function (line) {
      candles.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: line.dashed ? 2 : 0,
        axisLabelVisible: true,
        title: line.label,
      });
    });

    if ((ann.markers || []).length) {
      candles.setMarkers(ann.markers
        .slice()
        .sort(function (a, b) { return a.time - b.time; })
        .map(function (m) {
          return { time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text };
        }));
    }

    var boxes = ann.boxes || [];
    var zones = ann.zones || [];
    if (!boxes.length && !zones.length) return;

    var canvas = document.createElement('canvas');
    canvas.className = 'annotation-layer';
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cfg.width * dpr);
    canvas.height = Math.round(priceHeight * dpr);
    canvas.style.width = cfg.width + 'px';
    canvas.style.height = priceHeight + 'px';
    price.wrap.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var timeScale = price.chart.timeScale();
    // Keep drawings inside the plot area rather than running under the axis.
    var plotRight = cfg.width - price.chart.priceScale('right').width();

    function xAt(time, fallback) {
      var x = timeScale.timeToCoordinate(time);
      // Off-screen times convert to null; clamp so a box anchored before the
      // visible range still renders from the left edge.
      return x === null || x === undefined ? fallback : x;
    }

    // Labels are the whole point of the annotation layer — an overlapped
    // label is worse than none, because a vision model reads the collision as
    // a garbled token. Placed rectangles are tracked so later labels step out
    // of the way rather than painting over their neighbours.
    var placed = [];

    function overlaps(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    function findSlot(box) {
      var step = 15;
      // Try downward first, then upward; give up rather than drift off-pane.
      for (var dir = 0; dir < 2; dir++) {
        var candidate = { x: box.x, y: box.y, w: box.w, h: box.h };
        for (var i = 0; i < 8; i++) {
          var clash = placed.some(function (p) { return overlaps(candidate, p); });
          if (!clash && candidate.y >= 0 && candidate.y + candidate.h <= priceHeight) return candidate;
          candidate = { x: box.x, y: box.y + (dir === 0 ? 1 : -1) * step * (i + 1), w: box.w, h: box.h };
        }
      }
      return null;
    }

    function label(text, x, y, colorHex) {
      if (!text) return;
      ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Trebuchet MS", sans-serif';
      var width = ctx.measureText(text).width + 8;
      var slot = findSlot({ x: x, y: y, w: width, h: 13 });
      if (!slot) return; // too crowded here; drawing it would only garble
      placed.push(slot);
      ctx.fillStyle = rgba(colorHex, 0.85);
      ctx.fillRect(slot.x, slot.y, slot.w, 13);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(text, slot.x + 4, slot.y + 9.5);
    }

    zones.forEach(function (zone) {
      var yTop = candles.priceToCoordinate(zone.top);
      var yBottom = candles.priceToCoordinate(zone.bottom);
      if (yTop === null || yBottom === null) return;
      if (zone.fill > 0) {
        ctx.fillStyle = rgba(zone.color, zone.fill);
        ctx.fillRect(0, yTop, plotRight, yBottom - yTop);
      }
      ctx.strokeStyle = rgba(zone.color, 0.5);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yTop); ctx.lineTo(plotRight, yTop);
      ctx.moveTo(0, yBottom); ctx.lineTo(plotRight, yBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      label(zone.label, 6, yTop + 3, zone.color);
    });

    boxes.forEach(function (box) {
      var yTop = candles.priceToCoordinate(box.top);
      var yBottom = candles.priceToCoordinate(box.bottom);
      if (yTop === null || yBottom === null) return;

      var x1 = xAt(box.from, 0);
      // A null "to" means still live — run the box to the right edge.
      var x2 = box.to === null ? plotRight : xAt(box.to, plotRight);
      if (x2 < x1) { var swap = x1; x1 = x2; x2 = swap; }
      x1 = Math.max(x1, 0);
      x2 = Math.min(x2, plotRight);
      // Guarantee a visible sliver for single-candle blocks.
      if (x2 - x1 < 3) x2 = Math.min(x1 + 3, plotRight);

      var height = Math.max(yBottom - yTop, 1);
      ctx.fillStyle = rgba(box.color, box.fill);
      ctx.fillRect(x1, yTop, x2 - x1, height);
      ctx.strokeStyle = rgba(box.color, 0.9);
      ctx.lineWidth = 1;
      ctx.setLineDash(box.dashed ? [4, 3] : []);
      ctx.strokeRect(x1 + 0.5, yTop + 0.5, x2 - x1 - 1, height - 1);
      ctx.setLineDash([]);
      label(box.label, x1 + 2, Math.max(yTop - 14, 0), box.color);
    });
  }

  // Annotations need laid-out coordinates, so draw after the first paint and
  // signal readiness only once they are on the canvas.
  requestAnimationFrame(function () {
    drawAnnotations();
    requestAnimationFrame(function () { window.__CHART_READY = true; });
  });
})();
</script>
</body>
</html>`;
}

module.exports = { buildHtml, THEMES };
