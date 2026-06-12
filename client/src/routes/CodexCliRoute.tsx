import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { apiBaseUrl, request } from 'librechat-data-provider';
import copyToClipboard from 'copy-to-clipboard';
import { useAuthContext } from '~/hooks';
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

type TerminalServerMessage = {
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

const atomOneLightTheme = {
  background: '#fafafa',
  foreground: '#383a42',
  cursor: '#526fff',
  cursorAccent: '#fafafa',
  selectionBackground: '#e5e5e6',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#696c77',
  brightRed: '#ca1243',
  brightGreen: '#50a14f',
  brightYellow: '#986801',
  brightBlue: '#4078f2',
  brightMagenta: '#a626a4',
  brightCyan: '#0184bc',
  brightWhite: '#f0f0f0',
};

const terminalFont =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "Symbols Nerd Font Mono", "Roboto Mono", "SFMono-Regular", "SF Mono", "Cascadia Code", Menlo, Consolas, "Liberation Mono", monospace';
const terminalFontSize = 14;
const terminalResponseSuppressMs = 1500;
const httpInputFlushMs = 8;
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

export default function CodexCliRoute() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, token } = useAuthContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const transportRef = useRef<TerminalTransport | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const inputStreamRef = useRef<HttpInputStream | null>(null);
  const inputStreamDisabledRef = useRef(false);
  const queuedInputRef = useRef('');
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCounter = useRef(0);
  const lastSessionIdRef = useRef<string | null>(null);
  const pendingSessionCreateRef = useRef<TerminalMode | null>(null);
  const suppressTerminalResponsesUntilRef = useRef(0);
  const hasExitedRef = useRef(false);
  const [exitInfo, setExitInfo] = useState<TerminalExitInfo | null>(null);

  const terminalMode: TerminalMode = location.pathname.startsWith('/codex') ? 'codex' : 'shell';
  const routePrefix = terminalMode === 'codex' ? 'codex' : 'terminal';

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
        terminalRef.current?.writeln('\r\n[web terminal input failed]\r\n');
      });
  }, [postTerminalJson]);

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
    inputStreamDisabledRef.current = false;
    if (inputFlushTimerRef.current) {
      clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
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
  }, [activeSessionId, closeTransports, isAuthenticated, navigate, routePrefix, terminalMode, token]);

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
    closeTransports();
    lastSessionIdRef.current = terminalKey;
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
    hasExitedRef.current = false;
    setExitInfo(null);

    closeTransports();

    const handleTerminalMessage = (
      message: TerminalServerMessage,
      closeCurrentTransport: () => void,
    ) => {
      if (connectionId !== reconnectCounter.current) {
        return;
      }

      if (message.type === 'data' || message.type === 'replay') {
        terminal.write(message.data ?? '');
        return;
      }
      if (message.type === 'ready') {
        const gotDifferentSession = !!message.sessionId && message.sessionId !== activeSessionId;
        const gotDifferentMode = !!message.mode && message.mode !== terminalMode;
        if (gotDifferentSession || gotDifferentMode) {
          hasExitedRef.current = true;
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
        }
        return;
      }
      if (message.type === 'exit') {
        hasExitedRef.current = true;
        setExitInfo({
          exitCode: message.exitCode,
          signal: message.signal,
        });
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
        terminalRef.current?.writeln('\r\n[web terminal] failed to open terminal session\r\n');
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
          terminalRef.current.writeln('\r\n[web terminal disconnected]\r\n');
        }
        eventSource.close();
        closeInputStream();
      });
    };

    let ticketResponse: TicketResponse;
    try {
      ticketResponse = await requestTicket();
    } catch {
      terminalRef.current?.writeln('\r\n[web terminal] failed to open terminal session\r\n');
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
    let sawReady = false;
    let fallbackStarted = false;
    const startFallback = () => {
      if (fallbackStarted || sawReady || hasExitedRef.current || connectionId !== reconnectCounter.current) {
        return;
      }
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
      void connectWithEventSource();
    };

    socket.addEventListener('open', () => {
      if (connectionId !== reconnectCounter.current) {
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
      }
      handleTerminalMessage(message, () => socket.close());
    });

    socket.addEventListener('close', () => {
      if (!sawReady) {
        startFallback();
        return;
      }
      if (
        connectionId === reconnectCounter.current &&
        terminalRef.current &&
        !hasExitedRef.current
      ) {
        terminalRef.current.writeln('\r\n[web terminal disconnected]\r\n');
      }
    });

    socket.addEventListener('error', () => {
      startFallback();
    });
  }, [
    activeSessionId,
    closeInputStream,
    closeTransports,
    fitAndNotify,
    isAuthenticated,
    startHttpInputStream,
    terminalMode,
    token,
  ]);

  const openFreshTerminal = useCallback(() => {
    navigate(`/${routePrefix}/new`);
  }, [navigate, routePrefix]);

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
      scrollback: 50000,
      theme: atomOneLightTheme,
      windowsMode: false,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    fitAndNotify();
    terminal.focus();

    let disposed = false;
    const writeInput = (data: string) => {
      if (hasExitedRef.current) {
        return;
      }
      const socket = socketRef.current;
      if (transportRef.current === 'websocket' && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
        return;
      }
      if (transportRef.current === 'sse') {
        queueHttpInput(data);
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
      closeTransports();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [closeTransports, fitAndNotify, queueHttpInput]);

  useEffect(() => {
    connect();
  }, [connect]);

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
