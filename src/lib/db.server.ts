/**
 * db.server.ts
 * Typed Cloudflare D1 CRUD helpers for Fraoula AI.
 *
 * All functions use D1 prepared statements and return plain TypeScript objects
 * that mirror the schema in d1/schema.sql.
 *
 * Never import this module in client-side code.
 */

import { generateId } from "./auth.server";

// ===========================================================================
// Row types (raw D1 output — booleans are 0 | 1)
// ===========================================================================

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  avatar_url: string | null;
  email_verified: number;
  is_admin: number;
  created_at: string;
  updated_at: string;
}

interface WalletRow {
  id: string;
  user_id: string;
  balance: number;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

interface UsageRecordRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  api_cost: number;
  platform_markup: number;
  final_cost: number;
  created_at: string;
}

interface AppSettingRow {
  key: string;
  value: string;
  updated_at: string;
}

interface FreeUsageDailyRow {
  id: string;
  user_id: string;
  date: string;
  messages_count: number;
  input_tokens: number;
  output_tokens: number;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  price_id: string | null;
  status: string;
  cancel_at_period_end: number;
  environment: string;
  current_period_start: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

interface TransactionRow {
  id: string;
  user_id: string;
  amount: number;
  type: string;
  description: string | null;
  stripe_payment_intent_id: string | null;
  status: string;
  created_at: string;
}

// ===========================================================================
// Domain types (exported — safe to use in route handlers)
// ===========================================================================

export type {
  UserRow as DBUser,
  WalletRow as DBWallet,
  ConversationRow as DBConversation,
  MessageRow as DBMessage,
  UsageRecordRow as DBUsageRecord,
  AppSettingRow as DBAppSetting,
  FreeUsageDailyRow as DBFreeUsageDaily,
  SubscriptionRow as DBSubscription,
  TransactionRow as DBTransaction,
};

// ---------------------------------------------------------------------------
// Input types for mutations
// ---------------------------------------------------------------------------

export interface NewMessage {
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

export interface UsageRecordInput {
  user_id: string;
  conversation_id?: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  cache_read_tokens?: number;
  api_cost: number;
  platform_markup: number;
  final_cost: number;
}

export interface SubscriptionInput {
  user_id: string;
  plan_id: string;
  stripe_subscription_id?: string | null;
  stripe_customer_id?: string | null;
  price_id?: string | null;
  status?: string;
  cancel_at_period_end?: boolean;
  environment?: string;
  current_period_start?: string | null;
  current_period_end?: string | null;
}

export interface TransactionInput {
  user_id: string;
  amount: number;
  type: string;
  description?: string | null;
  stripe_payment_intent_id?: string | null;
  status?: string;
}

// ===========================================================================
// Wallet helpers
// ===========================================================================

/**
 * Retrieve the wallet for a user.
 * @returns The wallet row, or null if none exists yet.
 */
export async function getWallet(
  db: D1Database,
  userId: string,
): Promise<WalletRow | null> {
  return db
    .prepare("SELECT * FROM wallets WHERE user_id = ?1 LIMIT 1")
    .bind(userId)
    .first<WalletRow>();
}

/**
 * Create a wallet for a user (balance = 0).
 * @returns The newly created wallet row.
 * @throws If the wallet already exists (UNIQUE constraint violation).
 */
export async function createWallet(
  db: D1Database,
  userId: string,
): Promise<WalletRow> {
  const id = generateId();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO wallets (id, user_id, balance, created_at, updated_at)
       VALUES (?1, ?2, 0.0, ?3, ?3)`,
    )
    .bind(id, userId, now)
    .run();

  const row = await db
    .prepare("SELECT * FROM wallets WHERE id = ?1 LIMIT 1")
    .bind(id)
    .first<WalletRow>();

  if (!row) throw new Error("Wallet creation failed.");
  return row;
}

/**
 * Atomically apply a delta to the wallet balance.
 * Pass a negative delta to deduct funds.
 *
 * @returns The new balance after the update.
 * @throws If the resulting balance would go below zero (credit-check).
 */
export async function updateWalletBalance(
  db: D1Database,
  userId: string,
  delta: number,
): Promise<number> {
  const now = new Date().toISOString();

  // SQLite UPDATE with RETURNING is supported in D1.
  const result = await db
    .prepare(
      `UPDATE wallets
          SET balance    = balance + ?1,
              updated_at = ?2
        WHERE user_id = ?3
          AND (balance + ?1) >= 0
       RETURNING balance`,
    )
    .bind(delta, now, userId)
    .first<{ balance: number }>();

  if (!result) {
    // Either the wallet does not exist or the balance would go negative.
    const wallet = await getWallet(db, userId);
    if (!wallet) throw new Error("Wallet not found for user.");
    throw new Error(
      `Insufficient balance. Current: ${wallet.balance.toFixed(6)}, delta: ${delta.toFixed(6)}.`,
    );
  }

  return result.balance;
}

// ===========================================================================
// Conversation helpers
// ===========================================================================

/**
 * List conversations for a user, ordered by most recently updated.
 * @param limit Defaults to 50.
 */
export async function getConversations(
  db: D1Database,
  userId: string,
  limit: number = 50,
): Promise<ConversationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM conversations
        WHERE user_id = ?1
        ORDER BY updated_at DESC
        LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<ConversationRow>();

  return results;
}

/**
 * Create a new conversation.
 * @returns The created conversation row.
 */
export async function createConversation(
  db: D1Database,
  userId: string,
  title: string = "New conversation",
): Promise<ConversationRow> {
  const id = generateId();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO conversations (id, user_id, title, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    )
    .bind(id, userId, title, now)
    .run();

  const row = await db
    .prepare("SELECT * FROM conversations WHERE id = ?1 LIMIT 1")
    .bind(id)
    .first<ConversationRow>();

  if (!row) throw new Error("Conversation creation failed.");
  return row;
}

/**
 * Retrieve a single conversation, scoped to the owning user.
 * @returns The conversation row, or null if not found / not owned.
 */
export async function getConversation(
  db: D1Database,
  id: string,
  userId: string,
): Promise<ConversationRow | null> {
  return db
    .prepare(
      "SELECT * FROM conversations WHERE id = ?1 AND user_id = ?2 LIMIT 1",
    )
    .bind(id, userId)
    .first<ConversationRow>();
}

/**
 * Update a conversation's title and bump updated_at.
 */
export async function updateConversationTitle(
  db: D1Database,
  id: string,
  userId: string,
  title: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE conversations SET title = ?1, updated_at = ?2
        WHERE id = ?3 AND user_id = ?4`,
    )
    .bind(title, now, id, userId)
    .run();
}

/**
 * Delete a conversation and cascade-delete its messages.
 */
export async function deleteConversation(
  db: D1Database,
  id: string,
  userId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM conversations WHERE id = ?1 AND user_id = ?2")
    .bind(id, userId)
    .run();
}

// ===========================================================================
// Message helpers
// ===========================================================================

/**
 * Retrieve messages for a conversation, ordered by creation time.
 * @param limit Defaults to 200.
 */
export async function getMessages(
  db: D1Database,
  conversationId: string,
  limit: number = 200,
): Promise<MessageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM messages
        WHERE conversation_id = ?1
        ORDER BY created_at ASC
        LIMIT ?2`,
    )
    .bind(conversationId, limit)
    .all<MessageRow>();

  return results;
}

/**
 * Insert one or more messages in a single D1 batch.
 * Also bumps the parent conversation's updated_at.
 *
 * @returns The inserted message rows.
 */
export async function insertMessages(
  db: D1Database,
  messages: NewMessage[],
): Promise<MessageRow[]> {
  if (messages.length === 0) return [];

  const now = new Date().toISOString();
  const ids: string[] = messages.map(() => generateId());

  const insertStmts = messages.map((msg, i) =>
    db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(ids[i], msg.conversation_id, msg.role, msg.content, now),
  );

  // Also touch the conversation's updated_at.
  const conversationIds = [...new Set(messages.map((m) => m.conversation_id))];
  const touchStmts = conversationIds.map((cid) =>
    db
      .prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2")
      .bind(now, cid),
  );

  await db.batch([...insertStmts, ...touchStmts]);

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY created_at ASC`,
    )
    .bind(...ids)
    .all<MessageRow>();

  return results;
}

