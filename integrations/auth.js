const crypto = require('crypto');

/* Two shared passwords from .env: VIEWER_PASSWORD (all contractors, read-only) and ADMIN_PASSWORD
   (also sees Settings & Access). The session is a signed cookie, so nothing is stored on the server. */

const COOKIE = 'kpi_session';
const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const secret = () => process.env.SESSION_SECRET?.trim() || '';
const sign = payload => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function configured() {
  return Boolean(secret() && process.env.VIEWER_PASSWORD?.trim() && process.env.ADMIN_PASSWORD?.trim());
}

function roleFor(password) {
  const admin = process.env.ADMIN_PASSWORD?.trim();
  const viewer = process.env.VIEWER_PASSWORD?.trim();
  if (admin && same(password, admin)) return 'admin';
  if (viewer && same(password, viewer)) return 'viewer';
  return null;
}

function readCookie(req) {
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return '';
}

function sessionRole(req) {
  if (!secret()) return null;
  const [payload, mac] = readCookie(req).split('.');
  if (!payload || !mac || !same(mac, sign(payload))) return null;
  try {
    const { role, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!['viewer', 'admin'].includes(role) || exp < Date.now()) return null;
    return role;
  } catch {
    return null;
  }
}

function startSession(req, res, role) {
  const payload = Buffer.from(JSON.stringify({ role, exp: Date.now() + SESSION_HOURS * 3600 * 1000 })).toString('base64url');
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`);
}

function endSession(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/* slow down password guessing: 5 wrong tries from one address lock it for 15 minutes */
const fails = new Map();
function lockedOut(ip) {
  const entry = fails.get(ip);
  if (!entry) return false;
  if (entry.until && entry.until > Date.now()) return true;
  if (entry.until) fails.delete(ip);
  return false;
}
function recordFail(ip) {
  const entry = fails.get(ip) || { count: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILS) entry.until = Date.now() + LOCK_MS;
  fails.set(ip, entry);
}
const clearFails = ip => fails.delete(ip);

module.exports = { configured, roleFor, sessionRole, startSession, endSession, lockedOut, recordFail, clearFails };
