/**
 * SERVER-ONLY structured logging.
 *
 * Every log line carries a request id, timestamp, endpoint and (when known)
 * the user id, so production monitoring can be attached without touching call
 * sites. Values are redacted defensively — secrets, tokens and keys must never
 * reach the log stream.
 */

export type LogEvent =
  | "auth.failure"
  | "ratelimit.violation"
  | "provider.failure"
  | "provider.latency"
  | "billing.charge"
  | "billing.failure"
  | "wallet.update"
  | "payment.failure"
  | "image.latency"
  | "image.upload"
  | "usage.record_failed"
  | "server.exception";

export interface LogContext {
  requestId: string;
  endpoint: string;
  userId?: string;
  [key: string]: unknown;
}

const SECRET_KEY_PATTERN = /(key|token|secret|password|authorization|apikey)/i;

/** Drops anything that looks like a credential and truncates long strings. */
function redact(value: unknown): unknown {
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
      SECRET_KEY_PATTERN.test(key) ? [key, "[redacted]"] : [key, redact(entry)],
    ),
  );
}

function emit(level: "info" | "warn" | "error", event: LogEvent, context: LogContext, extra?: unknown) {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...(redact(context) as object),
    ...(extra ? { detail: redact(extra) } : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: LogEvent, context: LogContext, extra?: unknown) => emit("info", event, context, extra),
  warn: (event: LogEvent, context: LogContext, extra?: unknown) => emit("warn", event, context, extra),
  error: (event: LogEvent, context: LogContext, extra?: unknown) => emit("error", event, context, extra),
};

export function newRequestId(): string {
  return crypto.randomUUID();
}
