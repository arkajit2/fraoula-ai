/**
 * auth.server.ts
 * Server-only authentication module for Fraoula AI.
 *
 * Responsibilities:
 *  - Password hashing / verification via PBKDF2 (Web Crypto API)
 *  - Session lifecycle: create, verify, revoke
 *  - User CRUD helpers consumed by API routes
 *
 * All database access goes through Cloudflare D1 prepared statements.
 * Never import this module in client-side code.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  email_verified: boolean;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
}

export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Internal DB row shapes (raw from D1 — booleans come back as 0 | 1)
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  avatar_url: string | null;
  email_verified: number; // 0 | 1
  is_admin: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Session lifetime in milliseconds (30 days). */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** PBKDF2 iteration count. */
const PBKDF2_ITERATIONS = 100_000;

/** Derived key length in bytes. */
const KEY_LENGTH_BYTES = 32;

/** Salt length in bytes. */
const SALT_LENGTH_BYTES = 16;

// ---------------------------------------------------------------------------
// UUID helper
// ---------------------------------------------------------------------------

/** Generate a random UUID using the Web Crypto API. */
export function generateId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Hex encoding helpers
// ---------------------------------------------------------------------------

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBuf(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new AuthError("Invalid hex string", 500);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password using PBKDF2 / SHA-256.
 * Returns a string in the format `hexSalt:hexDerivedKey`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    KEY_LENGTH_BYTES * 8,
  );

  return `${bufToHex(salt.buffer)}:${bufToHex(derivedBits)}`;
}

/**
 * Verify a plaintext password against a stored `hexSalt:hexHash` value.
 * Uses a constant-time comparison to prevent timing attacks.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const separatorIdx = stored.indexOf(":");
  if (separatorIdx === -1) return false;

  const salt = hexToBuf(stored.slice(0, separatorIdx));
  const storedHash = hexToBuf(stored.slice(separatorIdx + 1));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    KEY_LENGTH_BYTES * 8,
  );

  const candidate = new Uint8Array(derivedBits);

  // Constant-time compare to prevent timing side-channels.
  if (candidate.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate[i] ^ storedHash[i];
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Session token helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random hex token (64-char / 32 bytes).
 * Only this raw value is returned to the client. The SHA-256 hash is stored
 * in the database.
 */
async function generateSessionToken(): Promise<{
  rawToken: string;
  tokenHash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const rawToken = bufToHex(bytes.buffer);
  const hashBuf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawToken),
  );
  const tokenHash = bufToHex(hashBuf);
  return { rawToken, tokenHash };
}

/**
 * Hash an incoming token string (SHA-256) so we can look it up in the DB.
 */
async function hashToken(rawToken: string): Promise<string> {
  const hashBuf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawToken),
  );
  return bufToHex(hashBuf);
}

// ---------------------------------------------------------------------------
// Row → domain type mappers
// ---------------------------------------------------------------------------

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    email_verified: row.email_verified === 1,
    is_admin: row.is_admin === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    user_id: row.user_id,
    token_hash: row.token_hash,
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new user.
 *
 * - Checks for duplicate email.
 * - Hashes the password with PBKDF2.
 * - Creates the user row and a new session.
 *
 * @returns The created User and a raw session token (pass to the client).
 * @throws AuthError(409) if the email is already registered.
 */
