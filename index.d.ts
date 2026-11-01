/** Minimal shape of a pusher-js client the extension uses. */
export interface PusherLike {
  subscribe(channel: string): ChannelLike;
  unsubscribe(channel: string): void;
  channel(channel: string): ChannelLike | undefined;
  disconnect(): void;
  connection: {
    state?: string;
    bind(event: 'state_change', fn: (states: { previous: string; current: string }) => void): unknown;
    unbind(event: 'state_change', fn: (states: { previous: string; current: string }) => void): unknown;
  };
}

export interface ChannelLike {
  bind(event: string, fn: (data: unknown) => void): unknown;
  unbind(event: string, fn: (data: unknown) => void): unknown;
}

export type PusherConstructor = new (key: string, options?: Record<string, unknown>) => PusherLike;

export interface HibiraHtmxSettings {
  /** The pusher-js constructor. Defaults to the global `Pusher`. */
  Pusher?: PusherConstructor;
  /** An existing client, used when no ancestor has hibira-connect. Laravel Echo's client is picked up on its own. */
  client?: PusherLike;
  /** pusher-js options merged over the Hibira defaults. */
  options?: Record<string, unknown>;
}

/** What a swap message becomes after parsing: a string is `{ html }`. */
export interface HibiraSwapMessage {
  html: string;
  target?: string;
  swap?: string;
  select?: string;
}

/** `detail` of the hibira:before-swap and hibira:after-swap DOM events. */
export interface HibiraSwapDetail {
  channel: string;
  event: string;
  data: unknown;
  /** null when the data has no HTML; edit it in hibira:before-swap to change the swap. */
  message: HibiraSwapMessage | null;
}

/** `detail` of the hibira:<event> DOM events that hx-trigger listens to. */
export interface HibiraTriggerDetail {
  channel: string;
  event: string;
  data: unknown;
}

export declare const HIBIRA_DEFAULTS: {
  cluster: string;
  wsHost: string;
  forceTLS: boolean;
  enabledTransports: string[];
};

/** Registers hx-ext="hibira" with htmx 2 or htmx 4. Returns the htmx major version it registered with. */
export declare function register(htmx: object, settings?: HibiraHtmxSettings): 2 | 4;

/** Changes settings after registering. */
export declare function configure(settings?: HibiraHtmxSettings): void;

/** The pusher-js client an element uses, or undefined. */
export declare function clientFor(element: Element): PusherLike | undefined;

declare global {
  interface HTMLElementEventMap {
    'hibira:before-swap': CustomEvent<HibiraSwapDetail>;
    'hibira:after-swap': CustomEvent<HibiraSwapDetail>;
    'hibira:state': CustomEvent<{ state: string }>;
    'hibira:error': CustomEvent<{ error: Error }>;
  }
}
