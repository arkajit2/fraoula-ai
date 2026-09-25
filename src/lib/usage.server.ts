/**
 * SERVER-ONLY usage ledger writes.
 *
 * Usage is the permanent billing record. Once a generation has happened the row
 * MUST land, no matter what the user does afterwards (deleting the chat, closing
 * the tab) or what fails downstream (message persistence, storage, network).
 *
 * Guarantees:
 *  - the row is written immediately after the provider call is billed;
 *  - if the conversation vanished mid-flight (user deleted it while the model
 *    was still answering) the row is retried detached (conversation_id = null)
 *    instead of being lost to a foreign-key violation;
 *  - transient failures are retried, and a final failure is logged loudly.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { log, type LogContext } from "./logging.server";

export type UsageRow = {
  user_id: string;
  provider: string;
  model: string;
  conversation_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  api_cost: number;
  platform_markup: number;
  final_cost: number;
};

const RETRY_DELAYS_MS = [150, 600];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Foreign-key violation: the conversation was deleted while we were generating. */
const isMissingConversation = (code?: string) => code === "23503";

export async function recordUsage(row: UsageRow, ctx: LogContext): Promise<void> {
  let candidate: UsageRow = row;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const { error } = await supabaseAdmin.from("usage").insert(candidate);
    if (!error) return;

    if (isMissingConversation(error.code) && candidate.conversation_id !== null) {
      // The chat is gone, the usage is not: keep the billing record, drop the link.
      candidate = { ...candidate, conversation_id: null };
      continue;
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    log.error("usage.record_failed", { ...ctx, model: row.model, userId: row.user_id }, error.message);
    return;
  }
}