export async function registerUser(
  db: D1Database,
  email: string,
  password: string,
  displayName?: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<{ user: User; token: string }> {
  const normalizedEmail = email.trim().toLowerCase();

  // Check uniqueness.
  const existing = await db
    .prepare("SELECT id FROM users WHERE email = ?1 LIMIT 1")
    .bind(normalizedEmail)
    .first<{ id: string }>();

  if (existing) {
    throw new AuthError("An account with this email already exists.", 409);
  }

  const passwordHash = await hashPassword(password);
  const userId = generateId();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO users
         (id, email, password_hash, display_name, email_verified, is_admin, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?5)`,
    )
    .bind(userId, normalizedEmail, passwordHash, displayName ?? null, now)
    .run();

  const userRow = await db
    .prepare("SELECT * FROM users WHERE id = ?1 LIMIT 1")
    .bind(userId)
    .first<UserRow>();

  if (!userRow) {
    throw new AuthError("Failed to retrieve user after registration.", 500);
  }

  const { rawToken, token } = await createSession(
    db,
    userId,
    ipAddress,
    userAgent,
  );

  return { user: rowToUser(userRow), token: rawToken };
}

/**
 * Authenticate a user with email + password.
 *
 * @returns The authenticated User and a raw session token.
 * @throws AuthError(401) on invalid credentials.
 */
export async function loginUser(
  db: D1Database,
  email: string,
  password: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<{ user: User; token: string }> {
  const normalizedEmail = email.trim().toLowerCase();

  const userRow = await db
    .prepare("SELECT * FROM users WHERE email = ?1 LIMIT 1")
    .bind(normalizedEmail)
    .first<UserRow>();

  if (!userRow) {
    // Perform a dummy hash to maintain constant response time.
    await hashPassword("dummy-timing-prevention");
    throw new AuthError("Invalid email or password.", 401);
  }

  const passwordValid = await verifyPassword(password, userRow.password_hash);
  if (!passwordValid) {
    throw new AuthError("Invalid email or password.", 401);
  }

  const { rawToken } = await createSession(
    db,
    userRow.id,
    ipAddress,
    userAgent,
  );

  return { user: rowToUser(userRow), token: rawToken };
}

/**
 * Revoke the session associated with the given raw token.
 * Silently succeeds if the token does not exist.
 */
export async function logoutUser(
  db: D1Database,
  rawToken: string,
): Promise<void> {
  const tokenHash = await hashToken(rawToken);
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?1")
    .bind(tokenHash)
    .run();
}

/**
 * Verify a raw session token.
 *
 * - Looks up the token hash in the DB.
 * - Rejects expired sessions (and removes them).
 *
 * @returns The User the session belongs to, or null if invalid / expired.
 */
export async function verifySessionToken(
  db: D1Database,
  rawToken: string,
): Promise<User | null> {
  const tokenHash = await hashToken(rawToken);

  const sessionRow = await db
    .prepare(
      `SELECT * FROM sessions
       WHERE token_hash = ?1 AND expires_at > ?2
       LIMIT 1`,
    )
    .bind(tokenHash, new Date().toISOString())
    .first<SessionRow>();

  if (!sessionRow) {
    // Also purge expired session if it exists (best-effort cleanup).
    await db
      .prepare(
        `DELETE FROM sessions WHERE token_hash = ?1 AND expires_at <= ?2`,
      )
      .bind(tokenHash, new Date().toISOString())
      .run();
    return null;
  }

  const userRow = await db
    .prepare("SELECT * FROM users WHERE id = ?1 LIMIT 1")
    .bind(sessionRow.user_id)
    .first<UserRow>();

  if (!userRow) {
    await db
      .prepare("DELETE FROM sessions WHERE id = ?1")
      .bind(sessionRow.id)
      .run();
    return null;
  }

  return rowToUser(userRow);
}

/**
 * Look up a user by their UUID.
 *
 * @returns The User, or null if not found.
 */
export async function getUserById(
  db: D1Database,
  userId: string,
): Promise<User | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE id = ?1 LIMIT 1")
    .bind(userId)
    .first<UserRow>();

  return row ? rowToUser(row) : null;
}

/**
 * Update a user's password.
 * Invalidates ALL existing sessions for the user after the change.
 *
 * @throws AuthError(404) if the user is not found.
 */
export async function updatePassword(
  db: D1Database,
  userId: string,
  newPassword: string,
): Promise<void> {
  const exists = await db
    .prepare("SELECT id FROM users WHERE id = ?1 LIMIT 1")
    .bind(userId)
    .first<{ id: string }>();

  if (!exists) {
    throw new AuthError("User not found.", 404);
  }

  const passwordHash = await hashPassword(newPassword);
  const now = new Date().toISOString();

  await db
    .batch([
      db
        .prepare(
          "UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3",
        )
        .bind(passwordHash, now, userId),
      // Invalidate all sessions so the user must re-login everywhere.
      db
        .prepare("DELETE FROM sessions WHERE user_id = ?1")
        .bind(userId),
    ]);
}

// ---------------------------------------------------------------------------
// Internal session factory
// ---------------------------------------------------------------------------

/**
 * Create a new session row and return the raw (client-facing) token.
 */
async function createSession(
  db: D1Database,
  userId: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<{ rawToken: string; token: string }> {
  const { rawToken, tokenHash } = await generateSessionToken();
  const sessionId = generateId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  await db
    .prepare(
      `INSERT INTO sessions
         (id, user_id, token_hash, ip_address, user_agent, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      sessionId,
      userId,
      tokenHash,
      ipAddress ?? null,
      userAgent ?? null,
      expiresAt,
      now.toISOString(),
    )
    .run();

  return { rawToken, token: tokenHash };
}
