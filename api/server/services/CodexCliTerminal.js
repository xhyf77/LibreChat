const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { logger } = require('@librechat/data-schemas');

const DEFAULT_REPO_PATH = '/home/xieminhui/fjj/hm_os/hm-verif-kernel';
const DEFAULT_CODEX_HOME = '/home/xieminhui/fjj/.codex';
const TICKET_TTL_MS = 30_000;
const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

const tickets = new Map();
const sessions = new Map();
let websocketServer = null;
let heartbeatTimer = null;

function now() {
  return Date.now();
}

function getRepoPath() {
  return path.resolve(process.env.CODEX_CLI_REPO_PATH || DEFAULT_REPO_PATH);
}

function getCodexHome() {
  return path.resolve(process.env.CODEX_HOME || process.env.CODEX_CLI_HOME || DEFAULT_CODEX_HOME);
}

function getCodexBin() {
  return process.env.CODEX_CLI_BIN || 'codex';
}

function getShellBin() {
  return process.env.WEB_TERMINAL_SHELL || process.env.SHELL || '/bin/zsh';
}

function getShellArgs(shellBin) {
  const shellName = path.basename(shellBin);
  if (shellName === 'bash' || shellName === 'zsh') {
    return ['-l'];
  }
  return [];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function normalizeMode(value) {
  if (value === 'codex') {
    return 'codex';
  }
  return 'shell';
}

function normalizeUserId(user) {
  return user?.id?.toString?.() || user?._id?.toString?.() || '';
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function cleanupTickets() {
  const ts = now();
  for (const [ticket, record] of tickets.entries()) {
    if (record.expiresAt <= ts) {
      tickets.delete(ticket);
    }
  }
}

function createCodexCliTicket(user) {
  cleanupTickets();
  const userId = normalizeUserId(user);
  if (!userId) {
    throw new Error('Cannot create Codex CLI ticket without an authenticated user.');
  }

  const ticket = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now() + TICKET_TTL_MS;
  tickets.set(ticket, {
    userId,
    tenantId: user?.tenantId,
    expiresAt,
  });
  return {
    ticket,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function consumeTicket(ticket) {
  cleanupTickets();
  if (typeof ticket !== 'string' || !ticket) {
    return null;
  }
  const record = tickets.get(ticket);
  tickets.delete(ticket);
  if (!record || record.expiresAt <= now()) {
    return null;
  }
  return record;
}

function wsSend(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function closeSocket(socket, statusCode, message) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      '\r\n',
  );
  socket.destroy();
}

function clampTerminalSize(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

class CodexCliSession {
  constructor({ sessionId, userId, mode, cols, rows }) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.mode = mode;
    this.repoPath = getRepoPath();
    this.buffer = '';
    this.clients = new Set();
    this.exited = false;
    this.exitInfo = null;

    const env = {
      ...process.env,
      CODEX_HOME: getCodexHome(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
    };
    delete env.NO_COLOR;

    const shellBin = getShellBin();
    const shellArgs = getShellArgs(shellBin);

    this.ptyProcess = pty.spawn(shellBin, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.repoPath,
      env,
    });

    this.ptyProcess.onData((data) => {
      this.appendBuffer(data);
      this.broadcast({ type: 'data', data });
    });

    this.ptyProcess.onExit((event) => {
      this.exited = true;
      this.exitInfo = {
        exitCode: event.exitCode,
        signal: event.signal,
      };
      this.broadcast({ type: 'exit', ...this.exitInfo });
      sessions.delete(this.sessionId);
      logger.info('[CodexCliTerminal] PTY exited', {
        sessionId: this.sessionId,
        mode: this.mode,
        pid: this.ptyProcess.pid,
        ...this.exitInfo,
      });
    });

    logger.info('[CodexCliTerminal] PTY started', {
      sessionId: this.sessionId,
      mode: this.mode,
      pid: this.ptyProcess.pid,
      cwd: this.repoPath,
      shell: shellBin,
    });

    if (this.mode === 'codex') {
      const command = [
        shellQuote(getCodexBin()),
        '--no-alt-screen',
        '-C',
        shellQuote(this.repoPath),
        '-s',
        'danger-full-access',
        '-a',
        'never',
      ].join(' ');
      setTimeout(() => {
        this.write(`${command}\r`);
      }, 100);
    }
  }

  appendBuffer(data) {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer, 'utf8') <= MAX_REPLAY_BYTES) {
      return;
    }
    let bytes = 0;
    let start = this.buffer.length;
    while (start > 0 && bytes < MAX_REPLAY_BYTES) {
      start -= 1;
      bytes += Buffer.byteLength(this.buffer[start], 'utf8');
    }
    this.buffer = this.buffer.slice(start);
  }

  attach(ws) {
    this.clients.add(ws);
    wsSend(ws, {
      type: 'ready',
      sessionId: this.sessionId,
      mode: this.mode,
      pid: this.ptyProcess.pid,
      cwd: this.repoPath,
    });
    if (this.buffer) {
      wsSend(ws, { type: 'replay', data: this.buffer });
    }
    if (this.exited && this.exitInfo) {
      wsSend(ws, { type: 'exit', ...this.exitInfo });
    }
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  broadcast(message) {
    for (const client of this.clients) {
      wsSend(client, message);
    }
  }

  write(data) {
    if (this.exited || typeof data !== 'string') {
      return;
    }
    this.ptyProcess.write(data);
  }

  resize(cols, rows) {
    if (this.exited) {
      return;
    }
    try {
      this.ptyProcess.resize(cols, rows);
    } catch (error) {
      logger.warn('[CodexCliTerminal] PTY resize failed', {
        sessionId: this.sessionId,
        error: error?.message ?? error,
      });
    }
  }

  interrupt() {
    this.write('\x03');
  }

  terminate() {
    if (this.exited) {
      return;
    }
    try {
      this.ptyProcess.kill('SIGTERM');
      setTimeout(() => {
        if (!this.exited) {
          this.ptyProcess.kill('SIGKILL');
        }
      }, 1500).unref?.();
    } catch (error) {
      logger.warn('[CodexCliTerminal] PTY terminate failed', {
        sessionId: this.sessionId,
        error: error?.message ?? error,
      });
    }
  }
}

function getOrCreateSession({ sessionId, userId, mode, cols, rows }) {
  const existing = sessions.get(sessionId);
  if (existing) {
    if (existing.userId !== userId) {
      throw new Error('Codex CLI session belongs to another user.');
    }
    if (existing.mode !== mode) {
      throw new Error('Codex CLI session mode mismatch.');
    }
    return existing;
  }
  const session = new CodexCliSession({ sessionId, userId, mode, cols, rows });
  sessions.set(sessionId, session);
  return session;
}

function handleWsConnection(ws, params) {
  const { userId, sessionId, mode, cols, rows } = params;
  let session;
  try {
    session = getOrCreateSession({ sessionId, userId, mode, cols, rows });
    session.attach(ws);
  } catch (error) {
    logger.warn('[CodexCliTerminal] WebSocket attach failed', {
      sessionId,
      error: error?.message ?? error,
    });
    ws.close(1011, 'Failed to start Codex CLI');
    return;
  }

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message?.type === 'input') {
      session.write(message.data);
      return;
    }
    if (message?.type === 'resize') {
      const nextCols = clampTerminalSize(message.cols, 120, 20, 300);
      const nextRows = clampTerminalSize(message.rows, 36, 8, 120);
      session.resize(nextCols, nextRows);
      return;
    }
    if (message?.type === 'interrupt') {
      session.interrupt();
      return;
    }
    if (message?.type === 'terminate') {
      session.terminate();
    }
  });

  ws.on('close', () => {
    session.detach(ws);
  });
}

