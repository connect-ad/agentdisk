/**
 * The uniform error envelope from 05 PART 13.
 *
 * Two rules this file exists to enforce, both from 06 PART 16.17:
 *
 *  1. A client never sees an internal exception. Anything that is not an
 *     ApiError is replaced with a generic INTERNAL_ERROR before serialization,
 *     because an internal message can carry a secret, a query, or a row.
 *  2. Authentication failures are indistinguishable from each other. An unknown
 *     key, a revoked key, an expired key and a malformed header all produce the
 *     same UNAUTHORIZED body. The specific reason is kept for our own logs only
 *     - telling the caller which one it was hands an attacker a key oracle.
 */

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "LIMIT_EXCEEDED"
  | "INTERNAL_ERROR";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  /**
   * Why this really failed. Logged, never serialized to the client. Exists so
   * the generic client-facing message above stays generic without us losing
   * the ability to debug a support ticket.
   */
  readonly internalReason?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; internalReason?: string } = {}
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = options.details;
    this.internalReason = options.internalReason;
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/**
 * The single message every authentication failure returns.
 *
 * Deliberately says nothing about which part failed. `internalReason` carries
 * that for the log line.
 */
export function unauthorized(internalReason: string): ApiError {
  return new ApiError("UNAUTHORIZED", "That credential isn't valid.", { internalReason });
}

export function forbidden(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError("FORBIDDEN", message, { details });
}

export function validationError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError("VALIDATION_ERROR", message, { details });
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

/** Serialize an error for the client. Never call this with a raw exception. */
export function errorBody(err: ApiError, requestId: string): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      requestId,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}

/**
 * Turn anything thrown into a response.
 *
 * Non-ApiError throwables become INTERNAL_ERROR with a fixed message: whatever
 * the original said, it was not written with a client in mind.
 */
export function toErrorResponse(thrown: unknown, requestId: string): Response {
  const err =
    thrown instanceof ApiError
      ? thrown
      : new ApiError("INTERNAL_ERROR", "Something went wrong on our end.", {
          internalReason: thrown instanceof Error ? thrown.message : String(thrown),
        });

  console.log(
    JSON.stringify({
      level: err.status >= 500 ? "error" : "warn",
      requestId,
      code: err.code,
      status: err.status,
      reason: err.internalReason ?? err.message,
    })
  );

  return new Response(JSON.stringify(errorBody(err, requestId)), {
    status: err.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
