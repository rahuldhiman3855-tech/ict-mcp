import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TIMEFRAMES, TF_WEIGHTS, TF_FEED_PARAMS, WATCHLIST, parseGeminiKeys } from "../src/config.js";

describe("config invariants", () => {
  test("every timeframe has a weight and a feed param, and weights sum to 1", () => {
    for (const tf of TIMEFRAMES) {
      assert.ok(tf in TF_WEIGHTS, `${tf} missing from TF_WEIGHTS`);
      assert.ok(tf in TF_FEED_PARAMS, `${tf} missing from TF_FEED_PARAMS`);
    }
    const sum = Object.values(TF_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `TF_WEIGHTS should sum to 1, got ${sum}`);
  });

  test("WATCHLIST has exactly 20 unique EXCHANGE:TICKER symbols", () => {
    assert.equal(WATCHLIST.length, 20);
    assert.equal(new Set(WATCHLIST).size, 20, "WATCHLIST has duplicates");
    assert.ok(WATCHLIST.every((symbol) => !symbol.includes("USDT")), "WATCHLIST must use OctaFX-compatible USD symbols");
    // EXCHANGE:TICKER — exchange casing varies in the wild (BITSTAMP vs
    // Pepperstone vs Capital.com), so this only checks the shape, not case.
    for (const symbol of WATCHLIST) assert.match(symbol, /^[A-Za-z.]+:[A-Z0-9!]+$/);
  });
});

describe("parseGeminiKeys", () => {
  test("orders keys numerically by suffix, not lexicographically", () => {
    const env = { GEMINI_API_KEY_10: "k10", GEMINI_API_KEY_2: "k2", GEMINI_API_KEY_1: "k1" };
    assert.deepEqual(parseGeminiKeys(env), ["k1", "k2", "k10"]);
  });

  test("ignores unrelated env vars and drops empty values", () => {
    const env = { GEMINI_API_KEY_1: "k1", GEMINI_API_KEY_2: "", OTHER_VAR: "x", GEMINI_MODEL: "gemini-3.6-flash" };
    assert.deepEqual(parseGeminiKeys(env), ["k1"]);
  });

  test("returns [] when no Gemini keys are set", () => {
    assert.deepEqual(parseGeminiKeys({ SOME_OTHER_KEY: "x" }), []);
  });
});
