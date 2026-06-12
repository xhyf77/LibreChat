import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import { apiBaseUrl, request } from 'librechat-data-provider';
import copyToClipboard from 'copy-to-clipboard';
import { useAuthContext } from '~/hooks';
import {
  clearHttpTerminalFallback,
  createTerminalSessionPath,
  getTerminalTransportPreference,
  rememberHttpTerminalFallback,
  shouldStartTerminalWithHttpFallback,
} from '~/utils';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';

type TicketResponse = {
  ticket: string;
  expiresAt: string;
};

type TerminalMode = 'shell' | 'codex';

type TerminalExitInfo = {
  exitCode?: number;
  signal?: number;
};

type TerminalSessionResponse = {
  sessionId: string;
  mode: TerminalMode;
  pid: number;
  cwd: string;
  serverPid?: number;
  serverInstanceId?: string;
};

type TerminalTransport = 'websocket' | 'sse';

type HttpInputStream = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  closed: boolean;
};

type TerminalSnapshot = {
  key: string;
  data: string;
};

type TerminalServerMessage = {
  type?: string;
  data?: string;
  replayKind?: 'xterm-serialize' | 'raw-tail';
  seq?: number;
  pid?: number;
  cwd?: string;
  sessionId?: string;
  mode?: TerminalMode;
  serverPid?: number;
  serverInstanceId?: string;
  exitCode?: number;
  signal?: number;
};

const atomOneLightTheme = {
  background: '#fafafa',
  foreground: '#202227',
  cursor: '#526fff',
  cursorAccent: '#fafafa',
  selectionBackground: '#e5e5e6',
  black: '#202227',
  red: '#b8292f',
  green: '#2d7d35',
  yellow: '#7c5b00',
  blue: '#245fc7',
  magenta: '#8b2388',
  cyan: '#007197',
  white: '#4b4f58',
  brightBlack: '#5f626b',
  brightRed: '#9f1239',
  brightGreen: '#256f30',
  brightYellow: '#684900',
  brightBlue: '#1f55b5',
  brightMagenta: '#7d1f79',
  brightCyan: '#005f80',
  brightWhite: '#202227',
};

const terminalFont =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "Symbols Nerd Font Mono", "Roboto Mono", "SFMono-Regular", "SF Mono", "Cascadia Code", Menlo, Consolas, "Liberation Mono", monospace';
const terminalFontSize = 14;
const terminalScrollbackRows = 4000;
const terminalSnapshotScrollbackRows = 800;
const terminalSnapshotMaxBytes = 320 * 1024;
const terminalSnapshotMinIntervalMs = 3000;
const terminalSnapshotSlowMs = 120;
const terminalSnapshotSlowBackoffMs = 15000;
const terminalSnapshotTtlMs = 30000;
const terminalReplayChunkChars = 64 * 1024;
const terminalLiveWriteFlushChars = 48 * 1024;
const terminalLiveDirectWriteChars = 2048;
const terminalLiveDirectWriteMinIntervalMs = 6;
const terminalWritePendingMaxChars = 512 * 1024;
const terminalHiddenBacklogMaxChars = 256 * 1024;
const terminalRestoreThrottleMs = 250;
const terminalResponseSuppressMs = 1500;
const httpInputFlushMs = 1;
const websocketFallbackMs = 1800;
const websocketUnstableCloseMs = 120_000;
const reconnectMinDelayMs = 150;
const reconnectMaxDelayMs = 5000;
const reconnectNoticeMinIntervalMs = 5000;
const pendingReconnectInputFlushMs = 150;
const pendingReconnectInputLimit = 1024 * 1024;
const terminalQueryResponsePattern =
  /^(?:\x1b\[[?>]?[0-9;]*[Rc]|\x1b\](?:10|11);rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\))+$/;
const terminalWordSequences = {
  backward: '\x1b[1;5D',
  forward: '\x1b[1;5C',
  deleteBackward: '\x17',
};

function loadTerminalFonts(fontSize: number) {
  if (typeof document === 'undefined' || !document.fonts) {
    return Promise.resolve();
  }
  return Promise.allSettled([
    document.fonts.load(`400 ${fontSize}px "JetBrainsMono Nerd Font Mono"`),
    document.fonts.load(`700 ${fontSize}px "JetBrainsMono Nerd Font Mono"`),
    document.fonts.load(`400 ${fontSize}px "Symbols Nerd Font Mono"`),
  ]).then(() => undefined);
}

function buildWebSocketUrl({
  ticket,
  sessionId,
  mode,
  cols,
  rows,
}: {
  ticket: string;
  sessionId: string;
  mode: TerminalMode;
  cols: number;
  rows: number;
}) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = apiBaseUrl();
  const path = `${base}/api/codex-cli/terminal`;
  const url = new URL(path || '/api/codex-cli/terminal', `${protocol}//${window.location.host}`);
  url.protocol = protocol;
  url.searchParams.set('ticket', ticket);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('mode', mode);
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));
  return url.toString();
}

function buildEventSourceUrl({
  ticket,
  sessionId,
  mode,
}: {
  ticket: string;
  sessionId: string;
  mode: TerminalMode;
}) {
  const base = apiBaseUrl();
  const path = `${base}/api/codex-cli/sessions/${encodeURIComponent(sessionId)}/events`;
  const url = new URL(path || `/api/codex-cli/sessions/${encodeURIComponent(sessionId)}/events`, window.location.origin);
  url.searchParams.set('ticket', ticket);
  url.searchParams.set('mode', mode);
  return url.toString();
}

function isValidSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && sessionId !== 'new' && /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId);
}

function isTerminalShortcut(event: KeyboardEvent, key: string) {
  return (
    !event.altKey &&
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === key
  );
}

function getTerminalWordSequence(event: KeyboardEvent) {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
    return null;
  }

  if (event.key === 'Backspace' || event.code === 'Backspace') {
    return terminalWordSequences.deleteBackward;
  }
  if (event.key === 'ArrowLeft' || event.key === 'Left' || event.code === 'ArrowLeft') {
    return terminalWordSequences.backward;
  }
  if (event.key === 'ArrowRight' || event.key === 'Right' || event.code === 'ArrowRight') {
    return terminalWordSequences.forward;
  }

  return null;
}

function installClipboardHandlers(
  terminal: Terminal,
  container: HTMLDivElement,
  writeInput: (data: string) => void,
) {
  terminal.attachCustomKeyEventHandler((event) => {
    const wordSequence = getTerminalWordSequence(event);
    if (wordSequence) {
      if (event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        writeInput(wordSequence);
      }
      return false;
    }

    if (isTerminalShortcut(event, 'c')) {
      const selection = terminal.getSelection();
      if (!selection) {
        return true;
      }
      if (event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        copyToClipboard(selection);
      }
      return false;
    }

    if (isTerminalShortcut(event, 'v')) {
      if (event.type === 'keydown') {
        event.stopPropagation();
      }
      return false;
    }

    return true;
  });

  const handlePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    terminal.paste(text);
    terminal.focus();
  };

  container.addEventListener('paste', handlePaste, true);
  return () => container.removeEventListener('paste', handlePaste, true);
}

function isTerminalQueryResponse(data: string) {
  return terminalQueryResponsePattern.test(data);
}

function isTerminalViewportBlank(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.baseY);
  const end = Math.min(buffer.length, buffer.baseY + terminal.rows);
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (line?.translateToString(true).trim()) {
      return false;
    }
  }
  return true;
}

function writeTerminalData(
  terminal: Terminal,
  data: string,
  callback?: () => void,
) {
  if (!data || data.length <= terminalReplayChunkChars) {
    terminal.write(data, callback);
    return;
  }

  let offset = 0;
  const writeNextChunk = () => {
    const chunk = data.slice(offset, offset + terminalReplayChunkChars);
    offset += terminalReplayChunkChars;
    terminal.write(chunk, () => {
      if (offset >= data.length) {
        callback?.();
        return;
      }
      window.setTimeout(writeNextChunk, 0);
    });
  };
  writeNextChunk();
}

function scheduleIdleTask(callback: () => void, timeoutMs: number) {
  const browserWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (browserWindow.requestIdleCallback && browserWindow.cancelIdleCallback) {
    const handle = browserWindow.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => browserWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, Math.min(timeoutMs, 1000));
  return () => window.clearTimeout(handle);
}

