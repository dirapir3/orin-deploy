/**
 * Starting projects for scaffold_project. Each one is small, has a test that passes on the first
 * run, and needs as little as possible from the network so it also works on a phone sandbox.
 */
export type TemplateId = 'web-app' | 'react-vite' | 'node-api' | 'python-api' | 'expo-app';

export interface Template {
  about: string;
  /** files to write, relative to the project folder */
  files: (name: string, title: string) => Record<string, string>;
  /** optional shell command run first in the work folder (an official generator) */
  create?: (name: string) => string;
  /** run in the project after the files are written: install and test */
  setup?: string;
  /** what to do next, told to the model */
  next: string;
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

const GITIGNORE = 'node_modules\ndist\nbuild\ncoverage\n.env\n.env.*\n!.env.example\n.DS_Store\n__pycache__\n.venv\n.expo\n';

const webApp: Template = {
  about:
    'a no-build web app (index.html, styles.css, app.js for the page, and the app logic in src/logic.js as pure functions with node --test tests). No dependencies, fastest to build, preview and host on any static host',
  files: (name, title) => ({
    'package.json': JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test', start: 'npx --yes serve -l 3000 .' } }, null, 2) + '\n',
    '.gitignore': GITIGNORE,
    'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main class="app">
    <h1>${esc(title)}</h1>
    <p id="status" class="muted">Ready.</p>
  </main>
  <script type="module" src="app.js"></script>
</body>
</html>
`,
    'styles.css': `:root { --bg: #f6f8fb; --card: #fff; --ink: #0f172a; --muted: #64748b; --accent: #0ea5e9; --radius: 12px; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b1220; --card: #111a2e; --ink: #e2e8f0; --muted: #94a3b8; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--ink); }
.app { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 28px; margin: 0 0 16px; }
.muted { color: var(--muted); }
button { font: inherit; border: 0; border-radius: var(--radius); padding: 10px 16px; background: var(--accent); color: #fff; cursor: pointer; }
input { font: inherit; padding: 10px 12px; border-radius: var(--radius); border: 1px solid #cbd5e1; background: var(--card); color: var(--ink); }
`,
    'app.js': `// The page: reads and draws state. Keep the rules in src/logic.js so they can be tested.
import { greet } from './src/logic.js';

document.getElementById('status').textContent = greet('there');
`,
    'src/logic.js': `// Pure functions only: no DOM, no storage. Tested in test/logic.test.js.
export function greet(name) {
  return \`Hello, \${String(name).trim() || 'there'}!\`;
}
`,
    'test/logic.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/logic.js';

test('greet', () => {
  assert.equal(greet('Fa'), 'Hello, Fa!');
  assert.equal(greet('  '), 'Hello, there!');
});
`,
  }),
  setup: 'npm test 2>&1',
  next:
    'Put the app rules in src/logic.js (pure functions, exported) with tests in test/, and the page code in app.js (DOM + localStorage). Preview with preview_site on this folder, or host it with host_static_site / deploy_site.',
};

const reactVite: Template = {
  about: 'a React 18 + Vite + Vitest app with one component and a passing test. Builds to dist/ for static hosting',
  files: (name, title) => ({
    'package.json':
      JSON.stringify(
        {
          name,
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: { dev: 'vite --host 0.0.0.0', build: 'vite build', preview: 'vite preview --host 0.0.0.0', test: 'vitest run' },
          dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
          devDependencies: {
            '@vitejs/plugin-react': '^4.3.4',
            vite: '^5.4.11',
            vitest: '^2.1.8',
            jsdom: '^25.0.1',
            '@testing-library/react': '^16.1.0',
            '@testing-library/dom': '^10.4.0',
          },
        },
        null,
        2,
      ) + '\n',
    '.gitignore': GITIGNORE,
    'vite.config.js': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  test: { environment: 'jsdom', globals: true },
});
`,
    'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`,
    'src/main.jsx': `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
`,
    'src/App.jsx': `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="app">
      <h1>${esc(title)}</h1>
      <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
    </main>
  );
}
`,
    'src/App.test.jsx': `import { render, screen, fireEvent } from '@testing-library/react';
import App from './App.jsx';

test('counts clicks', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('button').textContent).toBe('Clicked 1 times');
});
`,
    'src/styles.css': `:root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
body { margin: 0; }
.app { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
button { font: inherit; border: 0; border-radius: 12px; padding: 10px 16px; background: #0ea5e9; color: #fff; cursor: pointer; }
`,
  }),
  setup: 'npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -5 && npx vitest run 2>&1 | tail -15',
  next: 'Build components in src/ with tests next to them (*.test.jsx). `npm run build` makes dist/ for preview_site or static hosting; `npm run dev` serves on port 5173.',
};

const nodeApi: Template = {
  about: 'a JSON API on Node 18+ with no dependencies (node:http, a tiny router, an in-memory store) and node --test tests that start the server on a free port',
  files: (name) => ({
    'package.json': JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', scripts: { start: 'node src/server.js', test: 'node --test' }, engines: { node: '>=18' } }, null, 2) + '\n',
    '.gitignore': GITIGNORE,
    'src/app.js': `// Routes. Each handler gets (req, params, body) and returns [status, data].
const items = new Map();
let nextId = 1;
export function reset() { items.clear(); nextId = 1; }

const routes = [
  ['GET', /^\\/health$/, () => [200, { ok: true }]],
  ['GET', /^\\/items$/, () => [200, [...items.values()]]],
  ['POST', /^\\/items$/, (_req, _p, body) => {
    if (!body || typeof body.name !== 'string' || !body.name.trim()) return [400, { error: 'name is required' }];
    const item = { id: nextId++, name: body.name.trim() };
    items.set(item.id, item);
    return [201, item];
  }],
  ['GET', /^\\/items\\/(\\d+)$/, (_req, [id]) => (items.has(+id) ? [200, items.get(+id)] : [404, { error: 'not found' }])],
  ['DELETE', /^\\/items\\/(\\d+)$/, (_req, [id]) => (items.delete(+id) ? [204, null] : [404, { error: 'not found' }])],
];

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let body = null;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    let raw = '';
    for await (const c of req) raw += c;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid JSON' }); }
  }
  for (const [method, re, fn] of routes) {
    const m = url.pathname.match(re);
    if (m && req.method === method) {
      try { const [status, data] = await fn(req, m.slice(1), body, url); return send(res, status, data); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
  }
  send(res, 404, { error: 'not found' });
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(data === null ? '' : JSON.stringify(data));
}
`,
    'src/server.js': `import http from 'node:http';
import { handle } from './app.js';

export function start(port = 0) {
  const server = http.createServer(handle);
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const port = Number(process.env.PORT) || 3000;
  start(port).then(() => console.log(\`listening on \${port}\`));
}
`,
    'test/app.test.js': `import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { reset } from '../src/app.js';

async function call(server, method, path, body) {
  const { port } = server.address();
  const r = await fetch(\`http://127.0.0.1:\${port}\${path}\`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

beforeEach(() => reset());

test('create, read and delete an item', async () => {
  const s = await start();
  try {
    const c = await call(s, 'POST', '/items', { name: ' first ' });
    assert.equal(c.status, 201);
    assert.equal(c.data.name, 'first');
    assert.equal((await call(s, 'GET', \`/items/\${c.data.id}\`)).status, 200);
    assert.equal((await call(s, 'DELETE', \`/items/\${c.data.id}\`)).status, 204);
    assert.equal((await call(s, 'GET', '/items')).data.length, 0);
  } finally { s.close(); }
});

test('validation', async () => {
  const s = await start();
  try { assert.equal((await call(s, 'POST', '/items', {})).status, 400); } finally { s.close(); }
});
`,
  }),
  setup: 'npm test 2>&1 | tail -12',
  next: 'Add routes in src/app.js and tests in test/. Run it with `PORT=3000 npm start` in the background (sandbox_job) and try it with curl; host it on Render as a web service.',
};

const pythonApi: Template = {
  about: 'a FastAPI app with pytest tests (python 3.10+), run with uvicorn',
  files: (name) => ({
    '.gitignore': GITIGNORE,
    'requirements.txt': 'fastapi>=0.110\nuvicorn[standard]>=0.29\nhttpx>=0.27\npytest>=8\n',
    'app/__init__.py': '',
    'app/main.py': `from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="${name}")
_items: dict[int, dict] = {}
_next = {"id": 1}


class ItemIn(BaseModel):
    name: str = Field(min_length=1)


def reset() -> None:
    _items.clear()
    _next["id"] = 1


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/items")
def list_items():
    return list(_items.values())


@app.post("/items", status_code=201)
def create_item(item: ItemIn):
    new = {"id": _next["id"], "name": item.name.strip()}
    _items[new["id"]] = new
    _next["id"] += 1
    return new


@app.get("/items/{item_id}")
def get_item(item_id: int):
    if item_id not in _items:
        raise HTTPException(404, "not found")
    return _items[item_id]
`,
    'tests/test_main.py': `from fastapi.testclient import TestClient
from app.main import app, reset

client = TestClient(app)


def setup_function():
    reset()


def test_create_and_get():
    r = client.post("/items", json={"name": " first "})
    assert r.status_code == 201
    assert r.json()["name"] == "first"
    assert client.get(f"/items/{r.json()['id']}").status_code == 200


def test_validation():
    assert client.post("/items", json={"name": ""}).status_code == 422
`,
  }),
  setup: 'python3 -m pip install -q -r requirements.txt 2>&1 | tail -3; python3 -m pytest -q 2>&1 | tail -8',
  next: 'Add routes in app/main.py and tests in tests/. Run with `uvicorn app.main:app --host 0.0.0.0 --port 8000` in the background (sandbox_job).',
};

const expoApp: Template = {
  about: 'an Expo (React Native) app in TypeScript from the official create-expo-app blank template: runs on Android, iOS and the web. Slow to install (a few minutes)',
  create: (name) => `npx --yes create-expo-app@latest ${name} --template blank-typescript --no-install 2>&1 | tail -20`,
  files: () => ({}),
  setup: 'npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -5 && npx --yes expo install react-dom react-native-web @expo/metro-runtime 2>&1 | tail -3 && npx tsc --noEmit 2>&1 | tail -10 && echo TYPECHECK_OK',
  next: 'Edit App.tsx and add screens in src/. `npx expo export --platform web` makes dist/ you can preview or host as a static site. Android builds need EAS (an Expo account) or a native build.',
};

export const TEMPLATES: Record<TemplateId, Template> = {
  'web-app': webApp,
  'react-vite': reactVite,
  'node-api': nodeApi,
  'python-api': pythonApi,
  'expo-app': expoApp,
};
