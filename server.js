import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';

const env = process.env;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const q = (s, p) => pool.query(s, p).then(r => r.rows);
const ADMINS = (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const err = (status, message) => Object.assign(new Error(message), { status });
const up100 = n => Math.ceil(n / 100) * 100;

await pool.query(`
CREATE TABLE IF NOT EXISTS settings(k text PRIMARY KEY, v text NOT NULL);
CREATE TABLE IF NOT EXISTS users(tg_id bigint PRIMARY KEY, name text,
  balance_uzs bigint NOT NULL DEFAULT 0 CHECK (balance_uzs >= 0), created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS orders(id serial PRIMARY KEY, tg_id bigint NOT NULL, fazer_order_id text UNIQUE,
  title text, category_id text, offer_id text, fields jsonb, cost_usd numeric(12,4), price_uzs bigint,
  status text NOT NULL DEFAULT 'pending', idem uuid NOT NULL DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now());
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code text;
CREATE TABLE IF NOT EXISTS payments(id serial PRIMARY KEY, tg_id bigint NOT NULL, checkout_id bigint UNIQUE,
  amount_uzs bigint NOT NULL, url text, status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT now(), paid_at timestamptz);
CREATE TABLE IF NOT EXISTS folders(id serial PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK (kind IN ('discount','promo')));
CREATE TABLE IF NOT EXISTS discounts(id serial PRIMARY KEY, folder_id int REFERENCES folders ON DELETE SET NULL, name text,
  percent numeric(5,2) NOT NULL, category_id text, starts_at timestamptz, ends_at timestamptz, active boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS promos(id serial PRIMARY KEY, folder_id int REFERENCES folders ON DELETE SET NULL,
  code text UNIQUE NOT NULL, percent numeric(5,2) NOT NULL, max_uses int, used int NOT NULL DEFAULT 0,
  min_amount_uzs bigint NOT NULL DEFAULT 0, expires_at timestamptz, active boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS promo_uses(promo_id int, tg_id bigint, order_id int, UNIQUE(promo_id, tg_id));
CREATE TABLE IF NOT EXISTS markups(category_id text PRIMARY KEY, percent numeric(5,2) NOT NULL);
CREATE TABLE IF NOT EXISTS banners(id serial PRIMARY KEY, title text, image_url text NOT NULL, link text,
  sort int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, starts_at timestamptz, ends_at timestamptz);
CREATE TABLE IF NOT EXISTS products(kind text, category_id text, name text, image text, note text,
  custom_name text, custom_image text, hidden boolean NOT NULL DEFAULT false, gone boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0, synced_at timestamptz, PRIMARY KEY(kind, category_id));
`);

// ---------- settings: ALL provider keys live in DB, edited from admin panel ----------
const setting = async (k, d) => (await q('SELECT v FROM settings WHERE k=$1', [k]))[0]?.v ?? d;
const SETTING_KEYS = ['fazer_api_key', 'fazer_webhook_secret', 'checkout_api_key', 'usd_uzs_rate', 'markup_percent', 'public_url'];

// ---------- pricing: markup (global/per-category) -> auto discount -> promo, never below cost ----------
async function pricing() {
  const mk = new Map((await q('SELECT category_id, percent FROM markups')).map(r => [r.category_id, +r.percent]));
  const ds = await q(`SELECT category_id, percent FROM discounts WHERE active
    AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())`);
  return { rate: +(await setting('usd_uzs_rate', 12800)), m: +(await setting('markup_percent', 10)), mk, ds };
}
function price(usd, p, cat) {
  const base = up100(usd * p.rate * (1 + (p.mk.get(cat) ?? p.m) / 100));
  const d = Math.max(0, ...p.ds.filter(x => !x.category_id || x.category_id === cat).map(x => +x.percent));
  const cost = up100(usd * p.rate);
  return { base, cost, sale: Math.max(cost, up100(base * (1 - d / 100))) };
}
// replace wholesale price_usd with retail price_uzs (+ old_price_uzs when discounted); cost never leaves server
const strip = (o, p, cat) =>
  Array.isArray(o) ? o.map(x => strip(x, p, cat))
  : o && typeof o === 'object'
    ? Object.fromEntries(Object.entries(o).flatMap(([k, v]) => {
        if (k !== 'price_usd') return [[k, strip(v, p, cat)]];
        const r = price(+v, p, cat);
        return [['price_uzs', r.sale], ...(r.sale < r.base ? [['old_price_uzs', r.base]] : [])];
      }))
    : o;

// ---------- Fazer client ----------
async function fazer(method, path, { body, idem } = {}, retry = true) {
  const key = await setting('fazer_api_key', env.FAZER_API_KEY);
  if (!key) throw err(503, 'Fazer key not set');
  const r = await fetch((env.FAZER_BASE || 'https://api.fzr.cards/api/v2') + path, {
    method,
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json', ...(idem && { 'Idempotency-Key': idem }) },
    body: body && JSON.stringify(body),
  });
  if (r.status === 429 && retry) {
    await sleep((+r.headers.get('retry-after') || 1) * 1000 * (0.85 + Math.random() * 0.3));
    return fazer(method, path, { body, idem }, false);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw err(r.status, j.error || 'Provider error');
  return j;
}
const cache = new Map();
const cached = async path => {
  const c = cache.get(path);
  if (c && c.t > Date.now()) return c.v;
  const v = await fazer('GET', path);
  cache.set(path, { v, t: Date.now() + 600e3 });
  return v;
};

// ---------- checkout.uz client (https://checkout.uz/api/v1, Bearer key, all POST) ----------
async function checkout(path, body) {
  const key = await setting('checkout_api_key');
  if (!key) throw err(503, 'checkout.uz key not set');
  const r = await fetch((env.CHECKOUT_BASE || 'https://checkout.uz/api/v1') + path, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 'success') throw err(r.ok ? 502 : r.status, j.message || j.error || 'Payment provider error');
  return j;
}
async function whToken() {
  let t = await setting('checkout_webhook_token');
  if (!t) {
    await q("INSERT INTO settings VALUES('checkout_webhook_token',$1) ON CONFLICT DO NOTHING", [crypto.randomBytes(16).toString('hex')]);
    t = await setting('checkout_webhook_token');
  }
  return t;
}
// webhook has no signature in checkout.uz docs -> never trust it: re-check status via API, then credit once
async function settle(checkoutId) {
  const [p] = await q('SELECT * FROM payments WHERE checkout_id=$1', [checkoutId]);
  if (!p || p.status !== 'pending') return p;
  const s = (await checkout('/status_payment', { id: Number(checkoutId) })).data;
  if (s?.status !== 'paid') return p;
  if (+s.amount !== +p.amount_uzs) { await q("UPDATE payments SET status='review' WHERE id=$1", [p.id]); return p; }
  const [done] = await q("UPDATE payments SET status='paid', paid_at=now() WHERE id=$1 AND status='pending' RETURNING tg_id, amount_uzs", [p.id]);
  if (done) await q('UPDATE users SET balance_uzs=balance_uzs+$2 WHERE tg_id=$1', [done.tg_id, done.amount_uzs]);
  return { ...p, status: 'paid' };
}
// checkout.uz does not retry failed webhooks -> reconcile pending payments every minute
setInterval(async () => {
  try { for (const p of await q("SELECT checkout_id FROM payments WHERE status='pending' AND created_at>now()-interval '2 hours'")) await settle(p.checkout_id); }
  catch (e) { console.error('reconcile:', e.message); }
}, 60e3);

// ---------- auto-import of product cards from Fazer ----------
const KINDS = [['topups', '/topups'], ['giftcards', '/giftcards'], ['gamekeys', '/gamekeys']];
async function syncProducts() {
  let n = 0;
  for (const [kind, path] of KINDS) {
    const started = new Date(); let cursor = null;
    do {
      const qs = new URLSearchParams({ limit: '100', include_ui: 'true' }); if (cursor) qs.set('cursor', cursor);
      const r = await fazer('GET', `${path}?${qs}`);
      for (const c of r.items || []) {
        const id = c.category_id || c.game_id; if (!id) continue;
        await q(`INSERT INTO products(kind,category_id,name,image,note,synced_at) VALUES($1,$2,$3,$4,$5,now())
          ON CONFLICT(kind,category_id) DO UPDATE SET name=EXCLUDED.name, image=EXCLUDED.image, note=EXCLUDED.note, gone=false, synced_at=now()`,
          [kind, id, c.name, c.image || c.image_url || c.cover || c.icon || null, c.note || null]);
        n++;
      }
      cursor = r.meta?.has_more ? r.meta.next_cursor : null;
      await sleep(600);
    } while (cursor);
    await q('UPDATE products SET gone=true WHERE kind=$1 AND synced_at<$2', [kind, started]);
  }
  return n;
}
const autoSync = async () => { if (await setting('fazer_api_key', env.FAZER_API_KEY)) await syncProducts(); };
setTimeout(() => autoSync().catch(e => console.error('sync:', e.message)), 5000);
setInterval(() => autoSync().catch(e => console.error('sync:', e.message)), 30 * 60e3);

// ---------- Telegram auth ----------
function tgUser(req) {
  const p = new URLSearchParams(req.get('x-init-data') || '');
  const hash = p.get('hash'); p.delete('hash');
  if (!hash) return null;
  const data = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  if (!safeEq(crypto.createHmac('sha256', secret).update(data).digest('hex'), hash)) return null;
  if (Date.now() / 1000 - +p.get('auth_date') > 86400) return null;
  return JSON.parse(p.get('user'));
}
const auth = async (req, res, next) => {
  const u = tgUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  await q('INSERT INTO users(tg_id,name) VALUES($1,$2) ON CONFLICT(tg_id) DO UPDATE SET name=$2', [u.id, u.first_name]);
  req.user = u; next();
};
const admin = (req, res, next) => (ADMINS.includes(String(req.user.id)) ? next() : res.sendStatus(403));
const A = [auth, admin];
const h = fn => (req, res, next) => fn(req, res, next).catch(e => {
  const s = e.status || 500, hide = s === 401 || s === 403;
  res.status(hide ? 502 : s).json({ ok: false, error: hide ? 'Provider unavailable' : e.message });
});

// ---------- orders, promo ----------
const ORDER = {
  topups:    { list: '/topups/offers',   param: 'category_id', arr: 'offers', idf: 'offer_id', order: '/topups/order',    body: (c, i, n, f) => ({ category_id: c, offer_id: i, fields: f }) },
  giftcards: { list: '/giftcards/cards', param: 'category_id', arr: 'offers', idf: 'card_id',  order: '/giftcards/order', body: (c, i, n) => ({ category_id: c, card_id: i, quantity: n }) },
  gamekeys:  { list: '/gamekeys/keys',   param: 'game_id',     arr: 'keys',   idf: 'key_id',   order: '/gamekeys/order',  body: (c, i, n) => ({ game_id: c, key_id: i, quantity: n }) },
};
async function quote(sec, cat, itemId, qty, code, tg) {
  const S = ORDER[sec]; if (!S) throw err(404, 'Unknown section');
  const data = await cached(`${S.list}?${S.param}=${encodeURIComponent(cat)}`);
  const offer = data[S.arr]?.find(o => o[S.idf] === itemId);
  if (!offer) throw err(404, 'Offer not found');
  qty = sec === 'topups' ? 1 : Math.trunc(+qty || 1);
  if (qty < (offer.min_order_quantity || 1) || qty > (offer.max_order_quantity || 100)) throw err(400, "Miqdor noto'g'ri");
  const u = price(+offer.price_usd, await pricing(), cat);
  const pr = { base: u.base * qty, cost: u.cost * qty, sale: u.sale * qty };
  let promo = null, final = pr.sale;
  if (code) {
    [promo] = await q(`SELECT * FROM promos WHERE code=$1 AND active AND (expires_at IS NULL OR expires_at>now())
      AND (max_uses IS NULL OR used<max_uses)`, [String(code).trim().toUpperCase()]);
    if (!promo || pr.sale < promo.min_amount_uzs) throw err(400, 'Promo kod yaroqsiz');
    if ((await q('SELECT 1 FROM promo_uses WHERE promo_id=$1 AND tg_id=$2', [promo.id, tg]))[0]) throw err(400, 'Promo kod ishlatilgan');
    final = Math.max(pr.cost, up100(pr.sale * (1 - promo.percent / 100)));
  }
  return { data, offer, promo, qty, ...pr, final };
}
async function claimPromo(promo, tg, orderId) {
  const [c] = await q('UPDATE promos SET used=used+1 WHERE id=$1 AND (max_uses IS NULL OR used<max_uses) RETURNING id', [promo.id]);
  if (!c) return false;
  try { await q('INSERT INTO promo_uses VALUES($1,$2,$3)', [promo.id, tg, orderId]); return true; }
  catch { await q('UPDATE promos SET used=used-1 WHERE id=$1', [promo.id]); return false; }
}
const refund = async (where, val) => {
  const [o] = await q(`UPDATE orders SET status='failed' WHERE ${where}=$1 AND status NOT IN ('failed','completed') RETURNING id, tg_id, price_uzs`, [val]);
  if (!o) return;
  await q('UPDATE users SET balance_uzs=balance_uzs+$2 WHERE tg_id=$1', [o.tg_id, o.price_uzs]);
  const [u] = await q('DELETE FROM promo_uses WHERE order_id=$1 RETURNING promo_id', [o.id]);
  if (u) await q('UPDATE promos SET used=GREATEST(used-1,0) WHERE id=$1', [u.promo_id]);
};

const DONE = ['completed', 'success', 'delivered'], FAIL = ['failed', 'cancelled', 'canceled', 'rejected', 'refunded'];
const clean = o => Array.isArray(o) ? o.map(clean) : o && typeof o === 'object'
  ? Object.fromEntries(Object.entries(o).filter(([k]) => !/price|cost|usd|amount|balance/i.test(k)).map(([k, v]) => [k, clean(v)])) : o;

const app = express();

// Fazer webhook (raw body for HMAC-SHA256 hex in X-FazerCards-Signature)
app.post('/webhooks/fazer', express.raw({ type: '*/*' }), h(async (req, res) => {
  const secret = await setting('fazer_webhook_secret', env.FAZER_WEBHOOK_SECRET);
  const calc = crypto.createHmac('sha256', secret || '').update(req.body).digest('hex');
  if (!secret || !safeEq(req.get('x-fazercards-signature') || '', calc)) return res.sendStatus(401);
  const p = JSON.parse(req.body), o = p.order || p.data || p;
  const fid = o.id || o.order_id, st = String(o.status || '').toLowerCase();
  if (DONE.includes(st)) await q("UPDATE orders SET status='completed' WHERE fazer_order_id=$1 AND status<>'failed'", [fid]);
  else if (FAIL.includes(st)) await refund('fazer_order_id', fid);
  res.sendStatus(200);
}));

app.use(express.json());
app.use(express.static('public')); // Nova files + admin.html

// checkout.uz webhook: secret token in URL + server-side status re-check
app.post('/webhooks/checkout', h(async (req, res) => {
  if (!safeEq(String(req.query.t || ''), await whToken())) return res.sendStatus(401);
  const id = req.body?.data?.order_id;
  if (req.body?.event === 'payment_confirmed' && id) await settle(id);
  res.sendStatus(200);
}));

// ---------- user API ----------
const SECTIONS = Object.fromEntries(Object.entries(ORDER).map(([k, v]) => [k, { items: v.list, param: v.param }]));
const cats = kind => q(`SELECT category_id AS id, COALESCE(custom_name,name) AS name, COALESCE(custom_image,image) AS image, note
  FROM products WHERE kind=$1 AND NOT hidden AND NOT gone ORDER BY sort, name`, [kind]);

app.get('/api/home', auth, h(async (req, res) => {
  const banners = await q(`SELECT id,title,image_url,link FROM banners WHERE active
    AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now()) ORDER BY sort,id`);
  res.json({ ok: true, banners, topups: await cats('topups'),   // game top-ups = main section
    sections: [{ key: 'giftcards', title: 'Gift kartalar' }, { key: 'gamekeys', title: "O'yin kalitlari" }, { key: 'premium', title: 'Telegram Premium' }] });
}));
app.get('/api/catalog/:s', auth, h(async (req, res) =>
  SECTIONS[req.params.s] ? res.json({ ok: true, items: await cats(req.params.s) }) : res.sendStatus(404)));
app.get('/api/catalog/:s/:id', auth, h(async (req, res) => {
  const s = SECTIONS[req.params.s]; if (!s) return res.sendStatus(404);
  const data = await cached(`${s.items}?${s.param}=${encodeURIComponent(req.params.id)}`);
  res.json(strip(data, await pricing(), req.params.id));
}));
app.get('/api/premium', auth, h(async (req, res) => res.json(strip(await cached('/telegram/premium'), await pricing(), 'premium'))));

app.get('/api/me', auth, h(async (req, res) => {
  const [u] = await q('SELECT tg_id, name, balance_uzs FROM users WHERE tg_id=$1', [req.user.id]);
  res.json({ ok: true, user: u, is_admin: ADMINS.includes(String(req.user.id)) });
}));
app.get('/api/orders', auth, h(async (req, res) =>
  res.json({ ok: true, items: await q('SELECT id,title,price_uzs,status,created_at FROM orders WHERE tg_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]) })));

app.post('/api/promo/check', auth, h(async (req, res) => {
  const { section, id, item, quantity, code } = req.body;
  const z = await quote(section, id, item, quantity, code, req.user.id);
  res.json({ ok: true, price_uzs: z.final, percent: +z.promo.percent });
}));

// one endpoint for game top-ups, gift cards and game keys
app.post('/api/orders', auth, h(async (req, res) => {
  const { section, id, item, fields, quantity, promo } = req.body;
  const S = ORDER[section];
  if (!S || !id || !item || (section === 'topups' && (!fields || typeof fields !== 'object'))) throw err(400, 'Bad request');
  const z = await quote(section, id, item, quantity, promo, req.user.id);
  const [u] = await q('UPDATE users SET balance_uzs=balance_uzs-$2 WHERE tg_id=$1 AND balance_uzs>=$2 RETURNING balance_uzs', [req.user.id, z.final]);
  if (!u) throw err(402, 'Balans yetarli emas');
  const [o] = await q(`INSERT INTO orders(tg_id,title,category_id,offer_id,fields,cost_usd,price_uzs,promo_code)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, idem`,
    [req.user.id, `${z.data.name || z.data.GameName} — ${z.offer.name}${z.qty > 1 ? ' ×' + z.qty : ''}`, id, item, fields || {},
     z.offer.price_usd * z.qty, z.final, z.promo?.code || null]);
  if (z.promo && !(await claimPromo(z.promo, req.user.id, o.id))) { await refund('id', o.id); throw err(409, 'Promo kod ishlatilgan'); }
  try {
    const r = await fazer('POST', S.order, { body: S.body(id, item, z.qty, fields), idem: o.idem });
    await q('UPDATE orders SET fazer_order_id=$2, status=$3 WHERE id=$1', [o.id, r.order.id, r.order.status]);
    res.json({ ok: true, order_id: o.id, status: r.order.status, balance_uzs: u.balance_uzs });
  } catch (e) { // definite rejection -> refund; unclear (5xx/timeout/409) -> money held, admin reviews
    if (e.status >= 400 && e.status < 500 && e.status !== 409) await refund('id', o.id);
    else await q("UPDATE orders SET status='review' WHERE id=$1", [o.id]);
    throw e;
  }
}));
// order detail + delivery (codes/keys) straight from Fazer, cost fields stripped; also syncs a missed webhook
app.get('/api/orders/:id', auth, h(async (req, res) => {
  const [o] = await q('SELECT id,title,price_uzs,status,fazer_order_id FROM orders WHERE id=$1 AND tg_id=$2', [req.params.id, req.user.id]);
  if (!o) return res.sendStatus(404);
  let delivery = null, status = o.status;
  if (o.fazer_order_id) try {
    delivery = (await fazer('GET', `/orders/${o.fazer_order_id}`)).order;
    const st = String(delivery?.status || '').toLowerCase();
    if (DONE.includes(st) && status === 'processing') { status = 'completed'; await q("UPDATE orders SET status='completed' WHERE id=$1", [o.id]); }
    else if (FAIL.includes(st)) { await refund('id', o.id); status = 'failed'; }
  } catch { /* provider hiccup: show what we have */ }
  res.json({ ok: true, order: { id: o.id, title: o.title, price_uzs: o.price_uzs, status }, delivery: clean(delivery) });
}));

// balance top-up via checkout.uz (1000..10 000 000 so'm)
app.post('/api/topup', auth, h(async (req, res) => {
  const amount = Math.trunc(+req.body.amount);
  if (!(amount >= 1000 && amount <= 10_000_000)) throw err(400, "Summa 1 000 – 10 000 000 so'm");
  const base = await setting('public_url', env.PUBLIC_URL);
  if (!base) th
