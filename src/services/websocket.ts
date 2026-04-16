import { getCurrentNetworkConfig } from '../hooks/useNetwork';
import type { WSNewBlock, WSStats } from '../types/blockchain';

type EventName = 'newBlock' | 'newStats' | 'connect' | 'disconnect';

type EventDataMap = {
  newBlock: WSNewBlock;
  newStats: WSStats;
  connect: undefined;
  disconnect: undefined;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener<T = any> = (data: T) => void;

interface Subscription {
  event: EventName;
  listener: Listener;
}

class WebSocketService {
  private socket: WebSocket | null = null;
  private subscriptions = new Map<number, Subscription>();
  private nextId = 1;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectionCount = 0;
  private url: string;

  constructor() {
    const backendUrl = getCurrentNetworkConfig().wsUrl;
    if (backendUrl) {
      try {
        const parsed = new URL(backendUrl);
        parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
        parsed.pathname = '/ws';
        this.url = parsed.toString();
      } catch {
        this.url = '';
      }
    } else {
      const loc = window.location;
      const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      this.url = `${proto}//${loc.host}/ws`;
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.connectionCount > 0 && !this.isConnected()) {
        this.connect();
      }
    });
  }

  registerConnection(): void {
    this.connectionCount++;
    if (this.connectionCount === 1) {
      this.connect();
    }
  }

  unregisterConnection(): void {
    this.connectionCount = Math.max(0, this.connectionCount - 1);
    if (this.connectionCount === 0) {
      this.disconnect();
    }
  }

  subscribe<K extends EventName>(event: K, listener: Listener<EventDataMap[K]>): number {
    const id = this.nextId++;
    this.subscriptions.set(id, { event, listener: listener as Listener });
    return id;
  }

  unsubscribe(id: number): void {
    this.subscriptions.delete(id);
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private emit(event: EventName, data?: unknown): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.event === event) {
        try {
          sub.listener(data);
        } catch {
          // listener error — swallow to protect other listeners
        }
      }
    }
  }

  private connect(): void {
    if (!this.url) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emit('connect');
    };

    this.socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { event: string; data: unknown };
        if (msg.event === 'newBlock') {
          this.emit('newBlock', msg.data as WSNewBlock);
        } else if (msg.event === 'newStats') {
          this.emit('newStats', msg.data as WSStats);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.socket.onclose = () => {
      this.stopHeartbeat();
      this.emit('disconnect');
      if (this.connectionCount > 0) {
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = () => {
      this.socket?.close();
    };
  }

  private disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
      this.socket = null;
    }
    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    if (this.reconnectTimer) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.connectionCount > 0) {
        this.connect();
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // ignore send errors
        }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export const webSocketService = new WebSocketService();
export default WebSocketService;
