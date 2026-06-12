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
    socketRef.current?.close();
    socketRef.current = null;
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
  }, [activeSessionId, isAuthenticated, navigate, routePrefix, terminalMode, token]);

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
    socketRef.current?.close();
    socketRef.current = null;
    lastSessionIdRef.current = terminalKey;
    hasExitedRef.current = false;
    setExitInfo(null);
    terminalRef.current?.reset();
  }, [activeSessionId, terminalMode]);

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
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'resize',
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
    }
  }, []);

  const connect = useCallback(async () => {
    if (!activeSessionId || !isAuthenticated || !token || !terminalRef.current) {
      return;
    }

    reconnectCounter.current += 1;
    const connectionId = reconnectCounter.current;
    hasExitedRef.current = false;
    setExitInfo(null);

    socketRef.current?.close();
    socketRef.current = null;

    let ticketResponse: TicketResponse;
    try {
      ticketResponse = await request.post(`${apiBaseUrl()}/api/codex-cli/ticket`, {
        sessionId: activeSessionId,
        mode: terminalMode,
      });
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
          socket.close();
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
        socket.close();
      }
    });

    socket.addEventListener('close', () => {
      if (
        connectionId === reconnectCounter.current &&
        terminalRef.current &&
        !hasExitedRef.current
      ) {
        terminalRef.current.writeln('\r\n[web terminal disconnected]\r\n');
      }
    });

    socket.addEventListener('error', () => {
      if (connectionId === reconnectCounter.current) {
        terminalRef.current?.writeln('\r\n[web terminal connection error]\r\n');
      }
    });
  }, [activeSessionId, fitAndNotify, isAuthenticated, terminalMode, token]);

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
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
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
      socketRef.current?.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [fitAndNotify]);

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
