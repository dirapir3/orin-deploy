import { z } from 'zod';
import { defineTool } from './types.js';

/** Safe arithmetic evaluator (no eval): + - * / % ^, parentheses, functions and constants. */
export function evaluate(expr: string): number {
  const src = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/,(?=\d{3}\b)/g, '').replace(/\*\*/g, '^');
  let pos = 0;
  const FUNCS: Record<string, (...x: number[]) => number> = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp, min: Math.min, max: Math.max, pow: Math.pow,
  };
  const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
  const peek = () => src[pos];
  const skip = () => {
    while (pos < src.length && /\s/.test(src[pos]!)) pos++;
  };
  const expect = (c: string) => {
    skip();
    if (src[pos] !== c) throw new Error(`Expected "${c}" at position ${pos}`);
    pos++;
  };
  function primary(): number {
    skip();
    const c = peek();
    if (c === '(') {
      pos++;
      const v = expression();
      expect(')');
      return v;
    }
    if (c === '-') {
      pos++;
      return -power();
    }
    if (c === '+') {
      pos++;
      return power();
    }
    const num = /^(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(pos));
    if (num) {
      pos += num[0].length;
      return parseFloat(num[0]);
    }
    const id = /^[a-z][a-z0-9]*/i.exec(src.slice(pos));
    if (id) {
      const name = id[0].toLowerCase();
      pos += id[0].length;
      skip();
      if (peek() === '(') {
        const f = FUNCS[name];
        if (!f) throw new Error(`Unknown function ${name}`);
        pos++;
        const args = [expression()];
        skip();
        while (peek() === ',') {
          pos++;
          args.push(expression());
          skip();
        }
        expect(')');
        return f(...args);
      }
      if (name in CONSTS) return CONSTS[name]!;
      throw new Error(`Unknown name ${name}`);
    }
    throw new Error(`Unexpected "${c ?? 'end'}" at position ${pos}`);
  }
  function postfix(): number {
    let v = primary();
    skip();
    while (peek() === '%' || peek() === '!') {
      if (peek() === '!') {
        pos++;
        if (v < 0 || v > 170 || !Number.isInteger(v)) throw new Error('Factorial needs an integer 0..170');
        let r = 1;
        for (let i = 2; i <= v; i++) r *= i;
        v = r;
      } else {
        // a trailing % means percent unless followed by an operand (modulo)
        const rest = src.slice(pos + 1).trimStart();
        if (rest && /^[\d(.a-z]/i.test(rest)) break;
        pos++;
        v = v / 100;
      }
      skip();
    }
    return v;
  }
  function power(): number {
    const base = postfix();
    skip();
    if (peek() === '^') {
      pos++;
      return Math.pow(base, power());
    }
    return base;
  }
  function term(): number {
    let v = power();
    for (;;) {
      skip();
      const c = peek();
      if (c === '*' || c === '/' || c === '%') {
        pos++;
        const r = power();
        v = c === '*' ? v * r : c === '/' ? v / r : v % r;
      } else return v;
    }
  }
  function expression(): number {
    let v = term();
    for (;;) {
      skip();
      const c = peek();
      if (c === '+' || c === '-') {
        pos++;
        const r = term();
        v = c === '+' ? v + r : v - r;
      } else return v;
    }
  }
  const v = expression();
  skip();
  if (pos < src.length) throw new Error(`Unexpected "${src[pos]}" at position ${pos}`);
  if (!Number.isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}

export const calculatorTool = defineTool({
  name: 'calculator',
  description: 'Evaluate an arithmetic expression exactly (use for any non-trivial math). Supports + - * / % ^ ! parentheses, sqrt, sin, cos, tan, log, ln, exp, min, max, pi, e.',
  schema: z.object({ expression: z.string().min(1).max(500) }),
  label: () => 'Calculating…',
  handler: async (a) => {
    try {
      const v = evaluate(a.expression);
      const out = Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
      return { content: `${a.expression} = ${out}`, summary: `= ${out}`.slice(0, 60) };
    } catch (e) {
      return { ok: false, content: `Could not evaluate: ${(e as Error).message}`, summary: 'Calculation error' };
    }
  },
});

export const dateTimeTool = defineTool({
  name: 'get_datetime',
  description: 'Get the current date and time, optionally in another IANA timezone (e.g. "Asia/Dhaka"), or the difference between now and a date.',
  schema: z.object({
    timezone: z.string().max(60).optional(),
    until: z.string().max(40).optional().describe('ISO date to count days until'),
  }),
  label: () => 'Checking the time…',
  handler: async (a, ctx) => {
    const tz = a.timezone || ctx.timezone || 'UTC';
    let formatted: string;
    try {
      formatted = new Date().toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
    } catch {
      return { ok: false, content: `Unknown timezone "${tz}".`, summary: 'Unknown timezone' };
    }
    let extra = '';
    if (a.until) {
      const t = Date.parse(a.until);
      if (Number.isFinite(t)) {
        const days = (t - Date.now()) / 86_400_000;
        extra = `\n${a.until} is ${Math.abs(days).toFixed(1)} days ${days >= 0 ? 'from now' : 'ago'}.`;
      }
    }
    return { content: `Now: ${formatted} (${tz}). ISO: ${new Date().toISOString()}${extra}`, summary: formatted };
  },
});
