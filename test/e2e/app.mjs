// A small order board served by plain Node: the server renders HTML
// fragments and publishes them with the `pusher` server library. Used by the
// browser test and for the README screenshots.
//
//   HIBIRA_E2E_HOST=127.0.0.1 HIBIRA_E2E_PORT=6001 HIBIRA_E2E_TLS=0 \
//   HIBIRA_E2E_APP_ID=... HIBIRA_E2E_KEY=... HIBIRA_E2E_SECRET=... node test/e2e/app.mjs
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import PusherServer from 'pusher';

const require = createRequire(import.meta.url);
const asset = (p) => readFileSync(p, 'utf8');
const assets = {
  '/assets/htmx2.js': () => asset(require.resolve('htmx.org/dist/htmx.min.js')),
  '/assets/htmx4.js': () => asset(require.resolve('htmx4/dist/htmx.min.js')),
  '/assets/pusher.js': () => asset(require.resolve('pusher-js/dist/web/pusher.min.js')),
  '/assets/hibira.js': () => asset(fileURLToPath(new URL('../../dist/hibira.min.js', import.meta.url))),
};
const CSRF = 'demo-csrf-token';

export function startApp({ appId, key, secret, host, port, tls = false, listen = 0 }) {
  const pusher = new PusherServer({ appId, key, secret, host, port: String(port), useTLS: tls });
  const orders = [
    { id: 1, item: 'Matcha latte ×2', table: 'Table 4', status: 'ready' },
    { id: 2, item: 'Katsu sando', table: 'Table 7', status: 'preparing' },
  ];
  let nextId = 3;
  const options = JSON.stringify({ wsHost: host, wsPort: port, wssPort: port, forceTLS: tls, enabledTransports: ['ws'] });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    try {
      if (assets[url.pathname]) return send(200, assets[url.pathname](), 'text/javascript');
      if (req.method === 'GET' && url.pathname === '/') {
        const v = url.searchParams.get('htmx') === '4' ? 4 : 2;
        const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
        return send(200, page({ v, key, options, orders, theme }));
      }
      if (req.method === 'GET' && url.pathname === '/stats') return send(200, stats(orders));
      if (req.method === 'POST' && url.pathname === '/orders') {
        const form = new URLSearchParams(await body(req));
        const order = { id: nextId++, item: form.get('item') || 'Hojicha', table: form.get('table') || 'Table 1', status: 'new' };
        orders.unshift(order);
        // One message: the new row for the list, the count out of band.
        await pusher.trigger('orders', 'order-created', `${row(order)}${count(orders, true)}`);
        await pusher.trigger('private-kitchen', 'stats-changed', { at: Date.now() });
        res.writeHead(204).end();
        return;
      }
      const ship = url.pathname.match(/^\/orders\/(\d+)\/ready$/);
      if (req.method === 'POST' && ship) {
        const order = orders.find((o) => o.id === Number(ship[1]));
        if (!order) return send(404, 'not found');
        order.status = 'ready';
        // The server picks the target and swap style for this message.
        await pusher.trigger('orders', 'order-updated', { html: row(order), target: `#order-${order.id}`, swap: 'outerHTML' });
        await pusher.trigger('private-kitchen', 'stats-changed', { at: Date.now() });
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/broadcasting/auth') {
        if (req.headers['x-csrf-token'] !== CSRF) return send(403, 'bad csrf', 'text/plain');
        const form = new URLSearchParams(await body(req));
        const auth = pusher.authorizeChannel(form.get('socket_id'), form.get('channel_name'));
        return send(200, JSON.stringify(auth), 'application/json');
      }
      send(404, 'not found', 'text/plain');
    } catch (err) {
      send(500, String(err), 'text/plain');
    }
  });

  return new Promise((resolve) => {
    server.listen(listen, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({ url: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function row(o) {
  const ready = o.status === 'ready';
  return `<li id="order-${o.id}" class="order ${esc(o.status)}">
  <span class="num">#${o.id}</span>
  <span class="what"><b>${esc(o.item)}</b><small>${esc(o.table)}</small></span>
  <span class="badge">${ready ? 'Ready' : o.status === 'new' ? 'New' : 'Preparing'}</span>
  ${ready ? '' : `<button hx-post="/orders/${o.id}/ready" hx-swap="none" aria-label="Mark #${o.id} ready">Mark ready</button>`}
</li>`;
}

function count(orders, oob = false) {
  return `<span id="open-count"${oob ? ' hx-swap-oob="true"' : ''}>${orders.filter((o) => o.status !== 'ready').length}</span>`;
}

function stats(orders) {
  const ready = orders.filter((o) => o.status === 'ready').length;
  return `<b>${ready}</b> ready · <b>${orders.length - ready}</b> in the kitchen`;
}

function page({ v, key, options, orders, theme }) {
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Order board · htmx ${v} + Hibira</title>
<style>
  :root { --bg:#f6f7fb; --card:#fff; --ink:#151a2d; --muted:#667085; --line:#e4e7ef; --brand:#4f46e5; --ok:#0f9d58; --new:#d97706; }
  [data-theme=dark] { --bg:#0d1020; --card:#161a2e; --ink:#eef0f8; --muted:#9aa3b8; --line:#272d48; --brand:#8b84ff; --ok:#34d399; --new:#fbbf24; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:720px; margin:0 auto; padding:28px 16px 40px; }
  header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:18px; }
  h1 { font-size:22px; margin:0; flex:1; }
  .live { font-size:13px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  .live::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--muted); }
  main[hibira-state=connected] .live::before { background:var(--ok); box-shadow:0 0 0 4px color-mix(in srgb, var(--ok) 20%, transparent); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; }
  .stats { display:flex; justify-content:space-between; gap:12px; color:var(--muted); font-size:14px; flex-wrap:wrap; }
  .stats b { color:var(--ink); }
  form { display:flex; gap:8px; flex-wrap:wrap; }
  input { flex:1; min-width:140px; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--bg); color:var(--ink); font:inherit; }
  button { padding:9px 14px; border-radius:10px; border:0; background:var(--brand); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  ul { list-style:none; margin:0; padding:0; }
  .order { display:flex; align-items:center; gap:12px; padding:12px 4px; border-top:1px solid var(--line); }
  .order:first-child { border-top:0; }
  .num { color:var(--muted); font-variant-numeric:tabular-nums; width:34px; }
  .what { flex:1; display:flex; flex-direction:column; }
  .what small { color:var(--muted); }
  .badge { font-size:12px; font-weight:600; padding:3px 9px; border-radius:99px; border:1px solid currentColor; }
  .new .badge { color:var(--new); } .preparing .badge { color:var(--muted); } .ready .badge { color:var(--ok); }
  .order button { padding:6px 10px; font-size:13px; background:transparent; color:var(--brand); border:1px solid var(--line); }
  .order.htmx-added { animation:pop .6s ease-out; }
  @keyframes pop { from { background:color-mix(in srgb, var(--brand) 14%, transparent); } }
  .foot { color:var(--muted); font-size:12px; text-align:center; }
</style>
<script src="/assets/htmx${v}.js"></script>
<script src="/assets/pusher.js"></script>
<script src="/assets/hibira.js"></script>
</head>
<body hx-headers='{"X-CSRF-Token": "${CSRF}"}'>
<main hx-ext="hibira" hibira-connect="${esc(key)}" hibira-auth-endpoint="/broadcasting/auth" hibira-options='${esc(options)}'>
  <header>
    <h1>Orders <small style="color:var(--muted);font-weight:500">(<span id="open-count">${orders.filter((o) => o.status !== 'ready').length}</span> open)</small></h1>
    <span class="live">Live</span>
  </header>
  <div class="card stats">
    <span id="stats" hibira-channel="private-kitchen" hx-get="/stats" hx-trigger="hibira:stats-changed">${stats(orders)}</span>
    <span>htmx ${v} · hx-ext="hibira"</span>
  </div>
  <div class="card">
    <form hx-post="/orders" hx-swap="none" hx-on::after-request="this.reset()" hx-on::after:request="this.reset()">
      <input name="item" placeholder="What was ordered?" aria-label="Item" required>
      <input name="table" placeholder="Table" aria-label="Table" style="max-width:120px">
      <button>Add order</button>
    </form>
  </div>
  <div class="card">
    <ul id="orders" hibira-channel="orders" hibira-swap="order-created, order-updated" hx-swap="afterbegin">
      ${orders.map(row).join('')}
    </ul>
  </div>
  <p class="foot">Every open tab updates as orders come in. The server sends HTML; the page has no app JavaScript.</p>
</main>
</body>
</html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const app = await startApp({
    appId: env.HIBIRA_E2E_APP_ID,
    key: env.HIBIRA_E2E_KEY,
    secret: env.HIBIRA_E2E_SECRET,
    host: env.HIBIRA_E2E_HOST ?? '127.0.0.1',
    port: Number(env.HIBIRA_E2E_PORT ?? 6001),
    tls: env.HIBIRA_E2E_TLS === '1',
    listen: Number(env.PORT ?? 3000),
  });
  console.log(`order board on ${app.url}  (?htmx=4 for htmx 4, &theme=dark)`);
}
