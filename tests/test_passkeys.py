import asyncio
import datetime as dt
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from starlette.requests import Request
from webauthn import generate_authentication_options, generate_registration_options
from webauthn.helpers import bytes_to_base64url
from webauthn.helpers.structs import CredentialDeviceType

from bindery import db, web
from bindery.auth import SESSION_COOKIE, password_is_fresh, sign_in, webauthn_config


class PasskeyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password_hash = PasswordHasher(time_cost=1, memory_cost=8192).hash('test-password')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {
            'BINDERY_DB_PATH': str(self.root / 'test.db'),
            'BINDERY_LIBRARY_DIR': str(self.root / 'library'),
            'BINDERY_PASSWORD_HASH': self.password_hash,
            'BINDERY_PASSWORD_HASH_FILE': '',
            'BINDERY_PUBLIC_ORIGIN': 'https://books.example.com',
            'BINDERY_PUBLIC_ORIGIN_FILE': '',
            'BINDERY_WEBAUTHN_RP_ID': '',
            'BINDERY_WEBAUTHN_RP_ID_FILE': '',
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        db.init_db()
        self.client = TestClient(web.app, base_url='https://books.example.com', follow_redirects=False)
        self.addCleanup(self.client.close)
        self.authentication_options = generate_authentication_options(rp_id='books.example.com')
        self.registration_options = generate_registration_options(rp_id='books.example.com', rp_name='Bindery', user_name='bindery')
        self.mocks = {}
        for name, result in {
            'generate_authentication_options': self.authentication_options,
            'generate_registration_options': self.registration_options,
            'verify_authentication_response': SimpleNamespace(new_sign_count=3, credential_backed_up=True),
            'verify_registration_response': SimpleNamespace(
                credential_id=b'new-key', credential_public_key=b'public-key', sign_count=0, aaguid='aaguid',
                credential_device_type=CredentialDeviceType.MULTI_DEVICE, credential_backed_up=True),
        }.items():
            mock = patch.object(web, name, return_value=result)
            self.mocks[name] = mock.start()
            self.addCleanup(mock.stop)

    def add_key(self, credential_id='a2V5'):
        db.insert_passkey(credential_id, b'public', 1, '["internal"]', 'aaguid', 'single_device', False,
                          '我的设备', web._now_iso())
        return credential_id

    def password_login(self, next='/'):
        response = self.client.post('/login', data={'password': 'test-password', 'next': next})
        self.assertEqual(response.status_code, 303)
        return self.client.cookies.get(SESSION_COOKIE)

