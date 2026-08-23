/**
 * Telegram Bot API — plain fetch, no SDK needed for one endpoint. Sending is
 * a side channel: a failed alert must never take down the watch loop that's
 * generating it, so callers get a boolean back instead of a thrown error.
 */

import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "../config.js";

export const TELEGRAM_ENABLED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `text` may contain a handful of pre-built <b>/<code> tags; everything else gets escaped by the caller. */
export async function sendTelegramMessage(text, log) {
  if (!TELEGRAM_ENABLED) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log?.warn({ event: "telegram_send_failed", status: res.status, body: body.slice(0, 200) }, "telegram send failed");
      return false;
    }
    return true;
  } catch (err) {
    log?.warn({ event: "telegram_send_error", err: err.message }, "telegram send error");
    return false;
  }
}

export { escapeHtml };
