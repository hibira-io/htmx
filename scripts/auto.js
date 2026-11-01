import { HIBIRA_DEFAULTS, clientFor, configure, register } from '../index.js';

const api = { HIBIRA_DEFAULTS, clientFor, configure, register };
globalThis.HibiraHtmx = api;
if (globalThis.htmx) register(globalThis.htmx);