    def stale(self, session_id):
        db.mark_password_verified(session_id, (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=11)).isoformat())

    def post(self, path, body=None):
        return self.client.post(path, json=body or {})

    def issue_login(self):
        response = self.post('/login/passkey/options')
        self.assertEqual(response.status_code, 200)
        return self.client.cookies.get(web.WEBAUTHN_COOKIE)

    def issue_register(self):
        response = self.post('/security/passkeys/register/options')
        self.assertEqual(response.status_code, 200)
        return self.client.cookies.get(web.WEBAUTHN_COOKIE)

    def register(self, name='', raw_id='bmV3LWtleQ'):
        return self.post('/security/passkeys/register/verify', {
            'credential': {'rawId': raw_id, 'response': {'transports': ['internal', 'hybrid', 'bogus']}}, 'name': name})

    def expire_challenge(self, challenge_id):
        with closing(db.connect()) as conn, conn:
            conn.execute('UPDATE webauthn_challenges SET expires_at = ? WHERE id = ?',
                         ((dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)).isoformat(), challenge_id))

    def test_config_resolution(self):
        request = lambda url: Request({'type': 'http', 'scheme': url.split(':')[0], 'path': '/',
                                      'headers': [(b'host', url.split('//')[1].encode())], 'query_string': b''})
        for origin, available in [
            ('https://books.example.com', True), ('http://localhost:5670', True),
            ('http://books.example.com', False), ('https://127.0.0.1', False),
            ('https://books.example.com/', False), ('https://books.example.com/path', False),
            ('https://user@books.example.com', False), ('https://books.example.com?x=1', False),
            ('https://books.example.com#x', False), ('https://books.example.com:bad', False),
            ('https://books.example.com\n', False),
            ('https://2130706433', False), ('https://127.1', False), ('https://0x7f000001', False),
        ]:
            with self.subTest(origin=origin), patch.dict(os.environ, {'BINDERY_PUBLIC_ORIGIN': origin}):
                self.assertEqual(webauthn_config(request('http://untrusted.example')) is not None, available)
        with patch.dict(os.environ, {'BINDERY_PUBLIC_ORIGIN': 'HTTPS://BOOKS.EXAMPLE.COM:443'}):
            self.assertEqual(webauthn_config().origin, 'https://books.example.com')
        with patch.dict(os.environ, {'BINDERY_PUBLIC_ORIGIN': ''}):
            self.assertEqual(webauthn_config(request('http://localhost:9876')).origin, 'http://localhost:9876')
            self.assertIsNone(webauthn_config(request('http://127.0.0.1:9876')))
            self.assertIsNone(webauthn_config(request('https://books.example.com')))

    def test_config_rp_id_and_file_variants(self):
        for rp, expected in [('example.com', True), ('books.example.com', True), ('evil.com', False),
                             ('com', False), ('127.0.0.1', False), ('example.com:443', False)]:
            with self.subTest(rp=rp), patch.dict(os.environ, {'BINDERY_WEBAUTHN_RP_ID': rp}):
                self.assertEqual(webauthn_config() is not None, expected)
        origin_file = self.root / 'origin'
        origin_file.write_text('https://books.example.com\n')
        rp_file = self.root / 'rp'
        rp_file.write_text('example.com\n')
        with patch.dict(os.environ, {'BINDERY_PUBLIC_ORIGIN': '', 'BINDERY_PUBLIC_ORIGIN_FILE': str(origin_file),
                                    'BINDERY_WEBAUTHN_RP_ID_FILE': str(rp_file)}):
            self.assertEqual(webauthn_config().rp_id, 'example.com')

    def test_rp_override_requires_matching_host_or_dotted_suffix(self):
        for host, rp, expected in [
            ('books.example.com', 'books.example.com', True),
            ('books.example.com', 'example.com', True),
            ('books.example.com', 'evil.com', False),
            ('books.notexample.com', 'example.com', False),
            ('books.example.com', 'com', False),
            # Public-suffix rejection is delegated to the browser's WebAuthn API.
            ('books.example.co.uk', 'co.uk', True),
        ]:
            with self.subTest(host=host, rp=rp), patch.dict(os.environ, {
                'BINDERY_PUBLIC_ORIGIN': 'https://' + host, 'BINDERY_WEBAUTHN_RP_ID': rp,
            }):
                self.assertEqual(webauthn_config() is not None, expected)

    def test_password_freshness_rejects_future_naive_and_invalid_timestamps(self):
        for value in [None, 'invalid', '2026-01-01',
                      (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1)).isoformat()]:
            self.assertFalse(password_is_fresh({'password_verified_at': value}))

    def test_invalid_config_warns_at_startup(self):
        with patch.dict(os.environ, {'BINDERY_PUBLIC_ORIGIN': 'http://example.com'}), \
                patch.object(web, 'load_rule_templates'), patch.object(web, '_ensure_ingest_worker_started'), \
                self.assertLogs(web.logger, level='WARNING') as logs:
            asyncio.run(web.startup())
        self.assertIn('passkeys are unavailable', logs.output[0])

    def test_migrate_old_sessions_without_fabricating_password_freshness(self):
        with closing(db.connect()) as conn, conn:
            conn.execute('DROP TABLE sessions')
            conn.execute('CREATE TABLE sessions(session_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_seen TEXT NOT NULL)')
            conn.execute("INSERT INTO sessions VALUES ('old', 'then', 'then')")
        db.init_db()
        db.init_db()
        session = db.get_session('old')
        self.assertEqual(session['auth_method'], 'password')
        self.assertIsNone(session['password_verified_at'])
        self.assertFalse(password_is_fresh(session))

    def test_passkey_crud_and_settings_are_stable(self):
        self.assertEqual(db.count_passkeys(), 0)
        self.assertIsNone(db.get_passkey('missing'))
        key = self.add_key()
        self.assertEqual(db.list_passkeys()[0]['public_key'], b'public')
        self.assertEqual(db.count_passkeys(), 1)
        self.assertTrue(db.rename_passkey(key, '新的名字'))
        db.update_passkey_usage(key, 8, True, '2026-10-20')
        record = db.get_passkey(key)
        self.assertEqual((record['name'], record['sign_count'], record['backed_up'], record['last_used_at']),
                         ('新的名字', 8, 1, '2026-10-20'))
        user_id = db.get_or_create_webauthn_user_id()
        self.assertEqual(len(user_id), 32)
        db.init_db()
        self.assertEqual(db.get_or_create_webauthn_user_id(), user_id)
        with closing(db.connect()) as conn, conn:
            value = conn.execute("SELECT value FROM app_settings WHERE key='webauthn_user_id'").fetchone()[0]
        self.assertEqual(value, bytes_to_base64url(user_id))
        self.assertTrue(db.delete_passkey(key))
        self.assertFalse(db.delete_passkey(key))
        self.assertFalse(db.rename_passkey(key, 'x'))

    def test_challenges_crud_purge_and_atomic_pop(self):
        expired = db.create_challenge('login', b'old')
        self.expire_challenge(expired)
        current = db.create_challenge('register', b'new', 'session')
        self.assertIsNone(db.pop_challenge(expired))
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(db.pop_challenge, [current, current]))
        self.assertEqual(sum(item is not None for item in results), 1)
        record = next(item for item in results if item)
        self.assertEqual((record['kind'], record['session_id'], record['challenge']), ('register', 'session', b'new'))
        self.assertIsNone(db.pop_challenge(current))
        with self.assertRaises(ValueError):
            db.create_challenge('register', b'challenge')

    def test_safe_next(self):
        for value in ['/', '/book/x?y=1', '/?q=a:b', '/book/x?return_to=%2F%3Fq%3Da%3Ab',
                      '/book?next=https://evil.com']:
            self.assertEqual(web._safe_next(value), value)
        for value in ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '',
                      '/\nevil', '/\x00evil', '/\x7fevil']:
            self.assertEqual(web._safe_next(value), '/')

    def test_login_paths_preserve_colons_in_local_return_addresses(self):
        self.add_key()
        for next_url in ['/?q=a:b', '/book/x?return_to=%2F%3Fq%3Da%3Ab']:
            with self.subTest(next=next_url):
                page = self.client.get('/login', params={'next': next_url})
                self.assertIn(f'name="next" value="{next_url}"', page.text)
                response = self.client.post('/login', data={'password': 'test-password', 'next': next_url})
                self.assertEqual(response.status_code, 303)
                self.assertEqual(response.headers['location'], next_url)
                self.issue_login()
                response = self.post('/login/passkey/verify', {'credential': {'rawId': 'a2V5'}, 'next': next_url})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {'redirect': next_url})

    def test_password_sign_in_metadata_and_redirect(self):
        session_id = self.password_login('https://evil.com')
        session = db.get_session(session_id)
        self.assertEqual(session['auth_method'], 'password')
        self.assertTrue(password_is_fresh(session))
        response = self.client.post('/login', data={'password': 'test-password', 'next': '//evil.com'})
        self.assertEqual(response.headers['location'], '/')
        cookie = response.headers['set-cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=lax', cookie)
        self.assertNotIn('Max-Age', cookie)
        page = self.client.get('/login', params={'next': '/\\evil.com'})
        self.assertIn('name="next" value="/"', page.text)

    def test_login_options_cookie_and_discoverable_credentials_without_session(self):
        self.add_key()
        challenge_id = self.issue_login()
        row = db.pop_challenge(challenge_id)
        self.assertEqual(row['kind'], 'login')
        self.assertIsNone(row['session_id'])
        self.assertEqual(row['challenge'], self.authentication_options.challenge)
        options = self.mocks['generate_authentication_options'].call_args.kwargs
        self.assertEqual(options['allow_credentials'], [])
        self.assertEqual(options['user_verification'].value, 'required')
        response = self.post('/login/passkey/options')
        self.assertEqual(response.json()['challenge'], bytes_to_base64url(self.authentication_options.challenge))
        for attr in ['HttpOnly', 'Max-Age=300', 'Path=/login/passkey', 'SameSite=strict', 'Secure']:
            self.assertIn(attr, response.headers['set-cookie'])

    def test_localhost_challenge_cookie_is_not_secure(self):
        self.add_key()
        as_client = TestClient(web.app, base_url='http://localhost:5670')
        self.addCleanup(as_client.close)
        with patch.dict(os.environ, {'BINDERY_PUBLIC_ORIGIN': ''}):
            response = as_client.post('/login/passkey/options', json={})
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('Secure', response.headers['set-cookie'])

    def test_login_success_updates_usage_and_cannot_reuse_challenge(self):
        key = self.add_key()
        challenge = self.issue_login()
        body = {'credential': {'rawId': key}, 'next': '/book/x?y=1'}
        response = self.post('/login/passkey/verify', body)
        self.assertEqual(response.json(), {'redirect': '/book/x?y=1'})
        session = db.get_session(self.client.cookies.get(SESSION_COOKIE))
        self.assertEqual(session['auth_method'], 'passkey')
        self.assertIsNone(session['password_verified_at'])
        self.assertIn('Max-Age=0', response.headers.get_list('set-cookie')[1])
        record = db.get_passkey(key)
        self.assertEqual(record['sign_count'], 3)
        self.assertEqual(record['backed_up'], 1)
        self.assertIsNotNone(record['last_used_at'])
        args = self.mocks['verify_authentication_response'].call_args.kwargs
        self.assertEqual(args['expected_challenge'], self.authentication_options.challenge)
        self.assertEqual(args['expected_origin'], 'https://books.example.com')
        self.assertEqual(args['expected_rp_id'], 'books.example.com')
        self.assertEqual(args['credential_public_key'], b'public')
        self.assertEqual(args['credential_current_sign_count'], 1)
        self.assertTrue(args['require_user_verification'])
        self.client.cookies.set(web.WEBAUTHN_COOKIE, challenge, domain='books.example.com', path=web.LOGIN_PASSKEY_PATH)
        self.assertEqual(self.post('/login/passkey/verify', body).status_code, 400)

    def test_login_failures_have_exactly_the_same_response(self):
        self.add_key()
        failures = []
        for failure in ['missing', 'expired', 'unknown', 'verification', 'wrong_kind', 'malformed']:
            with self.subTest(failure=failure):
                self.client.cookies.clear()
                challenge = self.issue_login()
                credential = {'rawId': 'a2V5'}
                if failure == 'missing':
                    self.client.cookies.clear()
                elif failure == 'expired':
                    self.expire_challenge(challenge)
                elif failure == 'unknown':
                    credential['rawId'] = 'unknown'
                elif failure == 'wrong_kind':
                    with closing(db.connect()) as conn, conn:
                        conn.execute("UPDATE webauthn_challenges SET kind='register' WHERE id=?", (challenge,))
                elif failure == 'malformed':
                    credential = None
                self.mocks['verify_authentication_response'].side_effect = ValueError('private verification detail') if failure == 'verification' else None
                response = self.post('/login/passkey/verify', {'credential': credential})
                failures.append((response.status_code, response.json()))
                if failure != 'missing':
                    self.assertIsNone(db.pop_challenge(challenge))
        self.assertEqual(failures, [(400, {'error': '通行密钥验证失败'})] * len(failures))

    def test_passkey_redirect_is_sanitized(self):
        self.add_key()
        self.issue_login()
        response = self.post('/login/passkey/verify', {'credential': {'rawId': 'a2V5'}, 'next': '//evil.com'})
        self.assertEqual(response.json(), {'redirect': '/'})

    def test_no_passkeys_options_404(self):
        self.assertEqual(self.post('/login/passkey/options').status_code, 404)

    def test_all_json_posts_reject_non_json(self):
        self.password_login()
        for path in ['/login/passkey/options', '/login/passkey/verify', '/security/reauth',
                     '/security/passkeys/register/options', '/security/passkeys/register/verify',
                     '/security/passkeys/missing/rename']:
            with self.subTest(path=path):
                response = self.client.post(path, data={'password': 'test-password'})
                self.assertEqual(response.status_code, 415)
                self.assertIn('error', response.json())
        self.assertEqual(self.client.post('/security/reauth', content='{}', headers={'Content-Type': 'application/json; charset=utf-8'}).status_code, 400)

    def test_malformed_json_is_400_and_consumes_verify_challenge(self):
        self.add_key()
        challenge = self.issue_login()
        response = self.client.post('/login/passkey/verify', content='{', headers={'Content-Type': 'application/json'})
        self.assertEqual(response.json(), {'error': '通行密钥验证失败'})
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(db.pop_challenge(challenge))
        self.password_login()
        self.assertEqual(self.client.post('/security/reauth', json=[]).status_code, 400)

    def test_non_json_verification_still_consumes_both_challenge_kinds(self):
        self.add_key()
        challenge = self.issue_login()
        self.assertEqual(self.client.post('/login/passkey/verify', data={'credential': 'invalid'}).status_code, 415)
        self.assertIsNone(db.pop_challenge(challenge))
        self.password_login()
        challenge = self.issue_register()
        self.assertEqual(self.client.post('/security/passkeys/register/verify', data={'credential': 'invalid'}).status_code, 415)
        self.assertIsNone(db.pop_challenge(challenge))
        self.mocks['verify_authentication_response'].assert_not_called()
        self.mocks['verify_registration_response'].assert_not_called()

    def test_config_unavailable_endpoints_404_and_security_notice(self):
        self.password_login()
        with patch.dict(os.environ, {'BINDERY_PUBLIC_ORIGIN': ''}):
            for path in ['/login/passkey/options', '/login/passkey/verify', '/security/reauth',
                         '/security/passkeys/register/options', '/security/passkeys/register/verify',
                         '/security/passkeys/missing/rename', '/security/passkeys/missing/delete']:
                self.assertEqual(self.post(path).status_code, 404, path)
            page = self.client.get('/security')
            self.assertIn('通行密钥不可用：未配置 BINDERY_PUBLIC_ORIGIN', page.text)
            self.assertNotIn('data-passkey-add', page.text)

    def test_fresh_registration_options_require_resident_key_and_uv(self):
        self.password_login()
        key = self.add_key()
        response = self.post('/security/passkeys/register/options')
        self.assertEqual(response.status_code, 200)
        for attr in ['HttpOnly', 'Max-Age=300', 'Path=/security/passkeys', 'SameSite=strict', 'Secure']:
            self.assertIn(attr, response.headers['set-cookie'])
        challenge = db.pop_challenge(self.client.cookies.get(web.WEBAUTHN_COOKIE))
        self.assertEqual(challenge['session_id'], self.client.cookies.get(SESSION_COOKIE))
        args = self.mocks['generate_registration_options'].call_args.kwargs
        self.assertEqual(args['user_id'], db.get_or_create_webauthn_user_id())
        self.assertEqual(args['rp_name'], 'Bindery')
        self.assertEqual(args['user_name'], 'bindery')
        self.assertEqual(args['user_display_name'], 'Bindery')
        self.assertEqual(args['authenticator_selection'].resident_key.value, 'required')
        self.assertEqual(args['authenticator_selection'].user_verification.value, 'required')
        self.assertEqual(args['attestation'].value, 'none')
        self.assertEqual(bytes_to_base64url(args['exclude_credentials'][0].id), key)
        self.assertEqual(args['exclude_credentials'][0].transports[0].value, 'internal')

    def test_stale_session_requires_reauth_then_issues_options(self):
        session = self.password_login()
        self.stale(session)
        response = self.post('/security/passkeys/register/options')
        self.assertEqual((response.status_code, response.json()), (403, {'error': 'needs_password'}))
        self.assertEqual(self.post('/security/reauth', {'password': 'wrong'}).json(), {'error': '密码错误'})
        response = self.post('/security/reauth', {'password': 'test-password'})
        self.assertEqual(response.json(), {'ok': True})
        self.assertTrue(password_is_fresh(db.get_session(session)))
        self.issue_register()
        with patch.dict(os.environ, {'BINDERY_PASSWORD_HASH': ''}):
            response = self.post('/security/reauth', {'password': 'test-password'})
            self.assertEqual((response.status_code, response.json()), (400, {'error': '未配置密码哈希'}))

    def test_passkey_session_requires_password_before_registration(self):
        session = sign_in(auth_method='passkey')
        self.client.cookies.set(SESSION_COOKIE, session)
        self.assertEqual(self.post('/security/passkeys/register/options').status_code, 403)
        self.assertEqual(self.post('/security/reauth', {'password': 'test-password'}).status_code, 200)
        self.issue_register()
        self.assertEqual(db.get_session(session)['auth_method'], 'passkey')

    def test_registration_checks_freshness_again_on_verify(self):
        session = self.password_login()
        challenge = self.issue_register()
        self.stale(session)
        response = self.register()
        self.assertEqual((response.status_code, response.json()), (403, {'error': 'needs_password'}))
        self.assertIsNone(db.pop_challenge(challenge))
        self.mocks['verify_registration_response'].assert_not_called()

    def test_registration_challenge_is_bound_to_issuing_session(self):
        self.password_login()
        challenge = self.issue_register()
        self.password_login()
        response = self.register()
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(db.pop_challenge(challenge))
        self.mocks['verify_registration_response'].assert_not_called()

    def test_registration_challenge_rejects_expiry_kind_and_replay(self):
        self.password_login()
        for kind in ['expired', 'login']:
            challenge = self.issue_register()
            if kind == 'expired':
                self.expire_challenge(challenge)
            else:
                with closing(db.connect()) as conn, conn:
                    conn.execute("UPDATE webauthn_challenges SET kind='login' WHERE id=?", (challenge,))
            self.assertEqual(self.register().status_code, 400)
            self.assertIsNone(db.pop_challenge(challenge))
        challenge = self.issue_register()
        self.assertEqual(self.register().status_code, 200)
        self.client.cookies.set(web.WEBAUTHN_COOKIE, challenge, domain='books.example.com', path=web.REGISTER_PASSKEY_PATH)
        self.assertEqual(self.register().status_code, 400)

    def test_registration_default_name_duplicate_and_name_truncation(self):
        self.password_login()
        self.issue_register()
        response = self.register('  ')
        self.assertEqual(response.json()['passkey']['name'], '通行密钥 1')
        self.assertNotIn('public_key', response.json()['passkey'])
        self.assertIn('Max-Age=0', response.headers['set-cookie'])
        saved = db.get_passkey('bmV3LWtleQ')
        self.assertEqual(json.loads(saved['transports_json']), ['internal', 'hybrid'])
        self.assertEqual(saved['device_type'], 'multi_device')
        args = self.mocks['verify_registration_response'].call_args.kwargs
        self.assertTrue(args['require_user_verification'])
        self.assertEqual(args['expected_challenge'], self.registration_options.challenge)
        self.assertEqual(args['expected_origin'], 'https://books.example.com')
        self.assertEqual(args['expected_rp_id'], 'books.example.com')
        self.issue_register()
        response = self.register()
        self.assertEqual((response.status_code, response.json()), (409, {'error': '此通行密钥已添加'}))
        self.mocks['verify_registration_response'].return_value.credential_id = b'another-key'
        self.issue_register()
        response = self.register('  ' + '名' * 45 + '  ')
        self.assertEqual(response.json()['passkey']['name'], '名' * 40)

    def test_failed_registration_consumes_challenge(self):
        self.password_login()
        challenge = self.issue_register()
        self.mocks['verify_registration_response'].side_effect = ValueError('private failure')
        self.assertEqual(self.register().status_code, 400)
        self.assertIsNone(db.pop_challenge(challenge))
        self.assertEqual(db.count_passkeys(), 0)

    def test_rename_and_delete_require_no_freshness(self):
        key = self.add_key()
        session = self.password_login()
        self.stale(session)
        response = self.post(f'/security/passkeys/{key}/rename', {'name': '  new  '})
        self.assertEqual(response.json(), {'ok': True, 'name': 'new'})
        self.assertEqual(db.get_passkey(key)['name'], 'new')
        self.assertEqual(self.post(f'/security/passkeys/{key}/rename', {'name': 'x' * 50}).json()['name'], 'x' * 40)
        self.assertEqual(self.post(f'/security/passkeys/{key}/rename', {'name': ''}).json()['name'], '通行密钥 2')
        self.assertEqual(self.post('/security/passkeys/missing/rename', {'name': 'x'}).status_code, 404)
        response = self.client.post(f'/security/passkeys/{key}/delete', data={})
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers['location'], '/security?toast=' + web.urllib.parse.quote('已删除通行密钥'))
        self.assertEqual(db.count_passkeys(), 0)
        self.assertEqual(self.client.post(f'/security/passkeys/{key}/delete').status_code, 404)

    def test_security_requires_a_session(self):
        response = self.client.get('/security')
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers['location'], '/login?next=/security')

    def test_login_template_passkey_block_is_hidden_and_conditional(self):
        self.assertNotIn('data-passkey-login', self.client.get('/login').text)
        self.add_key()
        page = self.client.get('/login').text
        self.assertIn('<div hidden data-passkey-login>', page)
        self.assertIn('使用通行密钥登录', page)
        self.assertIn('<script defer src="/static/passkey.js"></script>', page)
        with patch.dict(os.environ, {'BINDERY_PUBLIC_ORIGIN': ''}):
            self.assertNotIn('data-passkey-login', self.client.get('/login').text)

    def test_library_nudge_conditions_and_security_template(self):
        self.password_login()
        page = self.client.get('/').text
        self.assertIn('hidden data-passkey-nudge', page)
        self.assertIn('下次登录可以跳过密码', page)
        self.assertIn('passkey-dialog-title', page)
        with patch.dict(os.environ, {'BINDERY_PUBLIC_ORIGIN': ''}):
            self.assertNotIn('data-passkey-nudge', self.client.get('/').text)
        key = self.add_key()
        self.assertNotIn('data-passkey-nudge', self.client.get('/').text)
        security = self.client.get('/security').text
        self.assertIn('1 个通行密钥', security)
        self.assertIn('仅此设备', security)
        self.assertIn('从未', security)
        self.assertIn('安全与通行密钥', security)
        db.delete_passkey(key)
        session = sign_in(auth_method='passkey')
        self.client.cookies.clear()
        self.client.cookies.set(SESSION_COOKIE, session)
        self.assertNotIn('data-passkey-nudge', self.client.get('/').text)


class PasskeyFrontendTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node.js is needed for the dependency-free frontend harness')
    def test_native_and_fallback_conversion_requests_and_normalized_errors(self):
        root = Path(__file__).resolve().parent.parent
        result = subprocess.run(['node', 'tests/test_passkey_frontend.js'], cwd=root, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
