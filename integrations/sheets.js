const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { loadCached } = require('./bitrix');

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

let tokenCache = null;

function serviceAccount() {
  /* hosted: the whole key JSON can be set as GOOGLE_SERVICE_ACCOUNT_JSON instead of a file */
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) {
    const key = JSON.parse(inline);
    if (!key.client_email || !key.private_key) throw new Error('Google service account key is invalid');
    return key;
  }
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!file) throw new Error('Google service account key not configured');
  const key = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'));
  if (!key.client_email || !key.private_key) throw new Error('Google service account key is invalid');
  return key;
}

function fileId() {
  const value = process.env.GOOGLE_SHEET_ID?.trim();
  if (!value) throw new Error('Google file not configured');
  return value.match(/\/d\/([\w-]+)/)?.[1] || value;
}

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

async function accessToken() {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.value;
  const key = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error || 'Google sign-in failed');
  tokenCache = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return tokenCache.value;
}

async function drive(pathAndQuery) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId()}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const reason = data.error?.errors?.[0]?.reason || data.error?.status || response.status;
    throw new Error(`Google Drive request failed (${reason})`);
  }
  return response;
}

/* Downloads the workbook (as-is if .xlsx, exported if a native Google Sheet) and returns every tab as rows. */
async function getWorkbook() {
  const meta = await (await drive('?fields=name,mimeType,modifiedTime&supportsAllDrives=true')).json();
  const url = meta.mimeType === SHEET_MIME
    ? `/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
    : '?alt=media&supportsAllDrives=true';
  const buffer = Buffer.from(await (await drive(url)).arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const tabs = {};
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null, raw: true })
      .map(row => row.map(cell => (cell instanceof Date ? cell.toISOString() : cell)));
    while (rows.length && rows[rows.length - 1].every(cell => cell === null || cell === '')) rows.pop();
    tabs[name] = rows;
  }
  return { name: meta.name, modifiedTime: meta.modifiedTime, tabs };
}

async function connectionTest() {
  const meta = await (await drive('?fields=name,modifiedTime&supportsAllDrives=true')).json();
  return { connected: true, file: meta.name, modifiedTime: meta.modifiedTime, serviceAccount: serviceAccount().client_email };
}

module.exports = { connectionTest, getWorkbook, loadCached };