// ===========================================================================
// Usage record helpers
// ===========================================================================

/**
 * Persist one usage record.
 * @returns The inserted row.
 */
export async function recordUsage(
  db: D1Database,
  record: UsageRecordInput,
): Promise<UsageRecordRow> {
  const id = generateId();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO usage_records
         (id, user_id, conversation_id, provider, model,
          input_tokens, output_tokens,
          cached_input_tokens, cache_write_tokens, cache_read_tokens,
          api_cost, platform_markup, final_cost, created_at)
       VALUES
         (?1,  ?2,  ?3,  ?4,  ?5,
          ?6,  ?7,
          ?8,  ?9,  ?10,
          ?11, ?12, ?13, ?14)`,
    )
    .bind(
      id,
      record.user_id,
      record.conversation_id ?? null,
      record.provider,
      record.model,
      record.input_tokens,
      record.output_tokens,
      record.cached_input_tokens ?? 0,
      record.cache_write_tokens ?? 0,
      record.cache_read_tokens ?? 0,
      record.api_cost,
      record.platform_markup,
      record.final_cost,
      now,
    )
    .run();

  const row = await db
    .prepare("SELECT * FROM usage_records WHERE id = ?1 LIMIT 1")
    .bind(id)
    .first<UsageRecordRow>();

  if (!row) throw new Error("Usage record insertion failed.");
  return row;
}

/**
 * Fetch all usage records for a user since a given date.
 * @param since Only records created at or after this date are returned.
 */
export async function getUserUsage(
  db: D1Database,
  userId: string,
  since: Date,
): Promise<UsageRecordRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM usage_records
        WHERE user_id = ?1
          AND created_at >= ?2
        ORDER BY created_at DESC`,
    )
    .bind(userId, since.toISOString())
    .all<UsageRecordRow>();

  return results;
}

