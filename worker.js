/**
 * MobCash API proxy for Cloudflare Workers.
 * Set secrets/vars in Worker settings; never put company credentials in HTML.
 * Required secrets: API_HASH, CASHIERPASS, TELEGRAM_BOT_TOKEN
 * Required vars: CASHDESKID, API_LOGIN, API_BASE_URL (optional), API_LANGUAGE (optional)
 */
const DEFAULT_BASE = 'https://partners.servcul.com/CashdeskBotAPI';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, service: 'MobCash API proxy' }, 200, cors);
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) return json({ ok: false, message: 'Not found' }, 404, cors);

    try {
      requireConfig(env);
      const telegramUser = await validateTelegramInitData(request.headers.get('X-Telegram-Init-Data') || '', env.TELEGRAM_BOT_TOKEN);
      const body = await request.json();
      const playerId = cleanId(body.playerId);
      if (!playerId) return json({ ok: false, message: 'A valid Player ID is required.' }, 400, cors);

      if (url.pathname === '/api/deposit/verify-player' || url.pathname === '/api/withdraw/verify-player') {
        const player = await lookupPlayer(playerId, env);
        return json({ ok: true, playerName: player.name || '', userId: player.userId }, 200, cors);
      }

      if (url.pathname === '/api/deposit/submit') {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return json({ ok: false, message: 'Enter a valid deposit amount.' }, 400, cors);
        // Re-check the player immediately before posting funds.
        await lookupPlayer(playerId, env);
        const lng = env.API_LANGUAGE || 'en';
        const confirm = await md5(`${playerId}:${env.API_HASH}`);
        const sign = await signature(
          `hash=${env.API_HASH}&lng=${lng}&userid=${playerId}`,
          `summa=${amount}&cashierpass=${env.CASHIERPASS}&cashdeskid=${env.CASHDESKID}`
        );
        const result = await companyRequest(`/Deposit/${encodeURIComponent(playerId)}/Add`, {
          method: 'POST', sign, body: { cashdeskid: Number(env.CASHDESKID), lng, summa: amount, confirm }
        }, env);
        return json({ ok: true, message: result.message || 'Deposit request accepted by the company.', result }, 200, cors);
      }

      if (url.pathname === '/api/withdraw/receive') {
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!code || code.length > 200) return json({ ok: false, message: 'A valid withdrawal code is required.' }, 400, cors);
        await lookupPlayer(playerId, env);
        const lng = env.API_LANGUAGE || 'en';
        const confirm = await md5(`${playerId}:${env.API_HASH}`);
        const sign = await signature(
          `hash=${env.API_HASH}&lng=${lng}&userid=${playerId}`,
          `code=${code}&cashierpass=${env.CASHIERPASS}&cashdeskid=${env.CASHDESKID}`
        );
        const result = await companyRequest(`/Deposit/${encodeURIComponent(playerId)}/Payout`, {
          method: 'POST', sign, body: { cashdeskId: Number(env.CASHDESKID), lng, code, confirm }
        }, env);
        const success = result.success === true;
        return json({ ok: true, success, message: result.message || (success ? 'Payout completed.' : 'The company did not complete the payout.'), amount: result.summa ?? null, messageId: result.messageId ?? null }, 200, cors);
      }

      return json({ ok: false, message: 'Unknown API action.' }, 404, cors);
    } catch (error) {
      const status = error.status && Number.isInteger(error.status) ? error.status : 502;
      return json({ ok: false, message: safeMessage(error, env) }, status, cors);
    }
  }
};

