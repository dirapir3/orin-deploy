export type ErrorCode =
  | 'validation_error'
  | 'auth_required'
  | 'auth_expired'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'provider_not_configured'
  | 'voice_not_configured'
  | 'vision_not_supported'
  | 'invalid_api_key'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_bad_request'
  | 'content_filtered'
  | 'timeout'
  | 'cancelled'
  | 'unsupported_file'
  | 'file_too_large'
  | 'extraction_failed'
  | 'database_error'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  auth_required: 401,
  auth_expired: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  provider_not_configured: 503,
  voice_not_configured: 503,
  vision_not_supported: 400,
  invalid_api_key: 502,
  provider_rate_limited: 429,
  provider_unavailable: 502,
  provider_bad_request: 502,
  content_filtered: 422,
  timeout: 504,
  cancelled: 499,
  unsupported_file: 415,
  file_too_large: 413,
  extraction_failed: 422,
  database_error: 500,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { details?: unknown; status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? STATUS[code];
    this.details = opts.details;
    this.retryable =
      opts.retryable ??
      ['rate_limited', 'provider_rate_limited', 'provider_unavailable', 'timeout', 'internal_error', 'database_error'].includes(code);
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, retryable: this.retryable, details: this.details } };
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return err.name === 'TimeoutError'
      ? new AppError('timeout', 'The AI provider took too long to respond.')
      : new AppError('cancelled', 'The request was cancelled.');
  }
  return new AppError('internal_error', 'Something went wrong on the server.');
}

/** Map an upstream HTTP status from an AI provider to a user-safe AppError. */
export function providerHttpError(status: number, providerName: string, bodySnippet = ''): AppError {
  const lower = bodySnippet.toLowerCase();
  if (status === 401 || status === 403) {
    return new AppError('invalid_api_key', `${providerName} rejected the server's API key. Check the key in the server .env file.`);
  }
  if (status === 429) {
    // A used-up daily quota will not come back for hours: say so, so the fallback chain rests that
    // model for an hour instead of retrying it on every message (see ai/fallback.ts cooldownMs).
    if (lower.includes('perday') || lower.includes('per day')) {
      return new AppError('provider_rate_limited', `${providerName} daily quota reached.`, { retryable: false });
    }
    if (lower.includes('quota') || lower.includes('billing') || lower.includes('credit')) {
      return new AppError('provider_rate_limited', `${providerName} quota or billing limit reached.`, { retryable: false });
    }
    return new AppError('provider_rate_limited', `${providerName} is rate limiting requests. Try again shortly.`);
  }
  if (status === 400 || status === 404 || status === 422) {
    if (lower.includes('content') && (lower.includes('policy') || lower.includes('filter'))) {
      return new AppError('content_filtered', 'The request was blocked by the provider content policy.');
    }
    if (/max_tokens|max_completion_tokens|max_output_tokens|maxoutputtokens|output tokens|completion tokens/.test(lower)) {
      return new AppError('provider_bad_request', `${providerName} rejected the output token budget (HTTP ${status}).`, { retryable: false });
    }
    return new AppError('provider_bad_request', `${providerName} could not process this request (HTTP ${status}). Check the model name and input.`, {
      retryable: false,
    });
  }
  if (status === 408 || status === 504) return new AppError('timeout', `${providerName} timed out.`);
  return new AppError('provider_unavailable', `${providerName} is unavailable right now (HTTP ${status}).`);
}
