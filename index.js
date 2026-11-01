// hx-ext="hibira": live HTML swaps over Hibira (or any Pusher-compatible)
// channels for htmx 2 and htmx 4. One source for both; the small adapters at
// the bottom map it onto each htmx version's extension API.

/** pusher-js options for Hibira; yours are merged over them. */
export const HIBIRA_DEFAULTS = {
  cluster: 'hkg', // required by pusher-js, unused once wsHost is set
  wsHost: 'ws.hibira.io',
  forceTLS: true,
  enabledTransports: ['ws', 'wss'],
};

const SELECTOR = ['hibira-connect', 'hibira-swap']
  .flatMap((a) => [`[${a}]`, `[data-${a}]`])
  .concat('[hx-trigger*="hibira:"]', '[data-hx-trigger*="hibira:"]')
  .join(',');

// Events a browser can send itself (client-*) or that pusher-js uses
// internally (pusher:*) never swap HTML: only your server can publish a swap.
const UNSAFE_SWAP = /^(client-|pusher:|pusher_internal:)/;

const RELEASE_DELAY = 100; // ms

const settings = { Pusher: undefined, client: undefined, options: {} };
const connections = new WeakMap(); // connect element -> { pusher, unbind }
const bound = new WeakMap(); // element -> teardown()
const queues = new WeakMap(); // element -> promise chain, keeps swaps in order
const counts = new WeakMap(); // pusher -> Map(channel name -> users)

/**
 * Registers the extension with htmx (2 or 4). The script-tag build calls this
 * for you with the global htmx and Pusher.
 */
export function register(htmx, options = {}) {
  if (!htmx) throw new Error('@hibira-io/htmx: pass the htmx object to register()');
  configure(options);
  if (typeof htmx.registerExtension === 'function') return registerV4(htmx);
  if (typeof htmx.defineExtension === 'function') return registerV2(htmx);
  throw new Error('@hibira-io/htmx: unsupported htmx version (need 2.x or 4.x)');
}

/**
 * Changes settings after registering: `Pusher` (the pusher-js constructor),
 * `client` (an existing pusher-js client, e.g. Laravel Echo's), `options`
 * (pusher-js options merged over the Hibira defaults).
 */
export function configure({ Pusher, client, options } = {}) {
  if (Pusher) settings.Pusher = Pusher;
  if (client) settings.client = client;
  if (options) settings.options = { ...settings.options, ...options };
}

/** The pusher-js client an element uses, or undefined. */
export function clientFor(elt) {
  const owner = closest(elt, 'hibira-connect');
  if (owner && read(owner, 'hibira-connect')) return connect(owner)?.pusher;
  return settings.client ?? globalThis.Echo?.connector?.pusher;
}

// ---------------------------------------------------------------------------
// Core, shared by both htmx versions. `host` supplies swap() for the version.

