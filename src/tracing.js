/**
 * Langfuse tracing. `langfuseHandler` is a LangChain-compatible callback
 * handler — passing it into `app.invoke(state, { callbacks: [langfuseHandler] })`
 * traces every graph node automatically (LangGraph's task executor emits
 * on_chain_start/end around each node regardless of whether the node itself
 * is a Runnable). `null` when no credentials are configured, so callers can
 * unconditionally spread `langfuseHandler ? [langfuseHandler] : []`.
 *
 * This is a short-lived CLI process, not a long-running server — Langfuse
 * batches and sends events on a timer, so without an explicit flush before
 * exit, a run's traces can simply never leave the process. Every entry
 * point that uses langfuseHandler must call flushTracing() before it exits,
 * on both the success and error paths.
 */

import { CallbackHandler } from "langfuse-langchain";
import { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL } from "./config.js";

export const langfuseHandler =
  LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY
    ? new CallbackHandler({
        publicKey: LANGFUSE_PUBLIC_KEY,
        secretKey: LANGFUSE_SECRET_KEY,
        baseUrl: LANGFUSE_BASE_URL,
      })
    : null;

export async function flushTracing() {
  if (langfuseHandler) await langfuseHandler.flushAsync();
}
