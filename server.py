#!/usr/bin/env python3
"""بدّل: small dependency-free student group exchange server (Python 3.10+)."""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

BASE = Path(__file__).resolve().parent
PUBLIC = BASE  # Static files were uploaded to the repository root
DATA = Path(os.environ.get('DATA_DIR', str(BASE / 'data')))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / 'baddel.sqlite3'
HOST = os.environ.get('HOST', '127.0.0.1')
PORT = int(os.environ.get('PORT', '8787'))
GROUPS = {'A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'}
SECTIONS = {'A', 'B'}
USER_RE = re.compile(r'^[a-zA-Z0-9_]{5,32}$')
REQUEST_ID_RE = re.compile(r'^/api/requests/([a-f0-9]{32})(/matches)?$')
RATE_LOCK = threading.Lock()
POSTS_PER_IP = defaultdict(deque)
MAX_AGE_DAYS = 30


def connect():
    db = sqlite3.connect(str(DB), timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA busy_timeout=10000')
    db.execute('PRAGMA foreign_keys=ON')
    return db


def init_db():
    db = connect()
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('''CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        current_section TEXT NOT NULL,
        current_group TEXT NOT NULL,
        target_section TEXT NOT NULL,
        target_group TEXT NOT NULL,
        telegram TEXT NOT NULL,
        owner_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    )''')
    db.execute('CREATE INDEX IF NOT EXISTS requests_expiry_idx ON requests(expires_at)')
    db.execute('CREATE INDEX IF NOT EXISTS requests_pair_idx ON requests(current_section, current_group, target_section, target_group)')
    db.execute('''CREATE UNIQUE INDEX IF NOT EXISTS requests_dedup_idx
        ON requests(telegram COLLATE NOCASE, current_section, current_group, target_section, target_group)''')
    db.commit()
    db.close()


def now_utc():
    return datetime.now(timezone.utc)


def request_view(row):
    return {key: row[key] for key in ('id', 'current_section', 'current_group', 'target_section', 'target_group', 'telegram', 'created_at', 'expires_at')}


def valid_pair(obj, *, required=True):
    values = [obj.get(k, '') for k in ('current_section', 'current_group', 'target_section', 'target_group')]
    if not required and not any(values):
        return True
    if required and not all(isinstance(v, str) for v in values):
        return False
    if any(v and not isinstance(v, str) for v in values):
        return False
    if values[0] not in SECTIONS or values[1] not in GROUPS or values[2] not in SECTIONS or values[3] not in GROUPS:
        return False
    return (values[0], values[1]) != (values[2], values[3])


def query_requests(params):
    clauses = ['expires_at > ?']
    args = [now_utc().isoformat()]
    for key, options in (('current_section', SECTIONS), ('current_group', GROUPS), ('target_section', SECTIONS), ('target_group', GROUPS)):
        value = params.get(key, [''])[0]
        if value:
            if value not in options:
                raise ValueError('خيار بحث غير صالح')
            clauses.append(f'{key} = ?')
            args.append(value)
    sql = 'SELECT * FROM requests WHERE ' + ' AND '.join(clauses) + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
    limit = min(max(int(params.get('limit', ['40'])[0]), 1), 100)
    offset = min(max(int(params.get('offset', ['0'])[0]), 0), 100000)
    db = connect()
    try:
        rows = db.execute(sql, args + [limit + 1, offset]).fetchall()
        total = db.execute('SELECT COUNT(*) FROM requests WHERE ' + ' AND '.join(clauses), args).fetchone()[0]
        return {'requests': [request_view(r) for r in rows[:limit]], 'has_more': len(rows) > limit, 'total': total}
    finally:
        db.close()


def reverse_matches(db, current_section, current_group, target_section, target_group, exclude_telegram=''):
    return db.execute('''SELECT * FROM requests
        WHERE current_section = ? AND current_group = ? AND target_section = ? AND target_group = ?
          AND expires_at > ? AND lower(telegram) != lower(?)
        ORDER BY created_at DESC LIMIT 100''',
        (target_section, target_group, current_section, current_group, now_utc().isoformat(), exclude_telegram)).fetchall()


def stats():
    db = connect()
    try:
        current = now_utc().isoformat()
        total = db.execute('SELECT COUNT(*) FROM requests WHERE expires_at > ?', (current,)).fetchone()[0]
        pairs = db.execute('''SELECT COUNT(*) FROM requests a JOIN requests b ON
           a.id < b.id AND a.current_section=b.target_section AND a.current_group=b.target_group
           AND a.target_section=b.current_section AND a.target_group=b.current_group
           AND lower(a.telegram)!=lower(b.telegram)
           WHERE a.expires_at > ? AND b.expires_at > ?''', (current, current)).fetchone()[0]
        return {'active_requests': total, 'matching_pairs': pairs}
    finally:
        db.close()


def rate_limit(ip):
    with RATE_LOCK:
        timestamps = POSTS_PER_IP[ip]
        now = time.monotonic()
        while timestamps and now - timestamps[0] > 3600:
            timestamps.popleft()
        if len(timestamps) >= 12:
            return False
        timestamps.append(now)
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = 'Baddel/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt, *args):
        print('%s %s' % (self.address_string(), fmt % args), flush=True)

    def output(self, code, payload, headers=None):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def static(self, path):
        paths = {'/': ('index.html', 'text/html; charset=utf-8'), '/index.html': ('index.html', 'text/html; charset=utf-8'), '/styles.css': ('styles.css', 'text/css; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/favicon.svg': ('favicon.svg', 'image/svg+xml')}
        if path not in paths:
            return self.output(404, {'error': 'غير موجود'})
        filename, mime = paths[path]
        data = (PUBLIC / filename).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'public, max-age=300' if filename != 'index.html' else 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == '/api/health':
            return self.output(200, {'ok': True})
        if path == '/api/stats':
            return self.output(200, stats())
        if path == '/api/requests':
            try:
                return self.output(200, query_requests(parse_qs(parsed.query, keep_blank_values=True)))
            except (ValueError, OverflowError):
                return self.output(400, {'error': 'بيانات البحث غير صحيحة'})
        match = REQUEST_ID_RE.fullmatch(path)
        if match and not match.group(2):
            db = connect()
            try:
                request = db.execute('SELECT * FROM requests WHERE id = ? AND expires_at > ?', (match.group(1), now_utc().isoformat())).fetchone()
                if not request:
                    return self.output(404, {'error': 'هذا الطلب غير متاح'})
                return self.output(200, {'request': request_view(request)})
            finally:
                db.close()
        if match and match.group(2):
            db = connect()
            try:
                request = db.execute('SELECT * FROM requests WHERE id = ? AND expires_at > ?', (match.group(1), now_utc().isoformat())).fetchone()
                if not request:
                    return self.output(404, {'error': 'هذا الطلب غير متاح'})
                matches = reverse_matches(db, request['current_section'], request['current_group'], request['target_section'], request['target_group'], request['telegram'])
                return self.output(200, {'matches': [request_view(row) for row in matches]})
            finally:
                db.close()
        return self.static(path)

    def do_POST(self):
        if urlparse(self.path).path != '/api/requests':
            return self.output(404, {'error': 'غير موجود'})
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            return self.output(415, {'error': 'أرسل البيانات بصيغة JSON'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 2 or size > 4096:
                return self.output(413, {'error': 'حجم البيانات غير مناسب'})
            body = json.loads(self.rfile.read(size).decode('utf-8'))
            if not isinstance(body, dict) or not valid_pair(body):
                return self.output(400, {'error': 'اختر القروبات والشعب بشكل صحيح، ولا يمكن الانتقال لنفس المجموعة'})
            telegram = body.get('telegram', '')
            if not isinstance(telegram, str):
                return self.output(400, {'error': 'يوزر تيليجرام غير صحيح'})
            telegram = telegram.strip().lstrip('@')
            if not USER_RE.fullmatch(telegram):
                return self.output(400, {'error': 'يوزر تيليجرام يجب أن يكون من 5 إلى 32 حرفًا أو رقمًا أو _'})
            if body.get('consent') is not True:
                return self.output(400, {'error': 'تحتاج الموافقة على نشر يوزر تيليجرام'})
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return self.output(400, {'error': 'صيغة الطلب غير صحيحة'})

        ip = self.client_address[0]
        if ip in ('127.0.0.1', '::1'):
            ip = self.headers.get('X-Real-IP', ip)[:80]
        if not rate_limit(ip):
            return self.output(429, {'error': 'وصلت للحد المؤقت، حاول بعد ساعة'})
        now = now_utc()
        request_id = secrets.token_hex(16)
        token = secrets.token_urlsafe(32)
        values = (request_id, body['current_section'], body['current_group'], body['target_section'], body['target_group'], telegram, hashlib.sha256(token.encode()).hexdigest(), now.isoformat(), (now + timedelta(days=MAX_AGE_DAYS)).isoformat())
        db = connect()
        try:
            db.execute('DELETE FROM requests WHERE expires_at <= ?', (now.isoformat(),))
            db.execute('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?)', values)
            matches = reverse_matches(db, body['current_section'], body['current_group'], body['target_section'], body['target_group'], telegram)
            db.commit()
            return self.output(201, {'request': {'id': request_id, 'current_section': values[1], 'current_group': values[2], 'target_section': values[3], 'target_group': values[4], 'telegram': telegram, 'created_at': values[7], 'expires_at': values[8]}, 'owner_token': token, 'matches': [request_view(row) for row in matches]})
        except sqlite3.IntegrityError:
            db.rollback()
            return self.output(409, {'error': 'يوجد طلب مطابق منشور بهذا اليوزر بالفعل'})
        finally:
            db.close()

    def do_DELETE(self):
        path = urlparse(self.path).path
        match = REQUEST_ID_RE.fullmatch(path)
        if not match or match.group(2):
            return self.output(404, {'error': 'غير موجود'})
        token = self.headers.get('X-Owner-Token', '')
        if not token or len(token) > 160:
            return self.output(403, {'error': 'ليس لديك صلاحية حذف الطلب'})
        db = connect()
        try:
            owner = db.execute('SELECT owner_hash FROM requests WHERE id = ?', (match.group(1),)).fetchone()
            if not owner:
                return self.output(404, {'error': 'الطلب غير موجود'})
            provided = hashlib.sha256(token.encode()).hexdigest()
            if not hmac.compare_digest(owner['owner_hash'], provided):
                return self.output(403, {'error': 'لا يمكنك حذف طلب شخص آخر'})
            db.execute('DELETE FROM requests WHERE id = ?', (match.group(1),))
            db.commit()
            return self.output(200, {'deleted': True})
        finally:
            db.close()


if __name__ == '__main__':
    init_db()
    print(f'بدّل — http://{HOST}:{PORT} | database: {DB}', flush=True)
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print('Stopped')