// ===========================================================================
// App settings helpers
// ===========================================================================

/**
 * Retrieve an app setting by key.
 * The value is returned as a raw string; callers should JSON.parse when needed.
 * @returns The setting row, or null if not found.
 */
export async function getAppSetting(
  db: D1Database,
  key: string,
): Promise<AppSettingRow | null> {
  return db
    .prepare("SELECT * FROM app_settings WHERE key = ?1 LIMIT 1")
    .bind(key)
    .first<AppSettingRow>();
}

/**
 * Upsert an app setting.
 * The value should be a JSON-encoded string for complex types.
 */
export async function setAppSetting(
  db: D1Database,
  key: string,
  value: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now)
    .run();
}

/**
 * Convenience wrapper that parses the stored JSON value automatically.
 * @returns The parsed value, or null if the key does not exist.
 */
export async function getAppSettingParsed<T = unknown>(
  db: D1Database,
  key: string,
): Promise<T | null> {
  const row = await getAppSetting(db, key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

// ===========================================================================
// Free usage daily helpers
// ===========================================================================

/**
 * Get today's free-usage record for a user (UTC date).
 * @returns The row, or null if there is no record for today yet.
 */
export async function getFreeUsageToday(
  db: D1Database,
  userId: string,
): Promise<FreeUsageDailyRow | null> {
  const today = utcDateString();
  return db
    .prepare(
      `SELECT * FROM free_usage_daily
        WHERE user_id = ?1 AND date = ?2
        LIMIT 1`,
    )
    .bind(userId, today)
    .first<FreeUsageDailyRow>();
}

/**
 * Increment today's free-usage counters for a user.
 * Inserts the row if it does not exist yet (upsert).
 *
 * @returns The updated row.
 */
export async function incrementFreeUsage(
  db: D1Database,
  userId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<FreeUsageDailyRow> {
  const today = utcDateString();

  // Use an upsert so we never have to worry about whether the row exists.
  await db
    .prepare(
      `INSERT INTO free_usage_daily
         (id, user_id, date, messages_count, input_tokens, output_tokens)
       VALUES (?1, ?2, ?3, 1, ?4, ?5)
       ON CONFLICT(user_id, date) DO UPDATE
         SET messages_count = messages_count + 1,
             input_tokens   = input_tokens   + excluded.input_tokens,
             output_tokens  = output_tokens  + excluded.output_tokens`,
    )
    .bind(generateId(), userId, today, inputTokens, outputTokens)
    .run();

  const row = await db
    .prepare(
      "SELECT * FROM free_usage_daily WHERE user_id = ?1 AND date = ?2 LIMIT 1",
    )
    .bind(userId, today)
    .first<FreeUsageDailyRow>();

  if (!row) throw new Error("Free usage upsert failed.");
  return row;
}

// ---------------------------------------------------------------------------
// Internal date helper
// ---------------------------------------------------------------------------

/** Returns the current UTC date as "YYYY-MM-DD". */
function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ===========================================================================
// Subscription helpers
// ===========================================================================

/**
 * Get the active subscription for a user.
 * @returns The subscription row, or null if none exists.
 */
export async function getSubscription(
  db: D1Database,
  userId: string,
): Promise<SubscriptionRow | null> {
  return db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ?1 LIMIT 1")
    .bind(userId)
    .first<SubscriptionRow>();
}

/**
 * Create or update a subscription record for a user.
 * Uses ON CONFLICT(user_id) to perform an upsert.
 *
 * @returns The upserted subscription row.
 */
export async function upsertSubscription(
  db: D1Database,
  data: SubscriptionInput,
): Promise<SubscriptionRow> {
  const id = generateId();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO subscriptions
         (id, user_id, plan_id,
          stripe_subscription_id, stripe_customer_id, price_id,
          status, cancel_at_period_end, environment,
          current_period_start, current_period_end,
          created_at, updated_at)
       VALUES
         (?1,  ?2,  ?3,
          ?4,  ?5,  ?6,
          ?7,  ?8,  ?9,
          ?10, ?11,
          ?12, ?12)
       ON CONFLICT(user_id) DO UPDATE SET
         plan_id                = excluded.plan_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         stripe_customer_id     = excluded.stripe_customer_id,
         price_id               = excluded.price_id,
         status                 = excluded.status,
         cancel_at_period_end   = excluded.cancel_at_period_end,
         environment            = excluded.environment,
         current_period_start   = excluded.current_period_start,
         current_period_end     = excluded.current_period_end,
         updated_at             = excluded.updated_at`,
    )
    .bind(
      id,
      data.user_id,
      data.plan_id,
      data.stripe_subscription_id ?? null,
      data.stripe_customer_id ?? null,
      data.price_id ?? null,
      data.status ?? "active",
      data.cancel_at_period_end ? 1 : 0,
      data.environment ?? "production",
      data.current_period_start ?? null,
      data.current_period_end ?? null,
      now,
    )
    .run();

  const row = await db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ?1 LIMIT 1")
    .bind(data.user_id)
    .first<SubscriptionRow>();

  if (!row) throw new Error("Subscription upsert failed.");
  return row;
}

// ===========================================================================
// Transaction helpers
// ===========================================================================

/**
 * Record a financial transaction.
 * @returns The inserted transaction row.
 */
export async function recordTransaction(
  db: D1Database,
  data: TransactionInput,
): Promise<TransactionRow> {
  const id = generateId();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO transactions
         (id, user_id, amount, type, description,
          stripe_payment_intent_id, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      id,
      data.user_id,
      data.amount,
      data.type,
      data.description ?? null,
      data.stripe_payment_intent_id ?? null,
      data.status ?? "completed",
      now,
    )
    .run();

  const row = await db
    .prepare("SELECT * FROM transactions WHERE id = ?1 LIMIT 1")
    .bind(id)
    .first<TransactionRow>();

  if (!row) throw new Error("Transaction insertion failed.");
  return row;
}

/**
 * List all transactions for a user, most recent first.
 * @param limit Defaults to 100.
 */
export async function getUserTransactions(
  db: D1Database,
  userId: string,
  limit: number = 100,
): Promise<TransactionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM transactions
        WHERE user_id = ?1
        ORDER BY created_at DESC
        LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<TransactionRow>();

  return results;
}
