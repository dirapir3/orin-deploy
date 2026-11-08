#!/usr/bin/env python3
"""Orin's email client, run on her cloud computer (stdlib only: imaplib, smtplib, email).

The server sends one action per run and reads one JSON line back:
  ORIN_MAIL_ACT   {"action": "check"|"search"|"read"|"attachment"|"draft"|"send", ...}
  ORIN_MAIL_CFG   {"imap_host", "imap_port", "imap_tls", "smtp_host", "smtp_port", "smtp_tls", "gmail"}
  ORIN_MAIL_USER / ORIN_MAIL_PASS   the Secure Vault login (an app password); never printed.
Messages are read with BODY.PEEK, so reading never marks them as read.
"""
import email
import email.header
import mimetypes
import email.policy
import email.utils
import html
import imaplib
import json
import os
import re
import smtplib
import ssl
import sys
import time
from email.message import EmailMessage

ACT = json.loads(os.environ.get('ORIN_MAIL_ACT') or '{}')
CFG = json.loads(os.environ.get('ORIN_MAIL_CFG') or '{}')
USER = os.environ.get('ORIN_MAIL_USER', '')
PASS = os.environ.get('ORIN_MAIL_PASS', '')
ATTACH_DIR = os.path.join(os.path.expanduser('~'), 'work', 'email-attachments')
LOCAL = ('localhost', '127.0.0.1', '::1')


def out(obj):
    s = json.dumps(obj, ensure_ascii=False)
    if PASS:
        s = s.replace(PASS, '[hidden]')
    print(s)


def tls_ok(host, mode):
    if mode == 'none' and host not in LOCAL:
        raise ValueError('Unencrypted mail connections are only allowed to this computer itself.')


def imap():
    host, port, mode = CFG['imap_host'], int(CFG.get('imap_port') or 993), CFG.get('imap_tls') or 'ssl'
    tls_ok(host, mode)
    if mode == 'ssl':
        M = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=40)
    else:
        M = imaplib.IMAP4(host, port, timeout=40)
        if mode == 'starttls':
            M.starttls(ssl_context=ssl.create_default_context())
    M.login(USER, PASS)
    return M


def q(s):
    """IMAP quoted string (ASCII)."""
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


LIST_RE = re.compile(r'\((?P<flags>[^)]*)\) (?P<delim>"[^"]*"|NIL) (?P<name>.+)$')


def folders(M):
    typ, data = M.list()
    res = []
    for raw in data or []:
        if not raw:
            continue
        line = raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else str(raw)
        m = LIST_RE.match(line)
        if not m:
            continue
        name = m.group('name').strip()
        if name.startswith('"') and name.endswith('"'):
            name = name[1:-1].replace('\\"', '"').replace('\\\\', '\\')
        res.append({'name': name, 'flags': m.group('flags')})
    return res


def special(M, flag, guesses):
    fl = folders(M)
    for f in fl:
        if flag.lower() in f['flags'].lower():
            return f['name']
    names = {f['name'].lower(): f['name'] for f in fl}
    for g in guesses:
        if g.lower() in names:
            return names[g.lower()]
    return None


def select(M, folder, readonly=True):
    typ, data = M.select(q(folder or 'INBOX'), readonly=readonly)
    if typ != 'OK':
        raise ValueError(f'No folder named "{folder}".')
    return int((data or [b'0'])[0] or 0)


def dec(v):
    if v is None:
        return ''
    try:
        return str(email.header.make_header(email.header.decode_header(str(v))))
    except Exception:
        return str(v)


def html_text(h):
    h = re.sub(r'(?is)<(script|style|head)[^>]*>.*?</\1>', ' ', h)
    h = re.sub(r'(?i)<br\s*/?>|</p>|</div>|</tr>|</li>|</h\d>', '\n', h)
    h = re.sub(r'(?i)<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', r'\2 (\1)', h)
    h = re.sub(r'<[^>]+>', ' ', h)
    h = html.unescape(h)
    h = re.sub(r'[ \t\r\f\v]+', ' ', h)
    return re.sub(r'\n\s*\n+', '\n\n', h).strip()


def body_text(msg):
    plain, rich = None, None
    for part in msg.walk() if msg.is_multipart() else [msg]:
        if part.is_multipart() or part.get_content_disposition() == 'attachment':
            continue
        ct = part.get_content_type()
        try:
            payload = part.get_content()
        except Exception:
            raw = part.get_payload(decode=True) or b''
            payload = raw.decode(part.get_content_charset() or 'utf-8', 'replace')
        if not isinstance(payload, str):
            continue
        if ct == 'text/plain' and plain is None:
            plain = payload
        elif ct == 'text/html' and rich is None:
            rich = payload
    if plain and plain.strip():
        return plain.strip()
    return html_text(rich) if rich else ''


def attachments(msg):
    res = []
    for part in msg.walk():
        fn = part.get_filename()
        if part.get_content_disposition() == 'attachment' or (fn and not part.is_multipart()):
            raw = part.get_payload(decode=True) or b''
            res.append({'index': len(res) + 1, 'filename': dec(fn) or f'attachment-{len(res) + 1}', 'type': part.get_content_type(), 'size': len(raw)})
    return res


