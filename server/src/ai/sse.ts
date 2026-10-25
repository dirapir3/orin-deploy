/**
 * Incremental parser for upstream Server-Sent Events (OpenAI / Anthropic streams).
 * Feed it raw text chunks; it yields complete events.
 */
export interface SSEEvent {
  event?: string;
  data: string;
}

export class SSEParser {
  private buffer = '';

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    // Normalise CRLF to LF so both line endings work.
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const ev = parseBlock(raw);
      if (ev) events.push(ev);
    }
    return events;
  }

  flush(): SSEEvent[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    const ev = parseBlock(rest);
    return ev ? [ev] : [];
  }
}

function parseBlock(raw: string): SSEEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0 && !event) return null;
  return { event, data: data.join('\n') };
}

export async function* readSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) yield ev;
    }
    for (const ev of parser.flush()) yield ev;
  } finally {
    reader.releaseLock();
  }
}
