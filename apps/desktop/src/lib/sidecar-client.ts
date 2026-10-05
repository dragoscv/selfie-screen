import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@tiksee/core";

type Listener = (message: ServerMessage) => void;
type StateListener = (connected: boolean) => void;

const RECONNECT_MIN_MS = 400;
const RECONNECT_MAX_MS = 8_000;
const HEARTBEAT_MS = 15_000;
/** A socket that leaves this many pings unanswered is treated as dead. */
const MAX_MISSED_PONGS = 2;

/**
 * Typed WebSocket client for the Node sidecar.
 *
 * Reconnects forever with capped backoff. Messages sent while disconnected are
 * queued rather than dropped, so the UI can act optimistically during the
 * moment between the shell spawning the sidecar and the socket opening.
 */
export class SidecarClient {
  #socket: WebSocket | null = null;
  #url = "";
  #listeners = new Set<Listener>();
  #stateListeners = new Set<StateListener>();
  #queue: ClientMessage[] = [];
  #retry = RECONNECT_MIN_MS;
  #reconnectTimer: number | null = null;
  #heartbeat: number | null = null;
  #missedPongs = 0;
  #closed = false;

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  connect(port: number): void {
    const url = `ws://127.0.0.1:${port}/ws`;
    // Re-pointing at the same port while already open is a no-op; the shell
    // re-emits `sidecar://ready` on every renderer reload.
    if (url === this.#url && this.connected) return;

    this.#url = url;
    this.#closed = false;
    this.#open();
  }

  #open(): void {
    if (this.#closed || this.#url === "") return;
    this.#teardownSocket();

    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#retry = RECONNECT_MIN_MS;
      this.#notifyState(true);
      const queued = this.#queue;
      this.#queue = [];
      for (const message of queued) this.send(message);
      this.#startHeartbeat();
    };

    socket.onmessage = (event) => {
      const message = parseServerMessage(String(event.data));
      // Silently ignoring unknown frames keeps an older UI usable against a
      // newer sidecar rather than throwing on every tick.
      if (!message) return;
      if (message.type === "pong") this.#missedPongs = 0;
      for (const listener of this.#listeners) listener(message);
    };

    socket.onclose = () => {
      this.#stopHeartbeat();
      this.#notifyState(false);
      this.#scheduleReconnect();
    };

    socket.onerror = () => socket.close();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null) return;
    const delay = this.#retry;
    this.#retry = Math.min(this.#retry * 2, RECONNECT_MAX_MS);
    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#missedPongs = 0;
    // A dead sidecar with a half-open socket looks "connected" to the browser;
    // the ping/pong is what actually proves liveness.
    this.#heartbeat = window.setInterval(() => {
      if (this.#missedPongs >= MAX_MISSED_PONGS) {
        this.#forceReconnect();
        return;
      }
      this.#missedPongs++;
      this.send({ type: "ping", at: Date.now() });
    }, HEARTBEAT_MS);
  }

  /**
   * `close()` on a half-open socket can take minutes to fire `onclose`, so
   * detach the handlers, report the drop ourselves and reconnect now.
   */
  #forceReconnect(): void {
    this.#stopHeartbeat();
    this.#teardownSocket();
    this.#notifyState(false);
    this.#scheduleReconnect();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) window.clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  #teardownSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

  #notifyState(connected: boolean): void {
    for (const listener of this.#stateListeners) listener(connected);
  }

  send(message: ClientMessage): void {
    if (this.connected) {
      this.#socket?.send(JSON.stringify(message));
      return;
    }
    // Bound the queue: if the sidecar is down for minutes, replaying a
    // thousand stale commands on reconnect would be worse than dropping them.
    if (this.#queue.length < 64) this.#queue.push(message);
  }

  onMessage(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer !== null) window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#stopHeartbeat();
    this.#teardownSocket();
  }
}

export const sidecarClient = new SidecarClient();
