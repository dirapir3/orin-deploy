#!/usr/bin/env python3
"""Orin's real browser on her computer (E2B sandbox).

One Chromium (Playwright, persistent profile) runs on the virtual screen :99, so the user can watch
and use it through the live view (noVNC on port 6080). A small daemon on 127.0.0.1:9333 keeps it
open between tool calls. The server calls this file as a client:

    ORIN_ACT='{"action":"open","url":"https://example.com"}' python3 orin_browser.py

Actions: open, click, type, select, press, scroll, back, forward, reload, wait, read, screenshot,
tabs, tab, live, stop. Every reply is JSON with the page (url, title, text, numbered elements).
A click or Enter that would send, buy, book, post or delete something is refused unless
"confirm": true (the server asks the user first). Secret text for "type" comes from an
environment variable named in "text_env" and is never echoed back.
"""
import json, os, re, secrets, socket, subprocess, sys, time, urllib.request

PORT = 9333
DISPLAY = ':99'
HOME = os.path.expanduser('~')
STATE = os.path.join(HOME, '.orin')
PROFILE = os.path.join(STATE, 'browser-profile')
LIVE_FILE = os.path.join(STATE, 'live.json')
# E2B's proxy can reach even 127.0.0.1 ports from outside, so the daemon only obeys callers that hold this token.
TOKEN_FILE = os.path.join(STATE, 'browser.token')


def _token():
    if not os.path.exists(TOKEN_FILE):
        import secrets
        os.makedirs(STATE, exist_ok=True)
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, secrets.token_hex(24).encode())
        os.close(fd)
    return open(TOKEN_FILE).read().strip()
SHOTS = os.path.join(HOME, 'work', 'screenshots')

SEND_RE = re.compile(
    r'\b(send|submit|post|publish|tweet|reply|comment|share|buy|purchase|order|checkout|check out|pay|place|book|reserve|'
    r'subscribe|sign ?up|register|create account|delete|remove|cancel (?:my )?(?:order|subscription|account)|transfer|'
    r'donate|confirm|apply|upload|invite|accept|unsubscribe|deactivate|close account|save changes)\b',
    re.I,
)


# ---------------------------------------------------------------- display + live view

def _up(port):
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _spawn(cmd, log):
    subprocess.Popen(cmd, shell=True, stdout=open(os.path.join(STATE, log), 'ab'), stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, start_new_session=True, env={**os.environ, 'DISPLAY': DISPLAY})


def ensure_display():
    os.makedirs(STATE, exist_ok=True)
    if not os.path.exists('/tmp/.X11-unix/X99'):
        _spawn('Xvfb :99 -screen 0 1280x800x24 -nolisten tcp', 'xvfb.log')
        for _ in range(50):
            if os.path.exists('/tmp/.X11-unix/X99'):
                break
            time.sleep(0.1)
        _spawn('fluxbox', 'fluxbox.log')
    if not os.path.exists(LIVE_FILE):
        json.dump({'password': secrets.token_urlsafe(6)[:8]}, open(LIVE_FILE, 'w'))
        os.chmod(LIVE_FILE, 0o600)
    pw = json.load(open(LIVE_FILE))['password']
    if not _up(5900):
        pwfile = os.path.join(STATE, 'vnc.pass')
        subprocess.run(['x11vnc', '-storepasswd', pw, pwfile], capture_output=True)
        _spawn(f'x11vnc -display {DISPLAY} -rfbauth {pwfile} -forever -shared -rfbport 5900 -localhost -quiet', 'x11vnc.log')
    if not _up(6080):
        web = '/usr/share/novnc'
        _spawn(f'websockify --web {web} 6080 127.0.0.1:5900', 'novnc.log')
    for _ in range(50):
        if _up(5900) and _up(6080):
            break
        time.sleep(0.1)
    return pw


# ---------------------------------------------------------------- daemon

SNAP_JS = r"""
(maxN) => {
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable="true"],summary,[onclick]';
  document.querySelectorAll('[data-orin-ref]').forEach(e => e.removeAttribute('data-orin-ref'));
  const out = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none' || el.disabled) continue;
    n++; el.setAttribute('data-orin-ref', String(n));
    const tag = el.tagName.toLowerCase(); const type = (el.getAttribute('type') || '').toLowerCase();
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    let name = el.getAttribute('aria-label') || (isField ? '' : el.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('alt') || (tag === 'input' && ['submit','button'].includes(type) ? el.value : '') || '';
    if (!name && el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) name = l.innerText; }
    name = name.trim().replace(/\s+/g, ' ').slice(0, 80);
    const item = { ref: n, tag, name };
    if (type) item.type = type;
    if (tag === 'a') item.href = (el.getAttribute('href') || '').slice(0, 120);
    if (isField && type !== 'password' && tag !== 'select') item.value = (el.value || '').slice(0, 60);
    if (tag === 'select') item.value = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text.slice(0, 40) : '';
    if (type === 'password') item.filled = !!el.value;
    if (el.closest('form')) item.form = true;
    if (r.bottom < 0 || r.top > innerHeight) item.offscreen = true;
    out.push(item);
    if (n >= maxN) break;
  }
  return out;
}
"""


