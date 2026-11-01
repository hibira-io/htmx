import { test } from 'node:test';
import assert from 'node:assert/strict';
import { page, versions } from './harness.mjs';

// htmx 2 needs hx-ext on an ancestor; htmx 4 ignores it.
// Values from the jsdom realm, compared as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));
const clean = (html) => html.replace(/ class="htmx-[a-z]+"/g, '');

const shell = (inner, attrs = '') =>
  `<main hx-ext="hibira" hibira-connect="app-key" ${attrs}>${inner}</main>`;

for (const v of versions) {
  test(`[htmx ${v}] swaps HTML strings and {html} objects with hx-swap`, async () => {
    const p = await page(v, shell(`<ul id="list" hibira-channel="orders" hibira-swap="order-created" hx-swap="beforeend"></ul>`));
    assert.equal(p.clients.length, 1);
    assert.equal(p.clients[0].key, 'app-key');
    assert.deepEqual(plain(p.clients[0].log), [['subscribe', 'orders']]);
    await p.emit('orders', 'order-created', '<li>A</li>');
    await p.emit('orders', 'order-created', { html: '<li>B</li>' });
    await p.emit('orders', 'order-created', { content: '<li>C</li>' });
    await p.emit('orders', 'order-created', { id: 7 }); // data only: no swap
    assert.deepEqual([...p.document.querySelectorAll('#list li')].map((li) => li.textContent), ['A', 'B', 'C']);
    p.close();
  });

  test(`[htmx ${v}] defaults: Hibira host, TLS, ws transports`, async () => {
    const p = await page(v, shell(`<div hibira-channel="c" hibira-swap="e"></div>`));
    const o = p.clients[0].options;
    assert.equal(o.wsHost, 'ws.hibira.io');
    assert.equal(o.forceTLS, true);
    assert.deepEqual(plain(o.enabledTransports), ['ws', 'wss']);
    p.close();
  });

  test(`[htmx ${v}] hibira-channel is inherited and hx-target is honoured`, async () => {
    const p = await page(
      v,
      shell(`<section hibira-channel="dash">
        <div id="src" hibira-swap="stats" hx-target="#out" hx-swap="innerHTML"></div>
        <div id="out">old</div>
      </section>`),
    );
    await p.emit('dash', 'stats', '<b>42</b>');
    assert.equal(clean(p.$('#out').innerHTML), '<b>42</b>');
    assert.equal(p.$('#src').innerHTML, '');
    p.close();
  });

  test(`[htmx ${v}] the server can pick target and swap per message`, async () => {
    const p = await page(v, shell(`<div hibira-channel="feed" hibira-swap="news"></div><ol id="a"><li>1</li></ol>`));
    await p.emit('feed', 'news', { html: '<li>0</li>', target: '#a', swap: 'afterbegin' });
    assert.deepEqual([...p.document.querySelectorAll('#a li')].map((li) => li.textContent), ['0', '1']);
    p.close();
  });

  test(`[htmx ${v}] out-of-band swaps in a message update other elements`, async () => {
    const p = await page(v, shell(`<ul id="list" hibira-channel="o" hibira-swap="created" hx-swap="beforeend"></ul><span id="count">0</span>`));
    await p.emit('o', 'created', '<li>A</li><span id="count" hx-swap-oob="true">1</span>');
    assert.equal(clean(p.$('#list').innerHTML), '<li>A</li>');
    assert.equal(p.$('#count').textContent, '1');
    p.close();
  });

  test(`[htmx ${v}] hx-trigger="hibira:event" runs the element's own request`, async () => {
    const p = await page(v, shell(`<div id="cart" hibira-channel="private-cart-1" hx-get="/cart" hx-trigger="hibira:cart-changed"></div>`));
    const seen = p.requests();
    const events = [];
    p.$('#cart').addEventListener('hibira:cart-changed', (e) => events.push(e.detail));
    await p.emit('private-cart-1', 'cart-changed', { items: 3 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/cart');
    assert.deepEqual(plain(events), [{ channel: 'private-cart-1', event: 'cart-changed', data: { items: 3 } }]);
    p.close();
  });

  test(`[htmx ${v}] client events never swap HTML`, async () => {
    const p = await page(v, shell(`<div id="x" hibira-channel="private-room" hibira-swap="client-typing, msg"></div>`));
    const errors = [];
    p.document.addEventListener('hibira:error', (e) => (errors.push(e.detail.error.message), e.preventDefault()));
    await p.replace('main', `<div id="x" hibira-channel="private-room" hibira-swap="client-typing, msg"></div>`);
    assert.ok(errors.some((m) => m.includes('client-typing')));
    const ch = p.clients[0].channel('private-room');
    assert.equal(ch.count('client-typing'), 0);
    assert.equal(ch.count('msg'), 1);
    p.close();
  });

  test(`[htmx ${v}] hibira:before-swap can cancel or rewrite a swap`, async () => {
    const p = await page(v, shell(`<div id="x" hibira-channel="c" hibira-swap="e"></div>`));
    p.$('#x').addEventListener('hibira:before-swap', (e) => {
      if (e.detail.data === 'skip') e.preventDefault();
      else e.detail.message.html = e.detail.message.html.toUpperCase();
    });
    const after = [];
    p.$('#x').addEventListener('hibira:after-swap', (e) => after.push(e.detail.event));
    await p.emit('c', 'e', 'skip');
    assert.equal(p.$('#x').innerHTML, '');
    await p.emit('c', 'e', '<i>ok</i>');
    assert.equal(clean(p.$('#x').innerHTML), '<i>OK</i>');
    assert.deepEqual(plain(after), ['e']);
    p.close();
  });

  test(`[htmx ${v}] rapid messages swap in order`, async () => {
    const p = await page(v, shell(`<ul id="l" hibira-channel="c" hibira-swap="e" hx-swap="beforeend"></ul>`));
    const ch = p.clients[0].channel('c');
    for (let i = 0; i < 20; i++) ch.emit('e', `<li>${i}</li>`);
    await p.tick(100);
    assert.deepEqual([...p.document.querySelectorAll('#l li')].map((li) => +li.textContent), [...Array(20).keys()]);
    p.close();
  });

  test(`[htmx ${v}] one subscription per channel, left when the last element goes`, async () => {
    const p = await page(
      v,
      shell(`<div id="box"><p hibira-channel="news" hibira-swap="a"></p><p hibira-channel="news" hibira-swap="b"></p></div><p id="keep" hibira-channel="other" hibira-swap="a"></p>`),
    );
    const c = p.clients[0];
    assert.deepEqual(plain(c.log), [['subscribe', 'news'], ['subscribe', 'other']]);
    await p.replace('#box', `<p hibira-channel="news" hibira-swap="a"></p>`);
    assert.deepEqual(plain(c.log.slice(2)), []);
    assert.equal(c.channel('news').count('b'), 0);
    assert.equal(c.channel('news').count('a'), 1);
    await p.replace('#box', '');
    assert.deepEqual(plain(c.log.slice(2)), []); // left after a short grace period
    await p.tick(150);
    assert.deepEqual(plain(c.log.slice(2)), [['unsubscribe', 'news']]);
    p.close();
  });

  test(`[htmx ${v}] content swapped in later is bound too`, async () => {
    const p = await page(v, shell(`<div id="slot"></div>`));
    await p.replace('#slot', `<div id="late" hibira-channel="c" hibira-swap="e"></div>`);
    await p.emit('c', 'e', 'hello');
    assert.equal(clean(p.$('#late').innerHTML), 'hello');
    p.close();
  });

  test(`[htmx ${v}] connection state is reflected on the connect element`, async () => {
    const p = await page(v, `<div id="wrap">${shell(`<div hibira-channel="c" hibira-swap="e"></div>`)}</div>`);
    const main = p.$('main');
    assert.equal(main.getAttribute('hibira-state'), 'connecting');
    const states = [];
    main.addEventListener('hibira:state', (e) => states.push(e.detail.state));
    p.clients[0].setState('connected');
    p.clients[0].setState('unavailable');
    assert.equal(main.getAttribute('hibira-state'), 'unavailable');
    assert.deepEqual(plain(states), ['connected', 'unavailable']);
    await p.replace('#wrap', '');
    assert.equal(p.clients[0].disconnected, true);
    p.close();
  });

  test(`[htmx ${v}] auth endpoint, hx-headers and hibira-options reach pusher-js`, async () => {
    const p = await page(
      v,
      `<div hx-headers='{"X-CSRF-Token": "outer", "X-App": "1"}'>
        <main hx-ext="hibira" hibira-connect="k" hibira-auth-endpoint="/broadcasting/auth"
              hx-headers='{"X-CSRF-Token": "tok"}' hibira-options='{"wsHost": "127.0.0.1", "wsPort": 6001, "forceTLS": false}'>
          <div hibira-channel="private-x" hibira-swap="e"></div>
        </main>
      </div>`,
    );
    const o = p.clients[0].options;
    assert.equal(o.wsHost, '127.0.0.1');
    assert.equal(o.wsPort, 6001);
    assert.equal(o.forceTLS, false);
    assert.deepEqual(plain(o.channelAuthorization), {
      transport: 'ajax',
      endpoint: '/broadcasting/auth',
      headers: { 'X-CSRF-Token': 'tok', 'X-App': '1' },
    });
    p.close();
  });

  test(`[htmx ${v}] data- prefixed attributes work`, async () => {
    const p = await page(v, `<main data-hx-ext="hibira" data-hibira-connect="k"><div id="x" data-hibira-channel="c" data-hibira-swap="e"></div></main>`);
    await p.emit('c', 'e', 'hi');
    assert.equal(p.$('#x').innerHTML, 'hi');
    p.close();
  });

  test(`[htmx ${v}] reuses a client set with configure() or Laravel Echo`, async () => {
    const p = await page(v, `<main hx-ext="hibira"><div id="x" hibira-channel="c" hibira-swap="e"></div></main>`, {});
    // No hibira-connect yet: nothing to bind to, and an error explains why.
    assert.equal(p.clients.length, 0);
    const errors = [];
    p.document.addEventListener('hibira:error', (e) => (errors.push(e.detail.error.message), e.preventDefault()));
    const echo = new p.window.Pusher('echo-key', {});
    p.window.Echo = { connector: { pusher: echo } };
    await p.replace('main', `<div id="y" hibira-channel="c" hibira-swap="e"></div>`);
    await p.emit('c', 'e', 'via echo');
    assert.equal(p.$('#y').innerHTML, 'via echo');
    const own = new p.window.Pusher('own', {});
    p.window.HibiraHtmx.configure({ client: own });
    await p.replace('main', `<div id="z" hibira-channel="d" hibira-swap="e"></div>`);
    assert.deepEqual(plain(own.log), [['subscribe', 'd']]);
    assert.equal(errors.length, 0);
    p.close();
  });

  test(`[htmx ${v}] a missing hibira-channel is reported`, async () => {
    const p = await page(v, shell(`<div id="slot"></div>`));
    const errors = [];
    p.document.addEventListener('hibira:error', (e) => (errors.push(e.detail.error.message), e.preventDefault()));
    await p.replace('#slot', `<div hibira-swap="e"></div>`);
    assert.match(errors[0], /no hibira-channel/);
    p.close();
  });
}
