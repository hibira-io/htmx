import htmx from 'htmx.org';
import Pusher from 'pusher-js';
import { HIBIRA_DEFAULTS, clientFor, configure, register, type HibiraSwapDetail } from '../index.js';

const version: 2 | 4 = register(htmx, { Pusher: Pusher as never });
configure({ options: { wsHost: HIBIRA_DEFAULTS.wsHost } });
const client = clientFor(document.body);
client?.subscribe('orders');

document.body.addEventListener('hibira:before-swap', (e) => {
  const d: HibiraSwapDetail = e.detail;
  if (d.message) d.message.html = d.message.html.trim();
});
document.body.addEventListener('hibira:state', (e) => e.detail.state.toUpperCase());
void version;