def serve():
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from playwright.sync_api import sync_playwright

    ensure_display()
    os.environ['DISPLAY'] = DISPLAY
    pw = sync_playwright().start()
    ctx = pw.chromium.launch_persistent_context(
        PROFILE, headless=False, no_viewport=True, accept_downloads=True,
        args=['--no-sandbox', '--start-maximized', '--window-position=0,0', '--window-size=1280,800', '--disable-dev-shm-usage', '--no-first-run'],
    )
    state = {'page': ctx.pages[0] if ctx.pages else ctx.new_page(), 'last': time.time()}
    ctx.on('page', lambda p: state.update(page=p))

    def page():
        p = state['page']
        if p.is_closed():
            p = ctx.pages[-1] if ctx.pages else ctx.new_page()
            state['page'] = p
        return p

    def settle(p, ms=8000):
        try:
            p.wait_for_load_state('domcontentloaded', timeout=ms)
            p.wait_for_load_state('networkidle', timeout=2500)
        except Exception:
            pass

    def snapshot(p, offset=0, limit=6000, note=None):
        settle(p, 4000)
        try:
            els = p.evaluate(SNAP_JS, 150)
        except Exception:
            els = []
        try:
            text = p.evaluate('() => document.body ? document.body.innerText : ""') or ''
        except Exception:
            text = ''
        text = re.sub(r'\n{3,}', '\n\n', text)
        out = {'ok': True, 'url': p.url, 'title': p.title() if not p.is_closed() else '', 'text': text[offset:offset + limit],
               'text_total': len(text), 'elements': els, 'tabs': len(ctx.pages)}
        if offset + limit < len(text):
            out['more'] = f'{len(text) - offset - limit} more characters: read with offset {offset + limit}'
        if note:
            out['note'] = note
        return out

    def locate(p, a):
        if a.get('ref') is not None:
            loc = p.locator(f'[data-orin-ref="{int(a["ref"])}"]')
            if loc.count() == 0:
                p.evaluate(SNAP_JS, 150)
                loc = p.locator(f'[data-orin-ref="{int(a["ref"])}"]')
            if loc.count() == 0:
                raise ValueError(f'No element {a["ref"]} on the page now. Read the page again for fresh numbers.')
            return loc.first
        if a.get('text'):
            loc = p.get_by_text(a['text'], exact=False)
            if loc.count() == 0:
                loc = p.get_by_role('button', name=a['text'])
            if loc.count() == 0:
                raise ValueError(f'Nothing with the text "{a["text"]}" on the page.')
            return loc.first
        raise ValueError('Give ref (the element number) or text.')

    def describe(loc):
        return loc.evaluate("""el => {
          const t = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').trim().replace(/\\s+/g,' ').slice(0,80);
          const type = (el.getAttribute('type') || '').toLowerCase(); const tag = el.tagName.toLowerCase();
          const form = el.closest('form');
          return { label: t, submit: (tag === 'button' && (type === 'submit' || (!type && !!form))) || (tag === 'input' && type === 'submit'), form: !!form,
                   method: form ? (form.getAttribute('method') || 'get').toLowerCase() : '' };
        }""")

    def risky(info):
        if SEND_RE.search(info.get('label') or ''):
            return True
        return bool(info.get('submit')) and info.get('method') == 'post'

    def act(a):
        p = page()
        kind = a.get('action')
        if kind == 'open':
            url = a.get('url') or ''
            if not re.match(r'^https?://', url):
                url = 'https://' + url
            try:
                p.goto(url, wait_until='domcontentloaded', timeout=30000)
            except Exception as e:
                return {'ok': False, 'error': f'Could not open {url}: {str(e)[:200]}'}
            return snapshot(p)
        if kind == 'click':
            loc = locate(p, a)
            info = describe(loc)
            if risky(info) and not a.get('confirm'):
                return {'ok': False, 'held': True, 'control': info.get('label') or 'this button',
                        'error': f'"{info.get("label") or "This button"}" looks like it sends, buys, books, posts or deletes something. Call again with confirm true; the user is asked first.'}
            loc.scroll_into_view_if_needed(timeout=5000)
            loc.click(timeout=10000)
            time.sleep(0.8)
            return snapshot(page())
        if kind == 'type':
            loc = locate(p, a)
            text = a.get('text', '')
            if a.get('text_env'):
                host = (re.sub(r'^https?://', '', p.url).split('/')[0].split(':')[0] or '').lower().removeprefix('www.')
                dom = (a.get('domain') or '').lower().removeprefix('*.').removeprefix('www.')
                if dom and not (host == dom or host.endswith('.' + dom)):
                    return {'ok': False, 'error': f'That login is saved for {dom}, but this page is {host}. For safety it was not typed here.'}
                text = os.environ.get(a['text_env'], '')
                if not text:
                    return {'ok': False, 'error': 'The secret value was empty.'}
            if a.get('clear', True):
                loc.fill(text, timeout=10000)
            else:
                loc.press_sequentially(text, timeout=20000)
            if a.get('enter'):
                info = describe(loc)
                if info.get('form') and not a.get('confirm') and (info.get('method') == 'post' or SEND_RE.search(a.get('purpose') or '')):
                    return {**snapshot(p, note='Typed. Pressing Enter would submit this form: call press Enter with confirm true.'), 'held': True}
                loc.press('Enter')
                time.sleep(0.8)
            return snapshot(page(), note='Typed into the field' + (' (secret, hidden)' if a.get('text_env') else ''))
        if kind == 'select':
            loc = locate(p, a)
            loc.select_option(label=a.get('value')) if a.get('value') else None
            return snapshot(p)
        if kind == 'press':
            key = a.get('key') or 'Enter'
            if key.lower() == 'enter' and not a.get('confirm'):
                inform = p.evaluate("() => { const e = document.activeElement; const f = e && e.closest ? e.closest('form') : null; return f ? (f.getAttribute('method') || 'get').toLowerCase() : ''; }")
                if inform == 'post':
                    return {'ok': False, 'held': True, 'control': 'Enter (submits the form)', 'error': 'Enter would submit this form. Call again with confirm true; the user is asked first.'}
            p.keyboard.press(key)
            time.sleep(0.6)
            return snapshot(page())
        if kind == 'scroll':
            dy = {'up': -700, 'down': 700, 'top': -10**6, 'bottom': 10**6}.get(a.get('direction', 'down'), 700)
            p.mouse.wheel(0, dy)
            time.sleep(0.4)
            return snapshot(p)
        if kind in ('back', 'forward', 'reload'):
            getattr(p, {'back': 'go_back', 'forward': 'go_forward', 'reload': 'reload'}[kind])(timeout=20000)
            return snapshot(p)
        if kind == 'wait':
            time.sleep(min(float(a.get('seconds', 2)), 20))
            return snapshot(page())
        if kind == 'read':
            return snapshot(p, int(a.get('offset', 0)), int(a.get('limit', 6000)))
        if kind == 'screenshot':
            os.makedirs(SHOTS, exist_ok=True)
            path = os.path.join(SHOTS, f'shot-{time.strftime("%Y%m%d-%H%M%S")}.png')
            p.screenshot(path=path, full_page=bool(a.get('full_page')))
            return {**snapshot(p, limit=1500), 'screenshot': path}
        if kind == 'tabs':
            return {'ok': True, 'tabs': [{'n': i + 1, 'url': t.url, 'title': t.title()} for i, t in enumerate(ctx.pages)]}
        if kind == 'tab':
            i = int(a.get('n', 1)) - 1
            if not 0 <= i < len(ctx.pages):
                return {'ok': False, 'error': 'No such tab.'}
            state['page'] = ctx.pages[i]
            ctx.pages[i].bring_to_front()
            return snapshot(ctx.pages[i])
        return {'ok': False, 'error': f'Unknown action {kind}'}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(403)
            self.end_headers()

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('content-length') or 0))
            if self.headers.get('x-orin-token') != TOKEN:
                self.send_response(403)
                self.end_headers()
                return
            try:
                a = json.loads(body or b'{}')
                if a.get('action') == 'stop':
                    res = {'ok': True, 'stopped': True}
                else:
                    res = act(a)
            except Exception as e:
                res = {'ok': False, 'error': str(e)[:400]}
            data = json.dumps(res).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            if a.get('action') == 'stop':
                ctx.close()
                pw.stop()
                os._exit(0)

    TOKEN = _token()
    HTTPServer(('127.0.0.1', PORT), H).serve_forever()


# ---------------------------------------------------------------- client

def client():
    a = json.loads(os.environ.get('ORIN_ACT') or '{}')
    if a.get('action') == 'live':
        pw = ensure_display()
        print(json.dumps({'ok': True, 'password': pw, 'port': 6080, 'browser': _up(PORT)}))
        return
    if not _up(PORT):
        if a.get('action') == 'stop':
            print(json.dumps({'ok': True, 'stopped': True}))
            return
        ensure_display()
        _spawn(f'{sys.executable} {os.path.abspath(__file__)} --serve', 'browser.log')
        for _ in range(150):
            if _up(PORT):
                break
            time.sleep(0.2)
        else:
            print(json.dumps({'ok': False, 'error': 'The browser did not start. Log: ' + open(os.path.join(STATE, 'browser.log')).read()[-600:]}))
            return
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}/', data=json.dumps(a).encode(), headers={'content-type': 'application/json', 'x-orin-token': _token()})
    try:
        print(urllib.request.urlopen(req, timeout=110).read().decode())
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'Browser error: {e}'}))


if __name__ == '__main__':
    if '--serve' in sys.argv:
        serve()
    else:
        client()
