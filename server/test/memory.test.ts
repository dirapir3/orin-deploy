import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { getMemorySettings, learnFromTurn, memoryContext, memoryIdle, searchMemory, setMemorySettings } from '../src/agent/memory.js';
import { redactSecrets, secretProblem, MemorySecretError } from '../src/agent/memorySafety.js';
import { AgentStore } from '../src/agent/store.js';
import type { ChatChunk, ChatProvider, ChatRequest } from '../src/ai/types.js';
import { makeTestApp, mockFetch, sseResponse } from './helpers.js';

/**
 * Long-term memory: facts and earlier conversations per character, recalled into new chats and
 * calls, learned from chats in the background, corrected and deleted by the user, never holding
 * secrets, never crossing accounts or characters, off in temporary chats and when turned off.
 */

const openaiSSE = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const answer = (text: string) => sseResponse([openaiSSE({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']);
const guest = (n: number) => ({ 'X-Guest-Id': `${String(n).repeat(8)}-eeee-4eee-8eee-${String(n).repeat(12)}` });
const CHAT = (n: number) => `${String(n).repeat(8)}-cccc-4ccc-8ccc-${String(n).repeat(12)}`;
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as { messages: { role: string; content: unknown }[]; tools?: { function?: { name: string } }[] };
const systemOf = (init: RequestInit) => String(bodyOf(init).messages.find((m) => m.role === 'system')?.content ?? '');
const isLearning = (init: RequestInit) => systemOf(init).includes('You keep the long-term memory');

function scripted(replies: (string | ((prompt: string) => string))[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let n = 0;
  return {
    id: 'scripted',
    displayName: 'Scripted',
    isDemo: false,
    supportsVision: false,
    supportsTools: true,
    requests,
    async *streamChat(req: ChatRequest) {
      requests.push(req);
      const r = replies[n++] ?? '{"ops":[]}';
      yield { type: 'delta', text: typeof r === 'function' ? r(JSON.stringify(req.messages)) : r } as ChatChunk;
    },
  };
}

describe('secrets stay out of memory', () => {
  it('spots keys, passwords, codes and cards, and leaves ordinary facts alone', () => {
    for (const bad of [
      'My OpenAI key is sk-proj-abcdefghijklmnop1234567890',
      'google key AIzaSyA1234567890abcdefghijklmnopqrstu',
      'SANDBOX_TOKEN=sbx_Rpz27Kku9RqRLjOExf9nM3wzQcPzeTs5A03isNXFrpE',
      'my password is hunter22',
      'the verification code: 482913',
      'card 4242 4242 4242 4242',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
    ]) expect(secretProblem(bad), bad).not.toBeNull();
    for (const ok of [
      'User prefers short answers',
      'The Orin app is hosted on Render',
      'User keeps their passwords in the vault',
      'My API key is saved in Render',
      'Secret plan',
      'Commit f0787a3 removed the calls list',
      'User was born on January 1, 1998',
      'Project id 123e4567-e89b-12d3-a456-426614174000',
    ]) expect(secretProblem(ok), ok).toBeNull();
    expect(redactSecrets('use sk-ant-abcdefghijklmnopqrstuv please')).toBe('use [secret removed] please');
  });

  it('the store refuses a secret and the summary drops one', () => {
    const st = new AgentStore(':memory:');
    expect(() => st.addMemory('o', 'my password is hunter22')).toThrow(MemorySecretError);
    const m = st.addMemory('o', 'User likes teal');
    expect(() => st.updateMemory('o', m.id, { text: 'api key: sk-abcdefghijklmnopqrstuvwx' })).toThrow(MemorySecretError);
    st.setSummary('o', 'c1', 3, 'They pasted sk-proj-abcdefghijklmnop1234567890 by mistake');
    expect(st.getSummary('o', 'c1')?.summary).not.toContain('sk-proj');
    const e = st.upsertEpisode('o', 'c1', { title: 'Keys', summary: 'Token ghp_abcdefghijklmnopqrstuvwxyz0123 was shared' });
    expect(e.summary).toContain('[secret removed]');
    st.close();
  });
});

describe('memory store', () => {
  it('merges the same fact said again, corrects in place and keeps the user words over learned ones', () => {
    const st = new AgentStore(':memory:');
    const a = st.addMemory('o', 'The Orin app backend is hosted on Render', 'auto', { kind: 'project', source: 'auto' });
    const b = st.addMemory('o', 'The Orin app backend is hosted on Render.', '', { source: 'user' });
    expect(b.id).toBe(a.id);
    expect(st.listMemories('o')).toHaveLength(1);
    expect(st.getMemory('o', a.id)?.source).toBe('user');
    const fixed = st.updateMemory('o', a.id, { text: 'The Orin app backend moved to Fly.io' })!;
    expect(fixed.text).toBe('The Orin app backend moved to Fly.io');
    expect(fixed.kind).toBe('project');
    expect(st.updateMemory('someone-else', a.id, { text: 'x y z' })).toBeNull();
    st.close();
  });

  it('recalls what fits the message and the project, not other projects', () => {
    const st = new AgentStore(':memory:');
    const o = 'u:1#orin';
    st.addMemory(o, 'User prefers short replies without code blocks', '', { kind: 'preference' });
    st.addMemory(o, 'Orin app uses Expo and Capacitor', '', { kind: 'project', project: 'Orin' });
    st.addMemory(o, 'Bakery site uses a pink theme', '', { kind: 'project', project: 'Bakery' });
    st.addMemory(o, "User's sister is called Mira", '', { kind: 'person' });
    const orin = memoryContext(st, o, { query: 'what next for the build', project: 'Orin' }).memories.map((m) => m.text);
    expect(orin).toContain('Orin app uses Expo and Capacitor');
    expect(orin).toContain('User prefers short replies without code blocks');
    expect(orin).not.toContain('Bakery site uses a pink theme');
    // another project's details come along when the message is about them
    const asked = memoryContext(st, o, { query: 'what colour theme was the bakery site?', project: 'Orin' }).memories.map((m) => m.text);
    expect(asked).toContain('Bakery site uses a pink theme');
    expect(searchMemory(st, o, 'sisters name')[0]?.text).toBe("User's sister is called Mira");
    st.close();
  });

  it('survives a restart of the server (same database file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orin-mem-'));
    try {
      const file = join(dir, 'agent.db');
      const a = new AgentStore(file);
      a.addMemory('u:9#orin', 'User lives in Dhaka', '', { kind: 'profile' });
      a.upsertEpisode('u:9#orin', CHAT(1), { title: 'Sandbox setup', summary: 'Connected the local sandbox on the other phone.' });
      setMemorySettings(a, 'u:9#orin', { learn: false });
      a.close();
      const b = new AgentStore(file);
      expect(b.listMemories('u:9#orin').map((m) => m.text)).toEqual(['User lives in Dhaka']);
      expect(b.getMemory('u:9#orin', b.listMemories('u:9#orin')[0]!.id)?.kind).toBe('profile');
      expect(b.listEpisodes('u:9#orin')[0]?.title).toBe('Sandbox setup');
      expect(getMemorySettings(b, 'u:9#orin')).toEqual({ enabled: true, learn: false });
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('learning from a chat', () => {
  it('adds facts, corrects old ones, forgets only when the user says so, and summarizes the chat', async () => {
    const st = new AgentStore(':memory:');
    const owner = 'u:2#orin';
    const old = st.addMemory(owner, 'The Orin backend is hosted on Alwaysdata', '', { kind: 'project', project: 'Orin' });
    const tea = st.addMemory(owner, 'User drinks tea every morning', '', { kind: 'preference' });
    const refOf = (prompt: string, text: string) => new RegExp(`\\[(m\\d+)\\] ${text}`).exec(prompt)?.[1];
    const provider = scripted([
      (prompt) =>
        JSON.stringify({
          ops: [
            { op: 'add', text: 'User wants Orin to use OmniRoute as its brain', kind: 'project', about_project: true },
            { op: 'update', ref: refOf(prompt, 'The Orin backend is hosted on Alwaysdata'), text: 'The Orin backend is hosted on Render' },
            { op: 'add', text: 'User sandbox token is sbx_Rpz27Kku9RqRLjOExf9nM3wzQcPzeTs5A03isNXFrpE', kind: 'fact' },
            { op: 'delete', ref: refOf(prompt, 'User drinks tea every morning') },
          ],
          episode: { title: 'Moving Orin to Render', summary: 'Moved the backend to Render and chose OmniRoute.' },
        }),
    ]);
    const r = await learnFromTurn({
      store: st,
      provider,
      model: 'fast',
      owner,
      conversationId: CHAT(2),
      project: 'Orin',
      mode: 'chat',
      messages: [{ role: 'user', content: 'We moved Orin to Render now, not Alwaysdata. And I no longer drink tea. Use OmniRoute as the brain.' }],
      reply: 'Got it.',
    });
    const learnPrompt = JSON.stringify(provider.requests[0]!.messages);
    expect(learnPrompt).toMatch(/\[m\d\] The Orin backend is hosted on Alwaysdata/);
    expect(learnPrompt).toMatch(/\[m\d\] User drinks tea every morning/);
    expect(r.added.map((m) => m.text)).toEqual(['User wants Orin to use OmniRoute as its brain']);
    expect(r.added[0]!.project).toBe('Orin');
    expect(r.added[0]!.source).toBe('auto');
    expect(st.getMemory(owner, old.id)?.text).toBe('The Orin backend is hosted on Render');
    // the token was refused
    expect(st.listMemories(owner).some((m) => m.text.includes('sbx_'))).toBe(false);
    // the user said it changed ("no longer"), so the delete counted
    expect(st.getMemory(owner, tea.id)).toBeNull();
    expect(r.episode?.title).toBe('Moving Orin to Render');
    expect(st.getEpisode(owner, CHAT(2))?.project).toBe('Orin');
    // a turn without such words cannot delete anything
    const keep = st.addMemory(owner, 'User has a cat named Pixel', '', { kind: 'person' });
    const p2 = scripted([(prompt) => JSON.stringify({ ops: [{ op: 'delete', ref: refOf(prompt, 'User has a cat named Pixel') }] })]);
    const r2 = await learnFromTurn({ store: st, provider: p2, model: 'fast', owner, conversationId: CHAT(2), mode: 'chat', messages: [{ role: 'user', content: 'Pixel the cat says hi' }], reply: 'Hi Pixel!' });
    expect(r2.deleted).toEqual([]);
    expect(st.getMemory(owner, keep.id)).not.toBeNull();
    st.close();
  });

  it('does nothing when learning is off', async () => {
    const st = new AgentStore(':memory:');
    setMemorySettings(st, 'o', { learn: false });
    const provider = scripted([]);
    const r = await learnFromTurn({ store: st, provider, model: 'f', owner: 'o', mode: 'chat', messages: [{ role: 'user', content: 'remember I like teal' }], reply: 'ok' });
    expect(r.skipped).toBe('off');
    expect(provider.requests).toHaveLength(0);
    st.close();
  });
});

describe('memory end to end over HTTP', () => {
  const apps: { agent: { store: AgentStore } }[] = [];
  afterEach(() => {
    for (const a of apps.splice(0)) a.agent.store.close();
  });
  const learned = (facts: { text: string; kind?: string }[], title = 'Favourite things', summary = 'User shared their favourite colour and their project.') =>
    answer(JSON.stringify({ ops: facts.map((f) => ({ op: 'add', kind: 'fact', ...f })), episode: { title, summary } }));

  it('learns from one chat, recalls it in a new chat and on a call, and keeps it per account and character', async () => {
    const chatSystems: string[] = [];
    const fetchImpl = mockFetch((_url, init) => {
      if (isLearning(init)) return learned([{ text: "User's favourite colour is teal", kind: 'preference' }, { text: 'User is building an app called Orin', kind: 'project' }]);
      chatSystems.push(systemOf(init));
      return answer('Noted!');
    });
    const t = makeTestApp({ POLLINATIONS_ENABLED: 'true', POLLINATIONS_TOKEN: 'tok', AGENT_ENABLED: 'true' }, { fetchImpl });
    apps.push(t);
    const a = guest(1);
    await request(t.app).post('/v1/chat').set(a).send({ conversationId: CHAT(1), messages: [{ role: 'user', content: "Remember my favourite colour is teal, and I'm building Orin." }] }).expect(200);
    await memoryIdle();
    const page = await request(t.app).get('/v1/agent/memories').set(a).expect(200);
    expect(page.body.memories.map((m: { text: string }) => m.text).sort()).toEqual(['User is building an app called Orin', "User's favourite colour is teal"]);
    expect(page.body.episodes[0]).toMatchObject({ conversationId: CHAT(1), title: 'Favourite things' });
    expect(page.body.settings).toEqual({ enabled: true, learn: true });

    // a brand new chat: the fact and the earlier conversation come along
    await request(t.app).post('/v1/chat').set(a).send({ conversationId: CHAT(2), messages: [{ role: 'user', content: 'what colour should the button be?' }] }).expect(200);
    const sys = chatSystems.at(-1)!;
    expect(sys).toContain("User's favourite colour is teal");
    expect(sys).toContain('Earlier conversations with the user');
    expect(sys).toContain('Favourite things');
    // on a call too
    await request(t.app).post('/v1/chat').set(a).send({ mode: 'voice', conversationId: CHAT(3), messages: [{ role: 'user', content: 'hey, what do you remember about me?' }] }).expect(200);
    expect(chatSystems.at(-1)).toContain("User's favourite colour is teal");

    // another account and another character see none of it
    expect((await request(t.app).get('/v1/agent/memories').set(guest(2))).body.memories).toEqual([]);
    expect((await request(t.app).get('/v1/agent/memories').set(a).set('X-Orin-Agent', 'nova')).body.memories).toEqual([]);
    await request(t.app).post('/v1/chat').set(guest(2)).send({ conversationId: CHAT(4), messages: [{ role: 'user', content: 'what colour do I like?' }] }).expect(200);
    expect(chatSystems.at(-1)).not.toContain('teal');
    expect(chatSystems.at(-1)).not.toContain('Favourite things');
    await request(t.app).post('/v1/chat').set(a).send({ character: 'nova', conversationId: CHAT(5), messages: [{ role: 'user', content: 'what colour do I like?' }] }).expect(200);
    expect(chatSystems.at(-1)).not.toContain('teal');
    await memoryIdle();
  });

  it('temporary chats neither learn nor recall', async () => {
    let learningCalls = 0;
    const systems: string[] = [];
    const fetchImpl = mockFetch((_url, init) => {
      if (isLearning(init)) {
        learningCalls++;
        return learned([{ text: 'User has a dog named Rex' }]);
      }
      systems.push(systemOf(init));
      return answer('ok');
    });
    const t = makeTestApp({ POLLINATIONS_ENABLED: 'true', POLLINATIONS_TOKEN: 'tok', AGENT_ENABLED: 'true' }, { fetchImpl });
    apps.push(t);
    const a = guest(3);
    await request(t.app).post('/v1/agent/memories').set(a).send({ text: 'User lives in Dhaka', kind: 'profile' }).expect(201);
    await request(t.app).post('/v1/chat').set(a).send({ incognito: true, conversationId: CHAT(6), messages: [{ role: 'user', content: 'Remember I have a dog named Rex. Where do I live?' }] }).expect(200);
    await memoryIdle();
    expect(learningCalls).toBe(0);
    expect(systems.at(-1)).not.toContain('Dhaka');
    expect((await request(t.app).get('/v1/agent/memories').set(a)).body.memories.map((m: { text: string }) => m.text)).toEqual(['User lives in Dhaka']);
  });

  it('turned off: nothing recalled, no memory tools, nothing learned; back on brings it back', async () => {
    let learningCalls = 0;
    const systems: string[] = [];
    const tools: string[][] = [];
    const fetchImpl = mockFetch((_url, init) => {
      if (isLearning(init)) {
        learningCalls++;
        return learned([]);
      }
      systems.push(systemOf(init));
      tools.push((bodyOf(init).tools ?? []).map((x) => x.function?.name ?? ''));
      return answer('ok');
    });
    const t = makeTestApp({ POLLINATIONS_ENABLED: 'true', POLLINATIONS_TOKEN: 'tok', AGENT_ENABLED: 'true' }, { fetchImpl });
    apps.push(t);
    const a = guest(4);
    await request(t.app).post('/v1/agent/memories').set(a).send({ text: 'User lives in Dhaka' }).expect(201);
    const off = await request(t.app).patch('/v1/agent/memory/settings').set(a).send({ enabled: false }).expect(200);
    expect(off.body.settings).toEqual({ enabled: false, learn: true });
    await request(t.app).post('/v1/chat').set(a).send({ conversationId: CHAT(7), messages: [{ role: 'user', content: 'Remember that I moved. Where do I live?' }] }).expect(200);
    await memoryIdle();
    expect(learningCalls).toBe(0);
    expect(systems.at(-1)).not.toContain('Dhaka');
    expect(systems.at(-1)).toContain('turned memory off');
    expect(tools.at(-1)).not.toContain('remember');
    expect(tools.at(-1)).not.toContain('recall');
    await request(t.app).put('/v1/agent/memory/settings').set(a).send({ enabled: true }).expect(200);
    await request(t.app).post('/v1/chat').set(a).send({ conversationId: CHAT(7), messages: [{ role: 'user', content: 'Where do I live?' }] }).expect(200);
    expect(systems.at(-1)).toContain('User lives in Dhaka');
    await memoryIdle();
  });

  it('the Memory page corrects, searches and deletes, and refuses secrets', async () => {
    const t = makeTestApp({ AGENT_ENABLED: 'true' }, { fetchImpl: mockFetch(() => answer('ok')) });
    apps.push(t);
    const a = guest(5);
    const m = (await request(t.app).post('/v1/agent/memories').set(a).send({ text: 'User works at Acme', kind: 'profile' }).expect(201)).body.memory;
    await request(t.app).post('/v1/agent/memories').set(a).send({ text: 'Orin uses Expo', kind: 'project', project: 'Orin' }).expect(201);
    const fixed = await request(t.app).patch(`/v1/agent/memories/${m.id}`).set(a).send({ text: 'User works at Globex' }).expect(200);
    expect(fixed.body.memory).toMatchObject({ text: 'User works at Globex', kind: 'profile', source: 'user' });
    await request(t.app).patch(`/v1/agent/memories/${m.id}`).set(guest(6)).send({ text: 'hijack this one' }).expect(404);
    const found = await request(t.app).get('/v1/agent/memories?q=expo').set(a).expect(200);
    expect(found.body.memories.map((x: { text: string }) => x.text)).toEqual(['Orin uses Expo']);
    const bad = await request(t.app).post('/v1/agent/memories').set(a).send({ text: 'my github token is ghp_abcdefghijklmnopqrstuvwxyz0123' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/Secure Vault/);
    await request(t.app).delete(`/v1/agent/memories/${m.id}`).set(a).expect(200);
    expect((await request(t.app).get('/v1/agent/memories').set(a)).body.memories.map((x: { text: string }) => x.text)).toEqual(['Orin uses Expo']);
    expect((await request(t.app).put('/v1/agent/memory/settings').set(a).send({ learn: false })).body.settings).toEqual({ enabled: true, learn: false });
    expect((await request(t.app).get('/v1/agent/memory/conversations').set(a)).body.episodes).toEqual([]);
  });
});
