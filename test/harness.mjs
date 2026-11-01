// Loads a real htmx (2 or 4), a fake pusher-js and the built script-tag file
// into jsdom, the way a page with three <script> tags would.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sources = {
  2: readFileSync(require.resolve('htmx.org/dist/htmx.js'), 'utf8'),
  4: readFileSync(require.resolve('htmx4/dist/htmx.js'), 'utf8'),
};
const extension = readFileSync(new URL('../dist/hibira.js', import.meta.url), 'utf8');

// A stand-in for the pusher-js constructor. Every instance lands in
// window.__clients so tests can emit channel events and check subscriptions.
const fakePusher = `
(() => {
  function emitter() {
    const handlers = new Map();
    return {
      handlers,
      bind(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); },
      unbind(ev, fn) { if (fn) handlers.get(ev)?.delete(fn); else handlers.delete(ev); },
      emit(ev, data) { for (const fn of [...(handlers.get(ev) ?? [])]) fn(data); },
      count(ev) { return handlers.get(ev)?.size ?? 0; },
    };
  }
  window.__clients = [];
  window.Pusher = class {
    constructor(key, options) {
      this.key = key; this.options = options; this.log = []; this.channels = new Map();
      this.connection = { state: 'connecting', ...emitter() };
      this.disconnected = false;
      window.__clients.push(this);
    }
    subscribe(name) {
      this.log.push(['subscribe', name]);
      let ch = this.channels.get(name);
      if (!ch) { ch = { name, ...emitter() }; this.channels.set(name, ch); }
      return ch;
    }
    unsubscribe(name) { this.log.push(['unsubscribe', name]); this.channels.delete(name); }
    channel(name) { return this.channels.get(name); }
    disconnect() { this.disconnected = true; }
    setState(current) { const previous = this.connection.state; this.connection.state = current; this.connection.emit('state_change', { previous, current }); }
  };
})();`;

// jsdom lacks CSS.escape, and its XPath requires the result type that browsers default to 0 (ANY).
const xpathDefaults = `(() => {
  const d = Document.prototype.evaluate;
  Document.prototype.evaluate = function (e, c, r, t, res) { return d.call(this, e, c, r ?? null, t ?? 0, res ?? null); };
  const x = XPathExpression.prototype.evaluate;
  XPathExpression.prototype.evaluate = function (c, t, r) { return x.call(this, c, t ?? 0, r ?? null); };
})();`;

export async function page(version, body, { head = '' } = {}) {
  // jsdom has no constructable stylesheets, which htmx 4 uses for indicator CSS.
  const meta = version === 4 ? `<meta name="htmx-config" content='{"includeIndicatorCSS": false}'>` : '';
  const dom = new JSDOM(`<!doctype html><html><head>${meta}${head}</head><body>${body}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://app.example.com/',
  });
  const { window } = dom;
  window.CSS ??= { escape: (v) => String(v).replace(/[^\w\u00A0-\uFFFF-]/g, (c) => `\\${c}`) };
  window.fetch = async () => new Response('', { status: 200 }); // jsdom has no fetch (htmx 4 uses it)
  window.eval(xpathDefaults);
  window.eval(sources[version]);
  window.eval(fakePusher);
  window.eval(extension);
  window.htmx.process(window.document.body);
  await tick(window);
  return {
    window,
    document: window.document,
    htmx: window.htmx,
    clients: window.__clients,
    $: (s) => window.document.querySelector(s),
    emit: async (channel, event, data, client = 0) => {
      window.__clients[client].channel(channel).emit(event, data);
      await tick(window, 30);
    },
    tick: (ms) => tick(window, ms),
    // Replaces an element's content through htmx, so htmx cleans up and processes it.
    replace: async (selector, html) => {
      const target = window.document.querySelector(selector);
      if (version === 4) await window.htmx.swap({ target, text: html, swap: 'innerHTML' });
      else window.htmx.swap(target, html, { swapStyle: 'innerHTML', swapDelay: 0, settleDelay: 0 });
      await tick(window, 30);
    },
    // Records requests htmx is about to send, and cancels them.
    requests: () => {
      const seen = [];
      const name = version === 4 ? 'htmx:before:request' : 'htmx:beforeRequest';
      window.document.addEventListener(name, (e) => {
        const ctx = e.detail.ctx;
        seen.push(ctx ? { path: ctx.request.action, elt: ctx.sourceElement } : { path: e.detail.requestConfig.path, elt: e.detail.elt });
        e.preventDefault();
      });
      return seen;
    },
    close: () => window.close(),
  };
}

export function tick(window, ms = 20) {
  return new Promise((r) => window.setTimeout(r, ms));
}

export const versions = [2, 4];