function attachCodexCliTerminal(server) {
  if (websocketServer) {
    return websocketServer;
  }

  websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      return;
    }

    if (url.pathname !== '/api/codex-cli/terminal') {
      return;
    }

    const ticket = consumeTicket(url.searchParams.get('ticket'));
    if (!ticket) {
      closeSocket(socket, 401, 'Unauthorized');
      return;
    }

    const sessionId = normalizeSessionId(url.searchParams.get('sessionId'));
    if (!sessionId) {
      closeSocket(socket, 400, 'Bad Request');
      return;
    }

    const cols = clampTerminalSize(url.searchParams.get('cols'), 120, 20, 300);
    const rows = clampTerminalSize(url.searchParams.get('rows'), 36, 8, 120);
    const mode = normalizeMode(url.searchParams.get('mode'));

    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      websocketServer.emit('connection', ws, request, {
        userId: ticket.userId,
        sessionId,
        mode,
        cols,
        rows,
      });
    });
  });

  websocketServer.on('connection', handleWsConnection);

  heartbeatTimer = setInterval(() => {
    for (const client of websocketServer.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  logger.info('[CodexCliTerminal] WebSocket terminal attached at /api/codex-cli/terminal');
  return websocketServer;
}

function getCodexCliSessions(user) {
  const userId = normalizeUserId(user);
  return [...sessions.values()]
    .filter((session) => !userId || session.userId === userId)
    .map((session) => ({
      sessionId: session.sessionId,
      mode: session.mode,
      pid: session.ptyProcess.pid,
      cwd: session.repoPath,
      exited: session.exited,
      clients: session.clients.size,
    }));
}

function terminateCodexCliSession(sessionId, user) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) {
    return false;
  }
  const session = sessions.get(normalized);
  if (!session) {
    return false;
  }
  const userId = normalizeUserId(user);
  if (userId && session.userId !== userId) {
    return false;
  }
  session.terminate();
  return true;
}

function shutdownCodexCliTerminal() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const session of sessions.values()) {
    session.terminate();
  }
  if (websocketServer) {
    websocketServer.close();
    websocketServer = null;
  }
}

module.exports = {
  attachCodexCliTerminal,
  createCodexCliTicket,
  getCodexCliSessions,
  shutdownCodexCliTerminal,
  terminateCodexCliSession,
};
