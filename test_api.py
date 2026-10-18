"""Run: python3 -m unittest test_api -v"""
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('baddel_server', ROOT / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class API(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        server.DB = Path(cls.temporary.name) / 'test.sqlite3'
        server.init_db()
        cls.http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.origin = 'http://127.0.0.1:%d' % cls.http.server_address[1]
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=5)
        cls.temporary.cleanup()

    @classmethod
    def call(cls, url, method='GET', data=None, headers=None):
        body = json.dumps(data).encode() if data is not None else None
        h = headers or {}
        if body is not None:
            h['Content-Type'] = 'application/json'
        request = Request(cls.origin + url, data=body, headers=h, method=method)
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_01_publish_match_delete(self):
        a = dict(current_section='A', current_group='C1', target_section='A', target_group='A2', telegram='test_00001', consent=True)
        b = dict(current_section='A', current_group='A2', target_section='A', target_group='C1', telegram='test_00002', consent=True)
        c = dict(current_section='B', current_group='A1', target_section='A', target_group='C2', telegram='test_00003', consent=True)
        d = dict(current_section='A', current_group='C2', target_section='B', target_group='A1', telegram='test_00004', consent=True)
        entries = []
        for item, expected in [(a, 0), (b, 1), (c, 0), (d, 1)]:
            status, result = self.call('/api/requests', method='POST', data=item)
            self.assertEqual(status, 201)
            self.assertEqual(len(result['matches']), expected)
            entries.append(result)
        self.assertEqual(self.call('/api/stats')[1]['matching_pairs'], 2)
        self.assertEqual(self.call('/api/requests?current_section=B&current_group=A1')[1]['total'], 1)
        self.assertEqual(len(self.call('/api/requests/' + entries[0]['request']['id'] + '/matches')[1]['matches']), 1)
        key = entries[3]['request']['id']
        self.assertEqual(self.call('/api/requests/' + key, method='DELETE', headers={'X-Owner-Token': 'bad'})[0], 403)
        self.assertEqual(self.call('/api/requests/' + key, method='DELETE', headers={'X-Owner-Token': entries[3]['owner_token']})[0], 200)
        self.assertEqual(self.call('/api/stats')[1], {'active_requests': 3, 'matching_pairs': 1})
        self.assertEqual(self.call('/api/requests/' + key)[0], 404)
        self.assertEqual(self.call('/api/requests', method='POST', data=a)[0], 409)

    def test_02_validate(self):
        payload = dict(current_section='B', current_group='A1', target_section='A', target_group='C1', telegram='valid_test01', consent=True)
        for mutation in [
            {'current_section': 'Z'},
            {'current_group': 'E1'},
            {'target_section': 'B', 'target_group': 'A1'},
            {'telegram': 'xy'},
            {'consent': False},
        ]:
            self.assertEqual(self.call('/api/requests', method='POST', data={**payload, **mutation})[0], 400)
        self.assertEqual(self.call('/api/requests?current_group=E5')[0], 400)

    def test_03_frontend(self):
        with urlopen(self.origin + '/', timeout=5) as response:
            self.assertIn(b'<html lang="ar" dir="rtl">', response.read())
        with urlopen(self.origin + '/app.js', timeout=5) as response:
            self.assertIn(b'function showMatches', response.read())
        self.assertEqual(self.call('/api/health'), (200, {'ok': True}))


if __name__ == '__main__':
    unittest.main()
