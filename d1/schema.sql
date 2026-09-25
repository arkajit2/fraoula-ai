-- =============================================================================
-- Fraoula AI — Cloudflare D1 (SQLite) Schema
-- Translated from Supabase PostgreSQL migrations.
-- Compatible with Cloudflare D1 / better-sqlite3.
-- Run once against an empty D1 database:
--   wrangler d1 execute <DB_NAME> --file=d1/schema.sql
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- users
-- Replaces auth.users + public.profiles. Passwords are stored as PBKDF2
-- hashes (salt:hash, both hex-encoded). email_verified and is_admin use
-- INTEGER 0/1 (SQLite has no boolean type).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,                      -- crypto.randomUUID()
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,                         -- "hexSalt:hexHash"
  display_name    TEXT,
  avatar_url      TEXT,
  email_verified  INTEGER NOT NULL DEFAULT 0,            -- 0 | 1
  is_admin        INTEGER NOT NULL DEFAULT 0,            -- 0 | 1
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ---------------------------------------------------------------------------
-- sessions
-- Server-side sessions. The raw token is returned to the client (cookie /
-- Authorization header). Only the SHA-256 hash is stored here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                          -- crypto.randomUUID()
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,                      -- hex SHA-256 of raw token
  ip_address  TEXT,
  user_agent  TEXT,
  expires_at  TEXT NOT NULL,                             -- ISO-8601 UTC
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- wallets
-- One wallet per user. balance is stored in USD (REAL). Mutations go through
-- updateWalletBalance() which uses a delta to avoid read-modify-write races
-- when possible; for safety, always wrap in a D1 batch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  id         TEXT PRIMARY KEY,                           -- crypto.randomUUID()
  user_id    TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  balance    REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets (user_id);

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,                           -- crypto.randomUUID()
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New conversation',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id    ON conversations (user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations (updated_at DESC);

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,                      -- crypto.randomUUID()
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at      ON messages (created_at);

-- ---------------------------------------------------------------------------
-- usage_records
-- Per-request LLM cost accounting. All token counts are integers; costs are
-- USD stored as REAL. cached_input_tokens / cache_write_tokens /
-- cache_read_tokens support Anthropic prompt-caching billing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_records (
  id                   TEXT PRIMARY KEY,                 -- crypto.randomUUID()
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id      TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  provider             TEXT NOT NULL,                    -- e.g. "anthropic", "openai"
  model                TEXT NOT NULL,                    -- e.g. "claude-3-5-sonnet-20241022"
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  api_cost             REAL NOT NULL DEFAULT 0.0,        -- raw provider cost (USD)
  platform_markup      REAL NOT NULL DEFAULT 0.0,        -- markup added on top
  final_cost           REAL NOT NULL DEFAULT 0.0,        -- api_cost + platform_markup
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_records_user_id         ON usage_records (user_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_conversation_id ON usage_records (conversation_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_created_at      ON usage_records (created_at);

-- ---------------------------------------------------------------------------
-- app_settings
-- Key-value store for runtime configuration. Values are JSON-encoded strings
-- so they can hold any scalar or complex type.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- free_usage_daily
-- Tracks free-tier consumption per user per calendar day (UTC).
-- Prevents double-counting across restarts via UNIQUE(user_id, date).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS free_usage_daily (
  id             TEXT PRIMARY KEY,                       -- crypto.randomUUID()
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  date           TEXT NOT NULL,                          -- "YYYY-MM-DD" UTC
  messages_count INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_free_usage_daily_user_date ON free_usage_daily (user_id, date);

-- ---------------------------------------------------------------------------
-- subscriptions
-- Mirrors public.subscriptions from Supabase. stripe_subscription_id and
-- stripe_customer_id are nullable here because a user may be on a free plan
-- without ever touching Stripe. The plan_id "free" is the implicit default.
-- user_id is UNIQUE — only one active subscription row per user.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      TEXT PRIMARY KEY,              -- crypto.randomUUID()
  user_id                 TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  plan_id                 TEXT NOT NULL DEFAULT 'free',
  stripe_subscription_id  TEXT UNIQUE,
  stripe_customer_id      TEXT,
  price_id                TEXT,
  status                  TEXT NOT NULL DEFAULT 'active',
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0,    -- 0 | 1
  environment             TEXT NOT NULL DEFAULT 'production',
  current_period_start    TEXT,                          -- ISO-8601 UTC
  current_period_end      TEXT,                          -- ISO-8601 UTC
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id   ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_id ON subscriptions (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status    ON subscriptions (status);

-- ---------------------------------------------------------------------------
-- transactions
-- Financial ledger for wallet top-ups, refunds, usage deductions, etc.
-- amount is always positive; type encodes direction ("credit" / "debit" / etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id                       TEXT PRIMARY KEY,             -- crypto.randomUUID()
  user_id                  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount                   REAL NOT NULL,                -- USD, always positive
  type                     TEXT NOT NULL,                -- "credit" | "debit" | "refund" | "stripe_payment"
  description              TEXT,
  stripe_payment_intent_id TEXT,
  status                   TEXT NOT NULL DEFAULT 'completed', -- "pending" | "completed" | "failed"
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id    ON transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_status     ON transactions (status);

-- =============================================================================
-- Seed data
-- =============================================================================

-- Default free-tier limits.
-- messages_per_day: max chat messages a free user can send in a 24-h window.
-- input_tokens_per_day / output_tokens_per_day: token budget.
-- max_context_messages: how many past messages are included in the prompt.
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (
  'free_tier_limits',
  json_object(
    'messages_per_day',       20,
    'input_tokens_per_day',   50000,
    'output_tokens_per_day',  20000,
    'max_context_messages',   10,
    'image_uploads_per_day',  3
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- Global platform markup applied on top of raw provider cost (0.30 = 30 %).
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (
  'platform_markup_rate',
  '0.30',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- Maintenance mode flag (boolean as JSON).
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (
  'maintenance_mode',
  'false',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
