import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "..", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
// Separate from LOG_LEVEL (console) on purpose: the file is what a
// forever-running watch loop accumulates for weeks, so its default is
// lighter than the old hardcoded 'trace'. Full forensic detail is still one
// env var away (LOG_FILE_LEVEL=trace) when actually debugging something.
const LOG_FILE_LEVEL = process.env.LOG_FILE_LEVEL || "info";
const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 14);

/** Delete run-*.jsonl files whose date-stamp is older than the retention window. */
function pruneOldLogs() {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(LOG_DIR)) {
    const match = name.match(/^run-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) continue;
    if (new Date(match[1]).getTime() < cutoff) {
      fs.rmSync(path.join(LOG_DIR, name), { force: true });
    }
  }
}
pruneOldLogs();

/**
 * One JSONL file per UTC calendar day (`run-YYYY-MM-DD.jsonl`), regardless
 * of how many separate process runs write to it that day — every line still
 * carries its own runId, so runs stay distinguishable via `jq`/`grep`
 * without needing a file per run. This is what keeps a forever-running
 * watch loop's log bounded: it rotates on its own every 24h and old files
 * get pruned above, instead of one file growing without limit for weeks.
 */
class DailyRotatingStream {
  #stream = null;
  #currentDate = null;

  #dateStr() {
    return new Date().toISOString().slice(0, 10);
  }

  #ensureCurrent() {
    const date = this.#dateStr();
    if (date === this.#currentDate) return;
    this.#currentDate = date;
    this.#stream?.end();
    this.filePath = path.join(LOG_DIR, `run-${date}.jsonl`);
    this.#stream = fs.createWriteStream(this.filePath, { flags: "a" });
  }

  write(msg) {
    this.#ensureCurrent();
    return this.#stream.write(msg);
  }
}

const fileStream = new DailyRotatingStream();
// Force today's file to exist immediately so `logFile` below is accurate at import time.
fileStream.write("");

/**
 * Two destinations:
 *  - stdout: human-readable, pretty-printed (pino-pretty), respects LOG_LEVEL
 *  - file:   raw newline-delimited JSON at LOG_FILE_LEVEL, rotated daily
 */
const streams = [
  {
    level: LOG_LEVEL,
    stream: pino.transport({
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
    }),
  },
  { level: LOG_FILE_LEVEL, stream: fileStream },
];

export const rootLogger = pino(
  { level: "trace", base: { runId: randomUUID() } },
  pino.multistream(streams)
);

const logFile = fileStream.filePath;
rootLogger.info({ logFile, consoleLevel: LOG_LEVEL, fileLevel: LOG_FILE_LEVEL }, "logger initialized");

/**
 * Bind a child logger scoped to one graph node, and return a wrapper that
 * times execution, logs entry/exit at info, logs the state diff at debug,
 * and logs+rethrows on failure with the stack trace preserved — so a node
 * crash is diagnosable from the JSON log alone, not just a stack trace in
 * the terminal that scrolls away.
 */
export function withNodeLogging(nodeName, fn) {
  const log = rootLogger.child({ node: nodeName });
  return async (state, config) => {
    const startedAt = Date.now();
    log.info({ event: "node_start" }, `-> entering ${nodeName}`);
    log.debug({ event: "node_input", stateKeys: Object.keys(state ?? {}) }, "input state snapshot");
    try {
      const update = await fn(state, config, log);
      const durationMs = Date.now() - startedAt;
      log.info({ event: "node_end", durationMs }, `<- leaving ${nodeName} (${durationMs}ms)`);
      log.debug({ event: "node_output", update }, "output update");
      return update;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      log.error(
        { event: "node_error", durationMs, err: { message: err.message, stack: err.stack } },
        `x ${nodeName} threw after ${durationMs}ms: ${err.message}`
      );
      throw err;
    }
  };
}

export { LOG_LEVEL, logFile };
