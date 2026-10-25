import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Cell,
  HistoryEntry,
  Notice,
  Player,
  RejectReason,
  ServerConfig,
  ServerMessage,
} from '../../shared/protocol';

const API_BASE = typeof __API_BASE__ === 'string' ? __API_BASE__ : '';

function wsUrl(since: number): string {
  if (API_BASE) {
    const url = new URL(API_BASE);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = `?since=${since}`;
    return url.toString();
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws?since=${since}`;
}

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'reconnecting' | 'fatal';

export type Rejection = {
  reason: RejectReason;
  message: string;
  at: number;
  nextAt?: number;
};

export type Session = {
  handle: string;
  isAdmin: boolean;
  adminEnabled: boolean;
  pixels: number;
  nextAt: number;
};

type UseCanvasOptions = {
  onCanvas: (canvas: Uint8Array, config: ServerConfig) => void;
  onPixels: (cells: Cell[]) => void;
  onReset: (canvas: Uint8Array) => void;
};

export type CanvasSocket = {
  state: ConnectionState;
  config: ServerConfig | null;
  session: Session | null;
  players: Player[];
  online: number;
  history: HistoryEntry[];
  rejection: Rejection | null;
  notice: Notice | null;
  latency: number | null;
  nextAt: number;
  lastSyncAt: number;
  attempts: number;
  place: (x: number, y: number, c: number) => boolean;
  report: (x: number, y: number, reason: string, note?: string) => void;
  dismissRejection: () => void;
  retryNow: () => void;
  requestHistory: () => Promise<void>;
};

/**
 * Owns the WebSocket lifecycle: connect, auto-reconnect with backoff, heartbeat,
 * message dispatch and the derived state the UI renders.
 */
export function useCanvasSocket(options: UseCanvasOptions): CanvasSocket {
  const { onCanvas, onPixels, onReset } = options;

  const [state, setState] = useState<ConnectionState>('connecting');
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [online, setOnline] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [nextAt, setNextAt] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState(0);
  const [attempts, setAttempts] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const lastIdRef = useRef(0);
  const handlersRef = useRef({ onCanvas, onPixels, onReset });
  const reconnectTimer = useRef<number | null>(null);
  const attemptsRef = useRef(0);
  const manualClose = useRef(false);
  const pingTimer = useRef<number | null>(null);
  const pendingPlace = useRef<{ x: number; y: number; c: number; nonce: string; at: number } | null>(null);

  handlersRef.current = { onCanvas, onPixels, onReset };

  const clearReconnect = () => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  };

  const buildMessage = useCallback((message: ServerMessage) => {
    switch (message.t) {
      case 'welcome': {
        const bytes = base64UrlToBytes(message.canvas);
        setConfig(message.config);
        setNotice(message.config.notice);
        setSession({
          handle: message.handle,
          isAdmin: message.isAdmin,
          adminEnabled: true,
          pixels: message.me.pixels,
          nextAt: message.nextAt,
        });
        setNextAt(message.nextAt);
        lastIdRef.current = message.lastId;
        setHistory((prev) => mergeHistory(prev, message.history));
        setLastSyncAt(Date.now());
        const canvas = unpackRle(bytes, message.config.width * message.config.height);
        handlersRef.current.onCanvas(canvas, message.config);
        break;
      }
      case 'pixels': {
        handlersRef.current.onPixels(message.cells);
        if (message.nextAt) {
          setNextAt(message.nextAt);
          setSession((prev) => (prev ? { ...prev, nextAt: message.nextAt! } : prev));
        }
        if (message.self) {
          setSession((prev) =>
            prev ? { ...prev, pixels: prev.pixels + (message.cells.length > 0 ? 1 : 0) } : prev,
          );
        }
        if (message.lastId > lastIdRef.current) {
          lastIdRef.current = message.lastId;
          const authored = Boolean(message.self);
          const entries: HistoryEntry[] = message.cells.map((cell, index) => ({
            id: message.lastId - (message.cells.length - 1 - index),
            x: cell.x,
            y: cell.y,
            c: cell.c,
            prev: null,
            at: Date.now(),
            by: authored ? 'you' : 'someone',
          }));
          setHistory((prev) => [...entries.reverse(), ...prev].slice(0, 80));
        }
        setConfig((prev) =>
          prev ? { ...prev, totalPixels: message.totalPixels, version: message.version } : prev,
        );
        setLastSyncAt(Date.now());
        pendingPlace.current = null;
        break;
      }
      case 'reject': {
        setRejection({ reason: message.reason, message: message.message, at: Date.now(), nextAt: message.nextAt });
        if (message.nextAt) setNextAt(message.nextAt);
        if (message.reason === 'cooldown' && message.nextAt) {
          setNextAt(message.nextAt);
        }
        pendingPlace.current = null;
        break;
      }
      case 'presence': {
        setOnline(message.online);
        if (message.players.length > 0) setPlayers(message.players);
        break;
      }
      case 'notice': {
        setNotice(message.notice);
        break;
      }
      case 'pong': {
        setLatency(Math.max(0, Date.now() - message.ts));
        break;
      }
      case 'error': {
        setRejection({ reason: 'server_error', message: message.message, at: Date.now() });
        break;
      }
      default:
        break;
    }
  }, []);

  const connect = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return;

    setState((prev) => (prev === 'online' ? 'reconnecting' : attemptsRef.current === 0 ? 'connecting' : 'reconnecting'));

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl(lastIdRef.current));
    } catch {
      setState('offline');
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      attemptsRef.current = 0;
      setAttempts(0);
      setState('online');
      // Ask for anything we might have missed while disconnected.
      socket.send(JSON.stringify({ t: 'hello', since: lastIdRef.current }));
      if (pingTimer.current !== null) window.clearInterval(pingTimer.current);
      pingTimer.current = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
        }
      }, 20_000);
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        buildMessage(JSON.parse(event.data) as ServerMessage);
      } catch (error) {
        console.warn('bad server message', error);
      }
    };

    socket.onerror = () => {
      setState((prev) => (prev === 'online' ? 'reconnecting' : 'offline'));
    };

    socket.onclose = (event) => {
      if (pingTimer.current !== null) {
        window.clearInterval(pingTimer.current);
        pingTimer.current = null;
      }
      // Only clear the ref if it still points at *this* socket; a forced
      // reconnect may already have installed a newer one.
      if (socketRef.current === socket) socketRef.current = null;
      if (manualClose.current) return;
      // 4xxx codes come from the Worker layer (e.g. 4401 unauthenticated) — retrying
      // blindly would loop, so surface a fatal state and let the user reload.
      if (event.code >= 4400 && event.code < 4500) {
        setState('fatal');
        return;
      }
      if (navigator.onLine === false) {
        // Stay in the offline state; the `online` event triggers a fresh connect.
        setState('offline');
        return;
      }
      setState('reconnecting');
      attemptsRef.current += 1;
      setAttempts(attemptsRef.current);
      const delay = Math.min(15_000, 600 * 2 ** Math.min(attemptsRef.current, 5));
      clearReconnect();
      reconnectTimer.current = window.setTimeout(() => connect(), delay);
    };
  }, [buildMessage]);

  /** Drop the current socket and immediately open a fresh one (used by online/retry). */
  const forceReconnect = useCallback(() => {
    attemptsRef.current = 0;
    setAttempts(0);
    clearReconnect();
    if (pingTimer.current !== null) {
      window.clearInterval(pingTimer.current);
      pingTimer.current = null;
    }
    const stale = socketRef.current;
    socketRef.current = null;
    if (stale) {
      try {
        stale.close();
      } catch {
        /* already gone */
      }
    }
    connect();
  }, [connect]);

  useEffect(() => {
    manualClose.current = false;
    connect();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !socketRef.current) forceReconnect();
    };
    // Coming back online always deserves a fresh socket: the old one is dead but
    // the browser may not have fired `close` yet.
    const onOnline = () => forceReconnect();
    const onOffline = () => setState('offline');
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      manualClose.current = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      clearReconnect();
      if (pingTimer.current !== null) window.clearInterval(pingTimer.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect, forceReconnect]);

  const place = useCallback((x: number, y: number, c: number) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setRejection({ reason: 'server_error', message: 'You are offline — the pixel was not sent.', at: Date.now() });
      return false;
    }
    const nonce = Math.random().toString(36).slice(2, 10);
    pendingPlace.current = { x, y, c, nonce, at: Date.now() };
    socket.send(JSON.stringify({ t: 'place', x, y, c, nonce }));
    return true;
  }, []);

  const report = useCallback((x: number, y: number, reason: string, note = '') => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setRejection({ reason: 'server_error', message: 'You are offline — the report was not sent.', at: Date.now() });
      return;
    }
    socket.send(JSON.stringify({ t: 'report', x, y, reason, note }));
  }, []);

  const dismissRejection = useCallback(() => setRejection(null), []);
  const retryNow = useCallback(() => {
    forceReconnect();
  }, [forceReconnect]);

  const requestHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/history?since=0&limit=80`, { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { history: HistoryEntry[] };
      setHistory((prev) => mergeHistory(prev, data.history));
    } catch {
      /* history refresh is best-effort */
    }
  }, []);

  return useMemo(
    () => ({
      state,
      config,
      session,
      players,
      online,
      history,
      rejection,
      notice,
      latency,
      nextAt,
      lastSyncAt,
      attempts,
      place,
      report,
      dismissRejection,
      retryNow,
      requestHistory,
    }),
    [
      state,
      config,
      session,
      players,
      online,
      history,
      rejection,
      notice,
      latency,
      nextAt,
      lastSyncAt,
      attempts,
      place,
      report,
      dismissRejection,
      retryNow,
      requestHistory,
    ],
  );
}

function mergeHistory(prev: HistoryEntry[], incoming: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set(prev.map((h) => h.id));
  const merged = [...prev];
  for (const entry of incoming) {
    if (!seen.has(entry.id)) {
      merged.push(entry);
      seen.add(entry.id);
    }
  }
  merged.sort((a, b) => b.id - a.id);
  return merged.slice(0, 80);
}

/* ---------------------------------------------------------------- helpers */

import { base64UrlToBytes, unpackRle } from '../../shared/rle';