def parse_fetch(data):
    """[(uid, flags, bytes)] from a UID FETCH response."""
    res = []
    for item in data or []:
        if isinstance(item, tuple) and len(item) >= 2:
            meta = item[0].decode('utf-8', 'replace')
            m = re.search(r'UID (\d+)', meta)
            fl = re.search(r'FLAGS \(([^)]*)\)', meta)
            res.append((int(m.group(1)) if m else 0, fl.group(1) if fl else '', item[1]))
    return res


def search_criteria(a):
    crit, lit = [], None
    gmail = CFG.get('gmail')
    query = (a.get('query') or '').strip()
    if query and gmail:
        if query.isascii():
            crit += ['X-GM-RAW', q(query)]
        else:
            crit += ['X-GM-RAW']
            lit = query.encode('utf-8')
    elif query:
        if query.isascii():
            crit += ['TEXT', q(query)]
        else:
            crit += ['TEXT']
            lit = query.encode('utf-8')
    for key, imapkey in (('from', 'FROM'), ('subject', 'SUBJECT'), ('to', 'TO')):
        v = (a.get(key) or '').strip()
        if v:
            crit += [imapkey, q(v.encode('ascii', 'ignore').decode() or v)]
    for key, imapkey in (('since', 'SINCE'), ('before', 'BEFORE')):
        v = (a.get(key) or '').strip()
        if v:
            t = time.strptime(v[:10], '%Y-%m-%d')
            crit += [imapkey, time.strftime('%d-%b-%Y', t)]
    if a.get('unread'):
        crit.append('UNSEEN')
    return crit or ['ALL'], lit


def do_check(a):
    M = imap()
    fl = folders(M)
    total = select(M, 'INBOX')
    typ, data = M.uid('SEARCH', None, 'UNSEEN')
    unseen = len((data[0] or b'').split()) if data else 0
    M.logout()
    return {'ok': True, 'account': USER, 'folders': [f['name'] for f in fl][:60], 'inbox_total': total, 'inbox_unread': unseen, 'gmail': bool(CFG.get('gmail'))}


def do_search(a):
    M = imap()
    folder = a.get('folder') or 'INBOX'
    select(M, folder)
    crit, lit = search_criteria(a)
    if lit is not None:
        M.literal = lit
        typ, data = M.uid('SEARCH', 'CHARSET', 'UTF-8', *crit)
    else:
        typ, data = M.uid('SEARCH', None, *crit)
    if typ != 'OK':
        raise ValueError(f'Search failed: {data}')
    uids = [int(x) for x in (data[0] or b'').split()]
    total = len(uids)
    limit = max(1, min(int(a.get('limit') or 10), 30))
    uids = sorted(uids)[-limit:][::-1]
    rows = []
    if uids:
        typ, data = M.uid('FETCH', ','.join(map(str, uids)), '(UID FLAGS RFC822.SIZE BODY.PEEK[]<0.24000>)')
        for uid, flags, raw in parse_fetch(data):
            msg = email.message_from_bytes(raw, policy=email.policy.default)
            try:
                text = body_text(msg)
            except Exception:
                text = ''
            rows.append({'uid': uid, 'from': dec(msg.get('From')), 'to': dec(msg.get('To')), 'subject': dec(msg.get('Subject')), 'date': dec(msg.get('Date')),
                         'unread': '\\Seen' not in flags, 'snippet': re.sub(r'\s+', ' ', text)[:240]})
        rows.sort(key=lambda r: -r['uid'])
    M.logout()
    return {'ok': True, 'folder': folder, 'total': total, 'messages': rows}


def fetch_one(M, uid):
    typ, data = M.uid('FETCH', str(int(uid)), '(UID FLAGS BODY.PEEK[])')
    got = parse_fetch(data)
    if not got:
        raise ValueError(f'No email with id {uid} in that folder.')
    return email.message_from_bytes(got[0][2], policy=email.policy.default), got[0][1]


def do_read(a):
    M = imap()
    folder = a.get('folder') or 'INBOX'
    select(M, folder)
    msg, flags = fetch_one(M, a['uid'])
    M.logout()
    text = body_text(msg)
    return {'ok': True, 'uid': int(a['uid']), 'folder': folder, 'from': dec(msg.get('From')), 'to': dec(msg.get('To')), 'cc': dec(msg.get('Cc')),
            'subject': dec(msg.get('Subject')), 'date': dec(msg.get('Date')), 'message_id': msg.get('Message-ID', ''), 'unread': '\\Seen' not in flags,
            'text': text[:20000], 'text_cut': max(0, len(text) - 20000), 'attachments': attachments(msg)}