export default function CodexCliRoute() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, token } = useAuthContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const renderAddonRef = useRef<WebglAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const transportRef = useRef<TerminalTransport | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const inputStreamRef = useRef<HttpInputStream | null>(null);
  const inputStreamDisabledRef = useRef(false);
  const queuedInputRef = useRef('');
  const pendingReconnectInputRef = useRef('');
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestReconnectRef = useRef<() => void>(() => undefined);
  const reconnectAttemptRef = useRef(0);
  const lastReconnectNoticeAtRef = useRef(0);
  const snapshotClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSnapshotCancelRef = useRef<(() => void) | null>(null);
  const lastSnapshotAtRef = useRef(0);
  const skipSnapshotsUntilRef = useRef(0);
  const reconnectCounter = useRef(0);
  const lastSessionIdRef = useRef<string | null>(null);
  const pendingSessionCreateRef = useRef<TerminalMode | null>(null);
  const connectedRef = useRef(false);
  const reconnectOnVisibleRef = useRef(false);
  const resetBeforeReplayRef = useRef(false);
  const terminalSnapshotRef = useRef<TerminalSnapshot | null>(null);
  const terminalOutputBufferRef = useRef('');
  const terminalOutputFrameRef = useRef(0);
  const terminalOutputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalWriteInFlightRef = useRef(false);
  const terminalWritePendingRef = useRef('');
  const terminalWriteGenerationRef = useRef(0);
  const writeTerminalOutputRef = useRef<(data: string, callback?: () => void) => void>(
    () => undefined,
  );
  const lastDirectTerminalWriteAtRef = useRef(0);
  const suppressTerminalResponsesUntilRef = useRef(0);
  const hasExitedRef = useRef(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [exitInfo, setExitInfo] = useState<TerminalExitInfo | null>(null);

  const terminalMode: TerminalMode = location.pathname.startsWith('/codex') ? 'codex' : 'shell';
  const routePrefix = terminalMode === 'codex' ? 'codex' : 'terminal';
  const transportPreference = useMemo(
    () => getTerminalTransportPreference(location.search),
    [location.search],
  );

  const activeSessionId = useMemo(() => {
    if (isValidSessionId(sessionId)) {
      return sessionId;
    }
    return null;
  }, [sessionId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const closeInputStream = useCallback(() => {
    const stream = inputStreamRef.current;
    inputStreamRef.current = null;
    if (!stream || stream.closed) {
      return;
    }
    stream.closed = true;
    try {
      stream.controller.close();
    } catch {
      // The browser may already have closed or errored the request body.
    }
  }, []);

  const cancelQueuedTerminalOutput = useCallback(() => {
    if (terminalOutputFrameRef.current) {
      window.cancelAnimationFrame(terminalOutputFrameRef.current);
      terminalOutputFrameRef.current = 0;
    }
    if (terminalOutputTimerRef.current) {
      clearTimeout(terminalOutputTimerRef.current);
      terminalOutputTimerRef.current = null;
    }
  }, []);

  const resetTerminalWriteQueue = useCallback(() => {
    terminalWriteGenerationRef.current += 1;
    terminalWriteInFlightRef.current = false;
    terminalWritePendingRef.current = '';
  }, []);

  const writeTerminalOutput = useCallback((data: string, callback?: () => void) => {
    const terminal = terminalRef.current;
    if (!terminal || !data) {
      callback?.();
      return;
    }

    if (terminalWriteInFlightRef.current) {
      terminalWritePendingRef.current += data;
      if (terminalWritePendingRef.current.length > terminalWritePendingMaxChars) {
        terminalWritePendingRef.current = '';
        resetBeforeReplayRef.current = true;
        requestReconnectRef.current();
      }
      callback?.();
      return;
    }

    const generation = terminalWriteGenerationRef.current;
    terminalWriteInFlightRef.current = true;
    writeTerminalData(terminal, data, () => {
      if (terminalWriteGenerationRef.current !== generation) {
        callback?.();
        return;
      }
      terminalWriteInFlightRef.current = false;
      callback?.();
      const pending = terminalWritePendingRef.current;
      terminalWritePendingRef.current = '';
      if (pending) {
        window.setTimeout(() => writeTerminalOutputRef.current(pending), 0);
      }
    });
  }, []);

  writeTerminalOutputRef.current = writeTerminalOutput;

  const flushQueuedTerminalOutput = useCallback(() => {
    cancelQueuedTerminalOutput();
    const data = terminalOutputBufferRef.current;
    terminalOutputBufferRef.current = '';
    if (!data) {
      return;
    }
    writeTerminalOutputRef.current(data);
  }, [cancelQueuedTerminalOutput]);

  const scheduleQueuedTerminalOutput = useCallback(() => {
    if (terminalOutputFrameRef.current || terminalOutputTimerRef.current) {
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      return;
    }
    terminalOutputFrameRef.current = window.requestAnimationFrame(() => {
      terminalOutputFrameRef.current = 0;
      flushQueuedTerminalOutput();
    });
  }, [flushQueuedTerminalOutput]);

  const queueTerminalOutput = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      if (typeof document !== 'undefined' && document.hidden) {
        terminalOutputBufferRef.current += data;
        if (terminalOutputBufferRef.current.length > terminalHiddenBacklogMaxChars) {
          terminalOutputBufferRef.current = '';
          resetBeforeReplayRef.current = true;
          reconnectOnVisibleRef.current = true;
        }
        scheduleQueuedTerminalOutput();
        return;
      }
      if (
        !terminalOutputBufferRef.current &&
        data.length <= terminalLiveDirectWriteChars &&
        Date.now() - lastDirectTerminalWriteAtRef.current >= terminalLiveDirectWriteMinIntervalMs
      ) {
        const terminal = terminalRef.current;
        if (terminal) {
          lastDirectTerminalWriteAtRef.current = Date.now();
          writeTerminalOutputRef.current(data);
          return;
        }
      }
      terminalOutputBufferRef.current += data;
      if (terminalOutputBufferRef.current.length >= terminalLiveWriteFlushChars) {
        flushQueuedTerminalOutput();
        return;
      }
      scheduleQueuedTerminalOutput();
    },
    [flushQueuedTerminalOutput, scheduleQueuedTerminalOutput],
  );

  const clearQueuedTerminalOutput = useCallback(() => {
    cancelQueuedTerminalOutput();
    terminalOutputBufferRef.current = '';
  }, [cancelQueuedTerminalOutput]);

  const getTerminalSnapshotKey = useCallback(() => {
    const session = activeSessionIdRef.current;
    if (!session) {
      return null;
    }
    return `${terminalMode}:${session}`;
  }, [terminalMode]);

  const snapshotTerminalState = useCallback(() => {
    if (typeof document !== 'undefined' && !document.hidden) {
      return;
    }
    const terminal = terminalRef.current;
    const serializeAddon = serializeAddonRef.current;
    const key = getTerminalSnapshotKey();
    if (!terminal || !serializeAddon || !key) {
      return;
    }
    const now = Date.now();
    if (
      now - lastSnapshotAtRef.current < terminalSnapshotMinIntervalMs ||
      now < skipSnapshotsUntilRef.current
    ) {
      return;
    }
    lastSnapshotAtRef.current = now;

    try {
      const start = performance.now();
      let data = serializeAddon.serialize({ scrollback: terminalSnapshotScrollbackRows });
      if (data.length > terminalSnapshotMaxBytes) {
        data = serializeAddon.serialize({ scrollback: 0 });
      }
      if (!data) {
        return;
      }
      if (data.length > terminalSnapshotMaxBytes) {
        return;
      }
      terminalSnapshotRef.current = {
        key,
        data,
      };
      if (snapshotClearTimerRef.current) {
        clearTimeout(snapshotClearTimerRef.current);
      }
      snapshotClearTimerRef.current = setTimeout(() => {
        const snapshot = terminalSnapshotRef.current;
        if (snapshot?.key === key && snapshot.data === data) {
          terminalSnapshotRef.current = null;
        }
        snapshotClearTimerRef.current = null;
      }, terminalSnapshotTtlMs);
      if (performance.now() - start > terminalSnapshotSlowMs) {
        skipSnapshotsUntilRef.current = Date.now() + terminalSnapshotSlowBackoffMs;
      }
    } catch {
      // Snapshotting is a recovery aid; live PTY streaming remains authoritative.
    }
  }, [getTerminalSnapshotKey]);

  const cancelPendingSnapshot = useCallback(() => {
    pendingSnapshotCancelRef.current?.();
    pendingSnapshotCancelRef.current = null;
  }, []);

  const scheduleTerminalSnapshot = useCallback(() => {
    if (pendingSnapshotCancelRef.current) {
      return;
    }
    pendingSnapshotCancelRef.current = scheduleIdleTask(() => {
      pendingSnapshotCancelRef.current = null;
      snapshotTerminalState();
    }, 2000);
  }, [snapshotTerminalState]);

  const restoreTerminalSnapshotIfBlank = useCallback(() => {
    const terminal = terminalRef.current;
    const snapshot = terminalSnapshotRef.current;
    const key = getTerminalSnapshotKey();
    if (
      !terminal ||
      !snapshot ||
      !key ||
      snapshot.key !== key ||
      !isTerminalViewportBlank(terminal)
    ) {
      return false;
    }
    try {
      resetTerminalWriteQueue();
      terminal.reset();
      writeTerminalOutputRef.current(snapshot.data, () => {
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      });
      return true;
    } catch {
      return false;
    }
  }, [getTerminalSnapshotKey, resetTerminalWriteQueue]);

  const startHttpInputStream = useCallback(() => {
    const session = activeSessionIdRef.current;
    if (
      !session ||
      !token ||
      hasExitedRef.current ||
      inputStreamRef.current ||
      inputStreamDisabledRef.current ||
      typeof ReadableStream === 'undefined' ||
      typeof TextEncoder === 'undefined'
    ) {
      return;
    }

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    if (!controller) {
      inputStreamDisabledRef.current = true;
      return;
    }

    const inputStream: HttpInputStream = {
      controller,
      encoder: new TextEncoder(),
      closed: false,
    };
    inputStreamRef.current = inputStream;

    const requestInit: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body,
      duplex: 'half',
      keepalive: false,
    };

    let inputRequest: Promise<Response>;
    try {
      inputRequest = fetch(
        `${apiBaseUrl()}/api/codex-cli/sessions/${encodeURIComponent(session)}/input-stream`,
        requestInit,
      );
    } catch {
      inputStream.closed = true;
      inputStreamDisabledRef.current = true;
      if (inputStreamRef.current === inputStream) {
        inputStreamRef.current = null;
      }
      return;
    }

    void inputRequest
      .then((response) => {
        if (!response.ok && inputStreamRef.current === inputStream) {
          inputStreamDisabledRef.current = true;
        }
      })
      .catch(() => {
        if (inputStreamRef.current === inputStream) {
          inputStreamDisabledRef.current = true;
        }
      })
      .finally(() => {
        if (inputStreamRef.current === inputStream) {
          inputStream.closed = true;
          inputStreamRef.current = null;
        }
      });
  }, [token]);

  const isTransportUsable = useCallback(() => {
    if (transportRef.current === 'websocket') {
      const socket = socketRef.current;
      return connectedRef.current && !!socket && socket.readyState === WebSocket.OPEN;
    }
    if (transportRef.current === 'sse') {
      const eventSource = eventSourceRef.current;
      return connectedRef.current && !!eventSource && eventSource.readyState === 1;
    }
    return false;
  }, []);

  const writeReconnectNotice = useCallback((message: string) => {
    const now = Date.now();
    if (now - lastReconnectNoticeAtRef.current < reconnectNoticeMinIntervalMs) {
      return;
    }
    lastReconnectNoticeAtRef.current = now;
    terminalRef.current?.writeln(message);
  }, []);

  const requestReconnect = useCallback(() => {
    if (hasExitedRef.current || reconnectTimerRef.current) {
      return;
    }
    const attempt = reconnectAttemptRef.current;
    reconnectAttemptRef.current = Math.min(attempt + 1, 8);
    const delay = Math.min(reconnectMaxDelayMs, reconnectMinDelayMs * 2 ** Math.min(attempt, 5));
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      setReconnectNonce((value) => value + 1);
    }, delay);
  }, []);
  requestReconnectRef.current = requestReconnect;

  const queueReconnectInput = useCallback((data: string) => {
    if (!data) {
      return;
    }
    pendingReconnectInputRef.current += data;
    if (pendingReconnectInputRef.current.length > pendingReconnectInputLimit) {
      pendingReconnectInputRef.current = pendingReconnectInputRef.current.slice(
        -pendingReconnectInputLimit,
      );
    }
  }, []);

  const markInputTransportStale = useCallback(() => {
    if (queuedInputRef.current) {
      queueReconnectInput(queuedInputRef.current);
      queuedInputRef.current = '';
    }
    if (inputFlushTimerRef.current) {
      clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }

    closeInputStream();
    inputStreamDisabledRef.current = false;

    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore close races while replacing stale transport state.
      }
    }

    const eventSource = eventSourceRef.current;
    eventSourceRef.current = null;
    if (eventSource) {
      eventSource.close();
    }

    transportRef.current = null;
    connectedRef.current = false;
    reconnectOnVisibleRef.current = false;
    resetBeforeReplayRef.current = true;
    requestReconnect();
  }, [closeInputStream, queueReconnectInput, requestReconnect]);

  const postTerminalJson = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      if (!token) {
        throw new Error('missing_auth_token');
      }
      const response = await fetch(`${apiBaseUrl()}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        keepalive: false,
      });
      if (!response.ok) {
        throw new Error(`terminal_request_failed_${response.status}`);
      }
    },
    [token],
  );

  const flushQueuedInput = useCallback(() => {
    inputFlushTimerRef.current = null;
    const data = queuedInputRef.current;
    queuedInputRef.current = '';
    const session = activeSessionIdRef.current;
    if (!data || !session || hasExitedRef.current) {
      return;
    }
    postTerminalJson(`/api/codex-cli/sessions/${encodeURIComponent(session)}/input`, { data })
      .catch(() => {
        queueReconnectInput(data);
        markInputTransportStale();
      });
  }, [markInputTransportStale, postTerminalJson, queueReconnectInput]);

  const queueHttpInput = useCallback(
    (data: string) => {
      if (!inputStreamRef.current && !inputStreamDisabledRef.current) {
        startHttpInputStream();
      }

      const inputStream = inputStreamRef.current;
      if (inputStream && !inputStream.closed) {
        try {
          inputStream.controller.enqueue(inputStream.encoder.encode(data));
          return;
        } catch {
          inputStream.closed = true;
          inputStreamRef.current = null;
          inputStreamDisabledRef.current = true;
        }
      }

      queuedInputRef.current += data;
      if (inputFlushTimerRef.current) {
        return;
      }
      inputFlushTimerRef.current = setTimeout(flushQueuedInput, httpInputFlushMs);
    },
    [flushQueuedInput, startHttpInputStream],
  );

  const flushPendingReconnectInput = useCallback(() => {
    const data = pendingReconnectInputRef.current;
    const session = activeSessionIdRef.current;
    if (!data || !session || hasExitedRef.current || !connectedRef.current) {
      return;
    }

    const socket = socketRef.current;
    if (transportRef.current === 'websocket' && socket?.readyState === WebSocket.OPEN) {
      pendingReconnectInputRef.current = '';
      try {
        socket.send(JSON.stringify({ type: 'input', data }));
      } catch {
        queueReconnectInput(data);
        markInputTransportStale();
      }
      return;
    }

    if (transportRef.current === 'sse') {
      pendingReconnectInputRef.current = '';
      queueHttpInput(data);
    }
  }, [markInputTransportStale, queueHttpInput, queueReconnectInput]);

  const sendHttpResize = useCallback((cols: number, rows: number) => {
    const session = activeSessionIdRef.current;
    if (!session || hasExitedRef.current) {
      return;
    }
    postTerminalJson(`/api/codex-cli/sessions/${encodeURIComponent(session)}/resize`, {
      cols,
      rows,
    }).catch(() => undefined);
  }, [postTerminalJson]);

  const closeTransports = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    closeInputStream();
    transportRef.current = null;
    connectedRef.current = false;
    reconnectOnVisibleRef.current = false;
    inputStreamDisabledRef.current = false;
    if (inputFlushTimerRef.current) {
      clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pendingInputFlushTimerRef.current) {
      clearTimeout(pendingInputFlushTimerRef.current);
      pendingInputFlushTimerRef.current = null;
    }
    queuedInputRef.current = '';
  }, [closeInputStream]);

  useEffect(() => {
    if (activeSessionId) {
      pendingSessionCreateRef.current = null;
      return;
    }
    if (!isAuthenticated || !token || pendingSessionCreateRef.current === terminalMode) {
      return;
    }

    let cancelled = false;
    pendingSessionCreateRef.current = terminalMode;
    reconnectCounter.current += 1;
    closeTransports();
    hasExitedRef.current = false;
    setExitInfo(null);

    const createSession = async () => {
      try {
        const session = await request.post<TerminalSessionResponse>(
          `${apiBaseUrl()}/api/codex-cli/sessions`,
          { mode: terminalMode },
        );
        if (cancelled) {
          return;
        }
        navigate(`/${routePrefix}/${session.sessionId}`, { replace: true });
      } catch {
        if (!cancelled) {
          pendingSessionCreateRef.current = null;
          terminalRef.current?.writeln('\r\n[web terminal] failed to create terminal session\r\n');
        }
      }
    };

    void createSession();

    return () => {
      cancelled = true;
    };
  }, [
    activeSessionId,
    closeTransports,
    isAuthenticated,
    navigate,
    routePrefix,
    terminalMode,
    token,
  ]);

  useEffect(() => {
    if (!activeSessionId) {
      lastSessionIdRef.current = null;
    }
  }, [activeSessionId]);

  useEffect(() => {
    const terminalKey = activeSessionId ? `${terminalMode}:${activeSessionId}` : null;
    if (!activeSessionId || lastSessionIdRef.current === terminalKey) {
      return;
    }
    reconnectCounter.current += 1;
    reconnectAttemptRef.current = 0;
    closeTransports();
    lastSessionIdRef.current = terminalKey;
    pendingReconnectInputRef.current = '';
    hasExitedRef.current = false;
    setExitInfo(null);
    terminalRef.current?.reset();
  }, [activeSessionId, closeTransports, terminalMode]);

  const fitAndNotify = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!fitAddon || !terminal) {
      return;
    }
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    const socket = socketRef.current;
    if (transportRef.current === 'websocket' && socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'resize',
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
      return;
    }
    if (transportRef.current === 'sse') {
      sendHttpResize(terminal.cols, terminal.rows);
    }
  }, [sendHttpResize]);

  const connect = useCallback(async () => {
    if (!activeSessionId || !isAuthenticated || !token || !terminalRef.current) {
      return;
    }

    reconnectCounter.current += 1;
    const connectionId = reconnectCounter.current;
    const shouldResetBeforeReplay = resetBeforeReplayRef.current;
    hasExitedRef.current = false;
    setExitInfo(null);

    closeTransports();
    resetBeforeReplayRef.current = shouldResetBeforeReplay;

    const handleTerminalMessage = (
      message: TerminalServerMessage,
      closeCurrentTransport: () => void,
    ) => {
      if (connectionId !== reconnectCounter.current) {
        return;
      }

      if (message.type === 'replay') {
        clearQueuedTerminalOutput();
        resetTerminalWriteQueue();
        terminal.reset();
        resetBeforeReplayRef.current = false;
        writeTerminalOutputRef.current(message.data ?? '', () => {
          fitAndNotify();
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
          terminalSnapshotRef.current = null;
          if (snapshotClearTimerRef.current) {
            clearTimeout(snapshotClearTimerRef.current);
            snapshotClearTimerRef.current = null;
          }
          if (pendingInputFlushTimerRef.current) {
            clearTimeout(pendingInputFlushTimerRef.current);
            pendingInputFlushTimerRef.current = null;
          }
          flushPendingReconnectInput();
        });
        return;
      }
      if (message.type === 'data') {
        if (resetBeforeReplayRef.current) {
          clearQueuedTerminalOutput();
          resetTerminalWriteQueue();
          terminal.reset();
          resetBeforeReplayRef.current = false;
        }
        queueTerminalOutput(message.data ?? '');
        return;
      }
      if (message.type === 'ready') {
        const gotDifferentSession = !!message.sessionId && message.sessionId !== activeSessionId;
        const gotDifferentMode = !!message.mode && message.mode !== terminalMode;
        if (gotDifferentSession || gotDifferentMode) {
          hasExitedRef.current = true;
          connectedRef.current = false;
          terminal.writeln(
            [
              '\r\n[web terminal] session identity mismatch; connection closed',
              `expected ${terminalMode}:${activeSessionId}`,
              `got ${message.mode ?? 'unknown'}:${message.sessionId ?? 'unknown'}`,
              message.serverPid ? `server pid ${message.serverPid}` : null,
              '\r\n',
            ]
              .filter(Boolean)
              .join(' · '),
          );
          closeCurrentTransport();
          return;
        }
        connectedRef.current = true;
        reconnectAttemptRef.current = 0;
        reconnectOnVisibleRef.current = false;
        if (pendingReconnectInputRef.current) {
          if (pendingInputFlushTimerRef.current) {
            clearTimeout(pendingInputFlushTimerRef.current);
          }
          pendingInputFlushTimerRef.current = setTimeout(() => {
            pendingInputFlushTimerRef.current = null;
            flushPendingReconnectInput();
          }, pendingReconnectInputFlushMs);
        }
        return;
      }
      if (message.type === 'exit') {
        hasExitedRef.current = true;
        connectedRef.current = false;
        setExitInfo({
          exitCode: message.exitCode,
          signal: message.signal,
        });
        flushQueuedTerminalOutput();
        terminal.writeln('\r\n[terminal exited]\r\n');
        closeCurrentTransport();
      }
    };

    const requestTicket = () =>
      request.post<TicketResponse>(`${apiBaseUrl()}/api/codex-cli/ticket`, {
        sessionId: activeSessionId,
        mode: terminalMode,
      });

    const connectWithEventSource = async () => {
      let sseTicketResponse: TicketResponse;
      try {
        sseTicketResponse = await requestTicket();
      } catch {
        if (connectionId === reconnectCounter.current && !hasExitedRef.current) {
          writeReconnectNotice('\r\n[web terminal] reconnecting...\r\n');
          requestReconnect();
        }
        return;
      }

      if (connectionId !== reconnectCounter.current) {
        return;
      }

      const url = buildEventSourceUrl({
        ticket: sseTicketResponse.ticket,
        sessionId: activeSessionId,
        mode: terminalMode,
      });
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;
      transportRef.current = 'sse';
      connectedRef.current = false;
      let sseSawReady = false;

      eventSource.addEventListener('open', () => {
        if (connectionId !== reconnectCounter.current) {
          eventSource.close();
          return;
        }
        startHttpInputStream();
        fitAndNotify();
        terminal.focus();
      });

      eventSource.addEventListener('message', (event) => {
        let message: TerminalServerMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (eventSourceRef.current !== eventSource) {
          return;
        }
        if (message.type === 'ready') {
          sseSawReady = true;
        }
        handleTerminalMessage(message, () => {
          eventSource.close();
          closeInputStream();
        });
      });

      eventSource.addEventListener('error', () => {
        if (
          connectionId === reconnectCounter.current &&
          eventSourceRef.current === eventSource &&
          terminalRef.current &&
          !hasExitedRef.current
        ) {
          writeReconnectNotice('\r\n[web terminal disconnected, reconnecting]\r\n');
        }
        if (connectionId === reconnectCounter.current && eventSourceRef.current === eventSource) {
          eventSourceRef.current = null;
          transportRef.current = null;
          connectedRef.current = false;
          if (!hasExitedRef.current) {
            resetBeforeReplayRef.current = resetBeforeReplayRef.current || sseSawReady;
            if (typeof document !== 'undefined' && document.hidden) {
              reconnectOnVisibleRef.current = true;
            } else {
              requestReconnect();
            }
          }
        }
        eventSource.close();
        closeInputStream();
      });
    };

    if (shouldStartTerminalWithHttpFallback(transportPreference)) {
      void connectWithEventSource();
      return;
    }

    let ticketResponse: TicketResponse;
    try {
      ticketResponse = await requestTicket();
    } catch {
      if (connectionId === reconnectCounter.current && !hasExitedRef.current) {
        writeReconnectNotice('\r\n[web terminal] reconnecting...\r\n');
        requestReconnect();
      }
      return;
    }

    if (connectionId !== reconnectCounter.current) {
      return;
    }

    fitAndNotify();
    const terminal = terminalRef.current;
    const url = buildWebSocketUrl({
      ticket: ticketResponse.ticket,
      sessionId: activeSessionId,
      mode: terminalMode,
      cols: terminal.cols,
      rows: terminal.rows,
    });
    const socket = new WebSocket(url);
    socketRef.current = socket;
    transportRef.current = 'websocket';
    connectedRef.current = false;
    let sawReady = false;
    let fallbackStarted = false;
    let websocketReadyAt = 0;
    let fallbackTimer: ReturnType<typeof window.setTimeout> | null = null;
    const clearFallbackTimer = () => {
      if (fallbackTimer) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };
    const startFallback = () => {
      if (fallbackStarted || sawReady || hasExitedRef.current || connectionId !== reconnectCounter.current) {
        return;
      }
      clearFallbackTimer();
      fallbackStarted = true;
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      transportRef.current = null;
      try {
        socket.close();
      } catch {
        // Ignore close races.
      }
      rememberHttpTerminalFallback();
      void connectWithEventSource();
    };
    fallbackTimer = window.setTimeout(() => {
      if (!sawReady) {
        startFallback();
      }
    }, websocketFallbackMs);

    socket.addEventListener('open', () => {
      if (connectionId !== reconnectCounter.current) {
        clearFallbackTimer();
        socket.close();
        return;
      }
      fitAndNotify();
      terminal.focus();
    });

    socket.addEventListener('message', (event) => {
      let message: {
        type?: string;
        data?: string;
        pid?: number;
        cwd?: string;
        sessionId?: string;
        mode?: TerminalMode;
        serverPid?: number;
        serverInstanceId?: string;
        exitCode?: number;
        signal?: number;
      };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (connectionId !== reconnectCounter.current || socketRef.current !== socket) {
        return;
      }

      if (message.type === 'ready') {
        sawReady = true;
        websocketReadyAt = Date.now();
        reconnectAttemptRef.current = 0;
        clearFallbackTimer();
        clearHttpTerminalFallback();
      }
      handleTerminalMessage(message, () => socket.close());
    });

    socket.addEventListener('close', () => {
      clearFallbackTimer();
      if (!sawReady) {
        startFallback();
        return;
      }
      const closedCurrentSocket = connectionId === reconnectCounter.current && socketRef.current === socket;
      if (closedCurrentSocket) {
        socketRef.current = null;
        transportRef.current = null;
        connectedRef.current = false;
        if (!hasExitedRef.current) {
          if (websocketReadyAt && Date.now() - websocketReadyAt < websocketUnstableCloseMs) {
            rememberHttpTerminalFallback();
          }
          resetBeforeReplayRef.current = true;
          if (typeof document !== 'undefined' && document.hidden) {
            reconnectOnVisibleRef.current = true;
          } else {
            requestReconnect();
          }
        }
      }
      if (
        closedCurrentSocket &&
        terminalRef.current &&
        !hasExitedRef.current
      ) {
        writeReconnectNotice('\r\n[web terminal disconnected, reconnecting]\r\n');
      }
    });

    socket.addEventListener('error', () => {
      startFallback();
    });
  }, [
    activeSessionId,
    clearQueuedTerminalOutput,
    closeInputStream,
    closeTransports,
    fitAndNotify,
    flushPendingReconnectInput,
    flushQueuedTerminalOutput,
    isAuthenticated,
    queueTerminalOutput,
    requestReconnect,
    resetTerminalWriteQueue,
    startHttpInputStream,
    terminalMode,
    token,
    transportPreference,
    writeReconnectNotice,
  ]);

  const openFreshTerminal = useCallback(() => {
    navigate(createTerminalSessionPath(terminalMode, transportPreference));
  }, [navigate, terminalMode, transportPreference]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: terminalFont,
      fontSize: terminalFontSize,
      fontWeight: 400,
      fontWeightBold: 700,
      lineHeight: 1.18,
      minimumContrastRatio: 4.5,
      scrollback: terminalScrollbackRows,
      theme: atomOneLightTheme,
      windowsMode: false,
    });
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);
    terminal.open(container);
    try {
      const renderAddon = new WebglAddon();
      renderAddon.onContextLoss(() => {
        if (renderAddonRef.current === renderAddon) {
          renderAddonRef.current = null;
        }
        renderAddon.dispose();
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      });
      terminal.loadAddon(renderAddon);
      renderAddonRef.current = renderAddon;
    } catch {
      renderAddonRef.current = null;
    }
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;
    fitAndNotify();
    terminal.focus();

    let disposed = false;
    const writeInput = (data: string) => {
      if (hasExitedRef.current) {
        return;
      }
      const socket = socketRef.current;
      if (transportRef.current === 'websocket' && socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'input', data }));
        } catch {
          queueReconnectInput(data);
          markInputTransportStale();
        }
        return;
      }
      if (transportRef.current === 'sse') {
        queueHttpInput(data);
        return;
      }
      if (activeSessionIdRef.current) {
        queueReconnectInput(data);
        resetBeforeReplayRef.current = true;
        requestReconnect();
      }
    };

    const disposeClipboardHandlers = installClipboardHandlers(terminal, container, writeInput);
    void loadTerminalFonts(terminalFontSize).then(() => {
      if (disposed) {
        return;
      }
      fitAndNotify();
      terminal.refresh(0, terminal.rows - 1);
    });

    const dataDisposable = terminal.onData((data) => {
      if (hasExitedRef.current) {
        return;
      }
      if (data === '\x03') {
        suppressTerminalResponsesUntilRef.current = Date.now() + terminalResponseSuppressMs;
      } else if (
        Date.now() < suppressTerminalResponsesUntilRef.current &&
        isTerminalQueryResponse(data)
      ) {
        return;
      }
      writeInput(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAndNotify();
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      reconnectCounter.current += 1;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      disposeClipboardHandlers();
      clearQueuedTerminalOutput();
      resetTerminalWriteQueue();
      closeTransports();
      cancelPendingSnapshot();
      if (snapshotClearTimerRef.current) {
        clearTimeout(snapshotClearTimerRef.current);
        snapshotClearTimerRef.current = null;
      }
      terminalSnapshotRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
      renderAddonRef.current = null;
    };
  }, [
    cancelPendingSnapshot,
    clearQueuedTerminalOutput,
    closeTransports,
    fitAndNotify,
    markInputTransportStale,
    queueHttpInput,
    queueReconnectInput,
    queueTerminalOutput,
    requestReconnect,
    resetTerminalWriteQueue,
  ]);

  useEffect(() => {
    connect();
  }, [connect, reconnectNonce]);

  useEffect(() => {
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    let restoreFrame = 0;
    let restoreInnerFrame = 0;
    let lastRestoreAt = 0;

    const runRestoreTerminal = () => {
      restoreFrame = 0;
      restoreInnerFrame = window.requestAnimationFrame(() => {
        restoreInnerFrame = 0;
        const terminal = terminalRef.current;
        if (!terminal || (typeof document !== 'undefined' && document.hidden)) {
          return;
        }

        flushQueuedTerminalOutput();
        fitAndNotify();
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        const needsReconnect =
          activeSessionIdRef.current &&
          !hasExitedRef.current &&
          (reconnectOnVisibleRef.current || !isTransportUsable());
        if (!needsReconnect) {
          restoreTerminalSnapshotIfBlank();
        }
        terminal.focus();

        if (transportRef.current === 'sse') {
          startHttpInputStream();
        }

        if (needsReconnect) {
          reconnectOnVisibleRef.current = false;
          resetBeforeReplayRef.current = true;
          requestReconnect();
        }
      });
    };

    const restoreTerminal = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      cancelPendingSnapshot();

      if (!terminalRef.current || restoreTimer || restoreFrame || restoreInnerFrame) {
        return;
      }

      const delay = Math.max(0, terminalRestoreThrottleMs - (Date.now() - lastRestoreAt));
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        lastRestoreAt = Date.now();
        restoreFrame = window.requestAnimationFrame(runRestoreTerminal);
      }, delay);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        scheduleTerminalSnapshot();
        closeInputStream();
        return;
      }
      cancelPendingSnapshot();
      restoreTerminal();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', restoreTerminal);
    window.addEventListener('pageshow', restoreTerminal);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', restoreTerminal);
      window.removeEventListener('pageshow', restoreTerminal);
      if (restoreTimer) {
        clearTimeout(restoreTimer);
      }
      if (restoreFrame) {
        window.cancelAnimationFrame(restoreFrame);
      }
      if (restoreInnerFrame) {
        window.cancelAnimationFrame(restoreInnerFrame);
      }
      cancelPendingSnapshot();
    };
  }, [
    cancelPendingSnapshot,
    closeInputStream,
    fitAndNotify,
    flushQueuedTerminalOutput,
    isTransportUsable,
    requestReconnect,
    restoreTerminalSnapshotIfBlank,
    scheduleTerminalSnapshot,
    startHttpInputStream,
  ]);

  return (
    <main className="codex-cli-page flex h-full min-h-0 flex-col">
      <section className="min-h-0 flex-1 overflow-hidden" onClick={() => terminalRef.current?.focus()}>
        <div ref={containerRef} className="codex-cli-terminal h-full w-full" />
      </section>
      {exitInfo && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
          <div className="pointer-events-auto flex w-full max-w-lg flex-col gap-3 rounded-lg border border-[#d9d9dc] bg-white p-4 text-[#383a42] shadow-lg sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-[#202227]">Terminal exited</p>
              <p className="mt-1 text-xs text-[#696c77]">
                exit {exitInfo.exitCode ?? 'unknown'}
                {exitInfo.signal ? ` · signal ${exitInfo.signal}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to="/"
                className="inline-flex h-9 items-center justify-center rounded-md border border-[#d9d9dc] bg-white px-3 text-sm font-medium text-[#383a42] transition-colors hover:border-[#b8bbc3] hover:bg-[#fafafa] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2]"
              >
                Home
              </Link>
              <button
                type="button"
                onClick={openFreshTerminal}
                className="inline-flex h-9 items-center justify-center rounded-md bg-[#4078f2] px-3 text-sm font-medium text-white transition-colors hover:bg-[#2f5fbe] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2] focus-visible:ring-offset-2"
              >
                New terminal
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