function setup(elt, host) {
  if (bound.has(elt)) return;
  if (has(elt, 'hibira-connect') && read(elt, 'hibira-connect') && connect(elt)) host.track?.(elt);

  const swapNames = list(read(elt, 'hibira-swap'));
  const triggerNames = [...(read(elt, 'hx-trigger') ?? '').matchAll(/(?:^|[\s,])hibira:([^\s,[]+)/g)].map((m) => m[1]);
  if (!swapNames.length && !triggerNames.length) return;

  const channelName = read(closest(elt, 'hibira-channel'), 'hibira-channel');
  if (!channelName) return fail(elt, 'no hibira-channel on this element or its ancestors');
  const pusher = clientFor(elt);
  if (!pusher) return fail(elt, 'no client: add hibira-connect="APP_KEY" to an ancestor or call configure({ client })');

  const channel = acquire(pusher, channelName);
  const handlers = [];
  for (const name of swapNames) {
    if (UNSAFE_SWAP.test(name)) {
      fail(elt, `hibira-swap ignores "${name}": browsers can send client events, so only server events may swap HTML`);
      continue;
    }
    handlers.push([name, (data) => enqueue(elt, () => onSwap(elt, host, channelName, name, data))]);
  }
  for (const name of triggerNames) {
    handlers.push([name, (data) => fire(elt, `hibira:${name}`, { channel: channelName, event: name, data }, false)]);
  }
  for (const [name, fn] of handlers) channel.bind(name, fn);
  host.track?.(elt);

  bound.set(elt, () => {
    for (const [name, fn] of handlers) channel.unbind(name, fn);
    release(pusher, channelName);
  });
}

function teardown(elt) {
  bound.get(elt)?.();
  bound.delete(elt);
  const conn = connections.get(elt);
  if (conn) {
    connections.delete(elt);
    conn.unbind();
    conn.pusher.disconnect();
  }
}

async function onSwap(elt, host, channel, event, data) {
  if (!elt.isConnected) return;
  const detail = { channel, event, data, message: toMessage(data) };
  if (!fire(elt, 'hibira:before-swap', detail)) return;
  if (detail.message) await host.swap(elt, detail.message);
  fire(elt, 'hibira:after-swap', detail);
}

// A string is HTML. An object swaps its `html` (or `content`) and may pick
// `target`, `swap` and `select`. Anything else is data for your own listeners.
function toMessage(data) {
  if (typeof data === 'string') return { html: data };
  if (!data || typeof data !== 'object') return null;
  const html = data.html ?? data.content;
  if (typeof html !== 'string') return null;
  return { html, target: str(data.target), swap: str(data.swap), select: str(data.select) };
}

function connect(owner) {
  let conn = connections.get(owner);
  if (conn) return conn;
  const Pusher = settings.Pusher ?? globalThis.Pusher;
  if (typeof Pusher !== 'function') {
    fail(owner, 'pusher-js not found: load it before this extension or pass { Pusher } to register()');
    return undefined;
  }
  const options = { ...HIBIRA_DEFAULTS, ...settings.options, ...json(owner, 'hibira-options') };
  const endpoint = read(owner, 'hibira-auth-endpoint');
  const headers = authHeaders(owner);
  if (endpoint || headers) {
    const base = options.channelAuthorization ?? {};
    options.channelAuthorization = {
      transport: 'ajax',
      endpoint: '/pusher/auth',
      ...base,
      ...(endpoint ? { endpoint } : {}),
      headers: { ...base.headers, ...headers },
    };
  }
  const pusher = new Pusher(read(owner, 'hibira-connect'), options);
  const onState = ({ current }) => {
    owner.setAttribute('hibira-state', current);
    fire(owner, 'hibira:state', { state: current }, false);
  };
  pusher.connection.bind('state_change', onState);
  owner.setAttribute('hibira-state', pusher.connection.state ?? 'initialized');
  conn = { pusher, unbind: () => pusher.connection.unbind('state_change', onState) };
  connections.set(owner, conn);
  return conn;
}

// Private and presence channels authorize against your backend. Reuse the
// CSRF header most htmx apps already put in hx-headers on <body>.
function authHeaders(owner) {
  const merged = {};
  for (let el = owner; el; el = el.parentElement) {
    const raw = read(el, 'hx-headers');
    if (raw && raw.trim().startsWith('{')) {
      try {
        Object.assign(merged, { ...JSON.parse(raw), ...merged }); // closer wins
      } catch {
        /* not JSON: ignore */
      }
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

// pusher.unsubscribe(name) drops the channel for every element that uses it,
// so subscriptions are counted per client. The last release waits a moment:
// a swap removes old elements before it binds the new ones, and the channel
// should stay subscribed across that gap instead of missing events.
function acquire(pusher, name) {
  let byName = counts.get(pusher);
  if (!byName) counts.set(pusher, (byName = new Map()));
  const prev = byName.get(name);
  byName.set(name, (prev ?? 0) + 1);
  return (prev !== undefined && pusher.channel(name)) || pusher.subscribe(name);
}

function release(pusher, name) {
  const byName = counts.get(pusher);
  if (!byName?.has(name)) return;
  const n = byName.get(name) - 1;
  byName.set(name, n);
  if (n > 0) return;
  setTimeout(() => {
    if (byName.get(name) !== 0) return;
    byName.delete(name);
    pusher.unsubscribe(name);
  }, RELEASE_DELAY);
}

function enqueue(elt, task) {
  const next = (queues.get(elt) ?? Promise.resolve()).then(task).catch((error) => fail(elt, error));
  queues.set(elt, next);
  return next;
}

function fire(elt, name, detail, bubbles = true) {
  return elt.dispatchEvent(new CustomEvent(name, { detail, bubbles, cancelable: true, composed: true }));
}

function fail(elt, error) {
  const detail = { error: error instanceof Error ? error : new Error(`@hibira-io/htmx: ${error}`) };
  if (fire(elt, 'hibira:error', detail)) console.warn(detail.error.message, elt);
}

function has(elt, name) {
  return !!elt?.hasAttribute && (elt.hasAttribute(name) || elt.hasAttribute(`data-${name}`));
}
function read(elt, name) {
  if (!elt?.getAttribute) return undefined;
  return elt.getAttribute(name) ?? elt.getAttribute(`data-${name}`) ?? undefined;
}
function closest(elt, name) {
  return elt?.closest?.(`[${name}],[data-${name}]`) ?? undefined;
}
function list(value) {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
function str(v) {
  return typeof v === 'string' && v ? v : undefined;
}
function json(elt, name) {
  const raw = read(elt, name);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    fail(elt, `${name} is not valid JSON`);
    return {};
  }
}
function each(root, fn) {
  if (root?.matches?.(SELECTOR)) fn(root);
  root?.querySelectorAll?.(SELECTOR).forEach(fn);
}
function cleanupTree(root) {
  if (bound.has(root) || connections.has(root)) teardown(root);
  root?.querySelectorAll?.(SELECTOR).forEach((el) => (bound.has(el) || connections.has(el)) && teardown(el));
}

// ---------------------------------------------------------------------------
// htmx 2: htmx.defineExtension, activated with hx-ext="hibira".

function registerV2(htmx) {
  let api;
  const host = {
    swap(elt, msg) {
      const target = msg.target ? api.querySelectorExt(elt, msg.target) : api.getTarget(elt);
      if (!target) throw new Error(`@hibira-io/htmx: swap target not found (${msg.target ?? read(elt, 'hx-target')})`);
      api.swap(target, msg.html, api.getSwapSpecification(elt, msg.swap), {
        select: msg.select ?? api.getClosestAttributeValue(elt, 'hx-select'),
        selectOOB: api.getClosestAttributeValue(elt, 'hx-select-oob'),
        contextElement: elt,
      });
    },
  };
  htmx.defineExtension('hibira', {
    init(internal) {
      api = internal;
    },
    getSelectors: () => SELECTOR.split(','),
    onEvent(name, evt) {
      const elt = evt.target ?? evt.detail?.elt;
      if (name === 'htmx:afterProcessNode') setup(elt, host);
      else if (name === 'htmx:beforeCleanupElement') teardown(elt);
    },
  });
  return 2;
}

// htmx 4: htmx.registerExtension; extensions are global, no hx-ext needed.

function registerV4(htmx) {
  let api;
  const host = {
    track: (elt) => api.htmxProp(elt), // makes htmx call our cleanup hook
    async swap(elt, msg) {
      let swap = msg.swap ?? api.attributeValue(elt, 'hx-swap') ?? htmx.config.defaultSwap;
      if (!/(?:^|\s)swapEmpty(?::|\s|$)/.test(swap)) swap += ' swapEmpty:false';
      await htmx.swap({
        sourceElement: elt,
        target: msg.target ?? api.attributeValue(elt, 'hx-target') ?? elt,
        swap,
        select: msg.select ?? api.attributeValue(elt, 'hx-select'),
        selectOOB: api.attributeValue(elt, 'hx-select-oob'),
        text: msg.html,
        transition: false,
      });
    },
  };
  htmx.registerExtension('hibira', {
    init(internal) {
      api = internal;
    },
    htmx_after_process: (root) => each(root, (elt) => setup(elt, host)),
    htmx_before_cleanup: (elt) => cleanupTree(elt),
  });
  return 4;
}
