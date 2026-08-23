/**
 * Fail fast, with a clear message, instead of discovering a broken
 * dependency mid-run (a Gemini call timing out 10 symbols deep, or a
 * Telegram alert silently failing to send for a real signal because nobody
 * checked the token was set). Every entry point (index.js, testSymbols.js,
 * watchLoop.js) should call this before invoking the graph.
 */

import { CHART_SERVER_URL, GEMINI_API_KEYS, WATCHLIST } from "./config.js";
import { TELEGRAM_ENABLED } from "./notify/telegram.js";

class ConfigError extends Error {}

async function checkChartsService(log) {
  try {
    const res = await fetch(`${CHART_SERVER_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`responded ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error("reported not-ok");
  } catch (err) {
    throw new ConfigError(
      `charts service unreachable at ${CHART_SERVER_URL} (${err.message}). ` +
        `Nothing here works without live bars — start it first (see charts/README.md).`
    );
  }
  log?.info({ event: "config_check_ok", check: "charts_service" }, "charts service reachable");
}

/**
 * @param {object} opts
 * @param {boolean} opts.requireTelegram - true for the watch loop, whose entire
 *   purpose is sending alerts; false for one-shot runs where console output is enough.
 */
export async function validateStartupConfig({ requireTelegram = false } = {}, log) {
  const errors = [];

  await checkChartsService(log).catch((err) => errors.push(err.message));

  if (!WATCHLIST.length) errors.push("WATCHLIST is empty — nothing to check.");

  if (requireTelegram && !TELEGRAM_ENABLED) {
    errors.push("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — the watch loop has nowhere to send alerts.");
  }

  if (errors.length) {
    throw new ConfigError(`Startup validation failed:\n  - ${errors.join("\n  - ")}`);
  }

  if (!GEMINI_API_KEYS.length) {
    log?.warn(
      { event: "config_check_warn", check: "gemini_keys" },
      "no GEMINI_API_KEY_* configured — every run will skip the Gemini verdict layer (mechanical-only, degrades to NEUTRAL)"
    );
  } else {
    log?.info(
      { event: "config_check_ok", check: "gemini_keys", count: GEMINI_API_KEYS.length },
      `${GEMINI_API_KEYS.length} Gemini key(s) configured`
    );
  }
}
