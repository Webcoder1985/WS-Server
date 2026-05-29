import { createHash, timingSafeEqual } from 'node:crypto';
import { EXPECTED_USER, EXPECTED_PASS } from './config.js';

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function slowEqual(a, b) {
  const da = digest(a);
  const db = digest(b);
  return da.length === db.length && timingSafeEqual(da, db);
}

export function queryCredentials(req) {
  const host = req.headers.host ?? 'localhost';
  const url  = new URL(req.url ?? '/', `http://${host}`);
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  if (username === null || password === null) return null;
  if (username === '' || password === '') return null;
  return { username, password };
}

export function credentialsOk(req) {
  const creds = queryCredentials(req);
  if (!creds) return false;
  return (
    slowEqual(creds.username, EXPECTED_USER) &&
    slowEqual(creds.password, EXPECTED_PASS)
  );
}