function requireConfig(env) {
  for (const key of ['API_HASH', 'CASHIERPASS', 'CASHDESKID', 'TELEGRAM_BOT_TOKEN']) {
    if (!env[key]) throw new Error(`Server configuration missing: ${key}`);
  }
  if (!/^\d+$/.test(String(env.CASHDESKID))) throw new Error('CASHDESKID must be numeric.');
}
function cleanId(value) {
  const s = String(value ?? '').trim();
  return /^\d{1,30}$/.test(s) ? s : '';
}
function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
  const headers = { 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS, GET', 'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data' };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
function safeMessage(error, env) {
  let message = String(error?.message || 'Company API request failed.');
  // Never disclose secrets, hashes, request signatures, or upstream payloads.
  for (const secret of [env.API_HASH, env.CASHIERPASS, env.TELEGRAM_BOT_TOKEN]) {
    if (secret) message = message.split(secret).join('[hidden]');
  }
  return message.slice(0, 240);
}
// Web Crypto does not provide MD5 in Workers, so implement the PDF-required
// MD5 digest locally. This is used only to reproduce the company's protocol.
async function md5(value) {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >>> 6) + 1) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes); data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = Array.from({length:64}, (_,i) => Math.floor(Math.abs(Math.sin(i+1))*0x100000000) >>> 0);
  for (let offset=0; offset<paddedLength; offset+=64) {
    const M = Array.from({length:16}, (_,i) => view.getUint32(offset+i*4, true));
    let A=a0, B=b0, C=c0, D=d0;
    for (let i=0;i<64;i++) {
      let F,g;
      if (i<16) { F=(B&C)|(~B&D); g=i; }
      else if (i<32) { F=(D&B)|(~D&C); g=(5*i+1)%16; }
      else if (i<48) { F=B^C^D; g=(3*i+5)%16; }
      else { F=C^(B|~D); g=(7*i)%16; }
      const sum=(A + F + K[i] + M[g]) >>> 0;
      const rotated=((sum << shifts[i]) | (sum >>> (32-shifts[i]))) >>> 0;
      const next=(B + rotated) >>> 0;
      A=D; D=C; C=B; B=next;
    }
    a0=(a0+A)>>>0; b0=(b0+B)>>>0; c0=(c0+C)>>>0; d0=(d0+D)>>>0;
  }
  const out = new Uint8Array(16), outView = new DataView(out.buffer);
  [a0,b0,c0,d0].forEach((v,i)=>outView.setUint32(i*4,v,true));
  return hex(out.buffer);
}
async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return hex(digest);
}
function hex(buffer) { return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function signature(firstString, secondString) {
  const first = await sha256(firstString);
  const second = await md5(secondString);
  return sha256(first + second);
}
async function lookupPlayer(playerId, env) {
  const confirm = await md5(`${playerId}:${env.API_HASH}`);
  const sign = await signature(
    `hash=${env.API_HASH}&userid=${playerId}&cashdeskid=${env.CASHDESKID}`,
    `userid=${playerId}&cashierpass=${env.CASHIERPASS}&hash=${env.API_HASH}`
  );
  const result = await companyRequest(`/Users/${encodeURIComponent(playerId)}?confirm=${encodeURIComponent(confirm)}&cashdeskid=${encodeURIComponent(env.CASHDESKID)}`, { method: 'GET', sign }, env);
  if (result.userId === undefined && result.userid === undefined) throw new Error('Player was not found by the company API.');
  return { userId: String(result.userId ?? result.userid), name: String(result.name || '') };
}
async function companyRequest(path, options, env) {
  const base = String(env.API_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const headers = { 'Accept': 'application/json', 'sign': options.sign };
  let body;
  if (options.body) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(options.body); }
  const response = await fetch(base + path, { method: options.method, headers, body });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Company API returned non-JSON data (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(`Company API request failed (HTTP ${response.status}).`);
  return data;
}
async function validateTelegramInitData(initData, botToken) {
  if (!initData) throw new Error('Open this app from its Telegram bot to continue.');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !Number.isFinite(authDate)) throw new Error('Invalid Telegram session. Reopen the Mini App.');
  if (Math.abs(Date.now() / 1000 - authDate) > 86400) throw new Error('Telegram session expired. Reopen the Mini App.');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const botSecret = await crypto.subtle.sign('HMAC', secretKey, new TextEncoder().encode(botToken));
  const validationKey = await crypto.subtle.importKey('raw', botSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const calculated = hex(await crypto.subtle.sign('HMAC', validationKey, new TextEncoder().encode(dataCheckString)));
  if (!timingSafeEqual(calculated, hash)) throw new Error('Telegram session validation failed. Reopen the Mini App.');
  const userText = params.get('user');
  if (!userText) throw new Error('Telegram user information is missing.');
  let user;
  try { user = JSON.parse(userText); } catch { throw new Error('Telegram user information is invalid.'); }
  if (!user.id) throw new Error('Telegram user ID is missing.');
  return user;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
