import { AppError, providerHttpError } from '../errors.js';

export type FetchLike = typeof fetch;

/** Combine the client's cancellation signal with a timeout. */
export function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

export async function providerFetch(
  fetchImpl: FetchLike,
  providerName: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    const e = err as Error;
    if (e?.name === 'TimeoutError') throw new AppError('timeout', `${providerName} took too long to respond.`);
    if (e?.name === 'AbortError') throw new AppError('cancelled', 'The request was cancelled.');
    const hint = /ollama/i.test(providerName)
      ? ' Is Ollama running (`ollama serve`) and is OLLAMA_BASE_URL correct?'
      : " Check the server's network and base URL.";
    throw new AppError('provider_unavailable', `Could not reach ${providerName}.${hint}`);
  }
  if (!res.ok) {
    let snippet = '';
    try {
      // Gemini puts the quota id (…PerDay… vs …PerMinute…) well past the first 500 characters.
      snippet = (await res.text()).slice(0, 3000);
    } catch {
      /* ignore */
    }
    throw providerHttpError(res.status, providerName, snippet);
  }
  return res;
}
