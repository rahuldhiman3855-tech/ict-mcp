'use strict';

const { chromium } = require('playwright');
const { buildHtml } = require('./template');

/**
 * Renders chart configs to PNG in a headless Chromium.
 *
 * One browser process is launched lazily and reused for every request; only
 * the page is per-render. Launching Chromium costs ~400ms, so keeping it warm
 * is what makes repeat renders land in the ~200-400ms range.
 */

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    }).catch((err) => {
      // Don't cache a failed launch, or every later request inherits it.
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

async function render(config) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: config.width, height: config.height },
    deviceScaleFactor: config.scale,
  });

  try {
    const page = await context.newPage();

    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // The document is fully self-contained (library inlined), so nothing here
    // touches the network.
    await page.setContent(buildHtml(config), { waitUntil: 'load' });

    try {
      await page.waitForFunction('window.__CHART_READY === true', null, { timeout: 15000 });
    } catch (err) {
      if (pageErrors.length) throw new Error(`Chart script failed: ${pageErrors[0]}`);
      throw new Error('Chart did not finish rendering within 15s');
    }

    const target = await page.$('#shot');
    return await target.screenshot({ type: 'png' });
  } finally {
    await context.close();
  }
}

async function warmup() {
  await getBrowser();
}

async function close() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) await browser.close();
}

module.exports = { render, warmup, close };
