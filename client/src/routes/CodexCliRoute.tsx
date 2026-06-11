import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
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

function createSessionId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

function installClipboardHandlers(terminal: Terminal, container: HTMLDivElement) {
  terminal.attachCustomKeyEventHandler((event) => {
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
  const suppressTerminalResponsesUntilRef = useRef(0);

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
      return;
    }
    navigate(`/${routePrefix}/${createSessionId()}`, { replace: true });
  }, [activeSessionId, navigate, routePrefix]);

  useEffect(() => {
    const terminalKey = activeSessionId ? `${terminalMode}:${activeSessionId}` : null;
    if (!activeSessionId || lastSessionIdRef.current === terminalKey) {
      return;
    }
    lastSessionIdRef.current = terminalKey;
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

    socketRef.current?.close();
    socketRef.current = null;

    let ticketResponse: TicketResponse;
    try {
      ticketResponse = await request.post(`${apiBaseUrl()}/api/codex-cli/ticket`, {});
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
        mode?: TerminalMode;
        exitCode?: number;
        signal?: number;
      };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === 'data' || message.type === 'replay') {
        terminal.write(message.data ?? '');
        return;
      }
      if (message.type === 'ready') {
        return;
      }
      if (message.type === 'exit') {
        terminal.writeln('\r\n[terminal exited]\r\n');
      }
    });

    socket.addEventListener('close', () => {
      if (connectionId === reconnectCounter.current && terminalRef.current) {
        terminalRef.current.writeln('\r\n[web terminal disconnected]\r\n');
      }
    });

    socket.addEventListener('error', () => {
      if (connectionId === reconnectCounter.current) {
        terminalRef.current?.writeln('\r\n[web terminal connection error]\r\n');
      }
    });
  }, [activeSessionId, fitAndNotify, isAuthenticated, terminalMode, token]);

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
    const disposeClipboardHandlers = installClipboardHandlers(terminal, container);
    void loadTerminalFonts(terminalFontSize).then(() => {
      if (disposed) {
        return;
      }
      fitAndNotify();
      terminal.refresh(0, terminal.rows - 1);
    });

    const dataDisposable = terminal.onData((data) => {
      if (data === '\x03') {
        suppressTerminalResponsesUntilRef.current = Date.now() + terminalResponseSuppressMs;
      } else if (
        Date.now() < suppressTerminalResponsesUntilRef.current &&
        isTerminalQueryResponse(data)
      ) {
        return;
      }
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
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
    </main>
  );
}