def do_attachment(a):
    M = imap()
    select(M, a.get('folder') or 'INBOX')
    msg, _ = fetch_one(M, a['uid'])
    M.logout()
    want = int(a.get('index') or 1)
    n = 0
    for part in msg.walk():
        fn = part.get_filename()
        if part.get_content_disposition() == 'attachment' or (fn and not part.is_multipart()):
            n += 1
            if n != want:
                continue
            raw = part.get_payload(decode=True) or b''
            name = re.sub(r'[^\w.\- ]+', '_', dec(fn) or f'attachment-{n}').strip() or f'attachment-{n}'
            os.makedirs(ATTACH_DIR, exist_ok=True)
            path = os.path.join(ATTACH_DIR, f"{int(a['uid'])}-{name}")
            with open(path, 'wb') as f:
                f.write(raw)
            return {'ok': True, 'path': path, 'filename': name, 'size': len(raw), 'type': part.get_content_type()}
    raise ValueError(f'That email has no attachment number {want}.')


def build(a, M=None):
    msg = EmailMessage()
    msg['From'] = email.utils.formataddr((a.get('from_name') or '', USER)) if a.get('from_name') else USER
    msg['To'] = ', '.join(a.get('to') or [])
    if a.get('cc'):
        msg['Cc'] = ', '.join(a['cc'])
    subject = a.get('subject') or ''
    if a.get('reply_to_uid') and M is not None:
        select(M, a.get('folder') or 'INBOX')
        orig, _ = fetch_one(M, a['reply_to_uid'])
        mid = orig.get('Message-ID', '')
        if mid:
            msg['In-Reply-To'] = mid
            msg['References'] = ((orig.get('References', '') + ' ') if orig.get('References') else '') + mid
        if not subject:
            os_ = dec(orig.get('Subject'))
            subject = os_ if os_.lower().startswith('re:') else f'Re: {os_}'
    msg['Subject'] = subject
    msg['Date'] = email.utils.formatdate(localtime=True)
    msg['Message-ID'] = email.utils.make_msgid(domain=(USER.split('@')[-1] if '@' in USER else None))
    msg.set_content(a.get('body') or '')
    for path in a.get('attach') or []:
        with open(path, 'rb') as f:
            data = f.read()
        ctype = (mimetypes.guess_type(path)[0] or 'application/octet-stream').split('/', 1)
        msg.add_attachment(data, maintype=ctype[0], subtype=ctype[1], filename=os.path.basename(path))
    return msg


def append(M, folder, msg, flags):
    typ, data = M.append(q(folder), flags, imaplib.Time2Internaldate(time.time()), msg.as_bytes())
    if typ != 'OK':
        raise ValueError(f'The mail server did not save it in {folder}: {data}')


def do_draft(a):
    M = imap()
    msg = build(a, M)
    drafts = special(M, '\\Drafts', ['Drafts', '[Gmail]/Drafts', 'INBOX.Drafts', 'Draft'])
    if not drafts:
        drafts = 'Drafts'
        M.create(q(drafts))
    append(M, drafts, msg, '(\\Draft \\Seen)')
    M.logout()
    return {'ok': True, 'folder': drafts, 'subject': msg['Subject'], 'to': msg['To']}


def do_send(a):
    M = imap() if (a.get('reply_to_uid') or not CFG.get('gmail')) else None
    msg = build(a, M)
    host, port, mode = CFG['smtp_host'], int(CFG.get('smtp_port') or 465), CFG.get('smtp_tls') or 'ssl'
    tls_ok(host, mode)
    if mode == 'ssl':
        S = smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=40)
    else:
        S = smtplib.SMTP(host, port, timeout=40)
        if mode == 'starttls':
            S.starttls(context=ssl.create_default_context())
    if mode != 'none' or USER:
        try:
            S.login(USER, PASS)
        except smtplib.SMTPNotSupportedError:
            if mode != 'none':
                raise
    refused = S.send_message(msg)
    S.quit()
    saved = None
    if M is not None and not CFG.get('gmail'):
        # most servers do not keep a copy of mail sent over SMTP; Gmail does it itself
        try:
            sent = special(M, '\\Sent', ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent'])
            if sent:
                append(M, sent, msg, '(\\Seen)')
                saved = sent
        except Exception:
            pass
    if M is not None:
        try:
            M.logout()
        except Exception:
            pass
    return {'ok': True, 'to': msg['To'], 'cc': msg['Cc'] or '', 'subject': msg['Subject'], 'message_id': msg['Message-ID'], 'refused': list((refused or {}).keys()), 'saved_in': saved}


def main():
    kind = ACT.get('action')
    fn = {'check': do_check, 'search': do_search, 'read': do_read, 'attachment': do_attachment, 'draft': do_draft, 'send': do_send}.get(kind)
    if not fn:
        return out({'ok': False, 'error': f'Unknown action {kind}'})
    if not USER or not PASS:
        return out({'ok': False, 'error': 'The login has no username or password.'})
    try:
        out(fn(ACT))
    except imaplib.IMAP4.error as e:
        msg = str(e)
        auth = bool(re.search(r'auth|login|credential|password|invalid', msg, re.I))
        out({'ok': False, 'auth': auth, 'error': f'The mail server said: {msg[:300]}'})
    except smtplib.SMTPAuthenticationError as e:
        out({'ok': False, 'auth': True, 'error': f'The mail server refused the login for sending: {str(e)[:300]}'})
    except Exception as e:
        out({'ok': False, 'error': f'{type(e).__name__}: {str(e)[:300]}'})


if __name__ == '__main__':
    main()
