const crypto = require('crypto');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { logger } = require('@librechat/data-schemas');

const DEFAULT_REPO_PATH = '/home/xieminhui/fjj/hm_os/hm-verif-kernel';
const DEFAULT_CODEX_HOME = '/home/xieminhui/fjj/.codex';
const TICKET_TTL_MS = 30_000;
const TERMINATED_SESSION_TTL_MS = 60_000;
const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

const tickets = new Map();
const sessions = new Map();
const terminatedSessions = new Map();
const serverInstanceId = crypto.randomBytes(6).toString('hex');
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
  if (trimmed === 'new') {
    return null;
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function getSessionKey(userId, sessionId) {
  return `${userId}:${sessionId}`;
}

function cleanupTickets() {
  const ts = now();
  for (const [ticket, record] of tickets.entries()) {
    if (record.expiresAt <= ts) {
      tickets.delete(ticket);
    }
  }
}

function cleanupTerminatedSessions() {
  const ts = now();
  for (const [sessionId, expiresAt] of terminatedSessions.entries()) {
    if (expiresAt <= ts) {
      terminatedSessions.delete(sessionId);
    }
  }
}

function markSessionTerminated(sessionKey) {
  cleanupTerminatedSessions();
  terminatedSessions.set(sessionKey, now() + TERMINATED_SESSION_TTL_MS);
}

function wasSessionTerminated(sessionKey) {
  cleanupTerminatedSessions();
  return terminatedSessions.has(sessionKey);
}

function createCodexCliTicket(user, options = {}) {
  cleanupTickets();
  const userId = normalizeUserId(user);
  if (!userId) {
    throw new Error('Cannot create Codex CLI ticket without an authenticated user.');
  }
  const sessionId = options.sessionId ? normalizeSessionId(options.sessionId) : null;
  if (options.sessionId && !sessionId) {
    throw new Error('Invalid terminal session id.');
  }
  const mode = normalizeMode(options.mode);

  const ticket = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now() + TICKET_TTL_MS;
  tickets.set(ticket, {
    userId,
    tenantId: user?.tenantId,
    sessionId,
    mode,
    expiresAt,
  });
  const ticketLog = {
    userId,
    sessionId,
    mode,
    serverPid: process.pid,
    serverInstanceId,
  };
  logger.info(`[CodexCliTerminal] Ticket created ${formatLogFields(ticketLog)}`, ticketLog);
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

function formatLogFields(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function serializeSession(session) {
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    pid: session.ptyProcess.pid,
    cwd: session.repoPath,
    exited: session.exited,
    clients: session.clients.size + session.eventClients.size,
    serverPid: process.pid,
    serverInstanceId,
  };
}

function writeSseMessage(res, message) {
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}

class CodexCliSession {
  constructor({ sessionId, userId, mode, cols, rows }) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.mode = mode;
    this.repoPath = getRepoPath();
    this.buffer = '';
    this.clients = new Set();
    this.eventClients = new Set();
    this.exited = false;
    this.processExited = false;
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
      this.processExited = true;
      this.finishExit({
        exitCode: event.exitCode,
        signal: event.signal,
      });
    });

    const startInfo = {
      sessionId: this.sessionId,
      sessionKey: getSessionKey(this.userId, this.sessionId),
      userId: this.userId,
      mode: this.mode,
      pid: this.ptyProcess.pid,
      cwd: this.repoPath,
      shell: shellBin,
      serverPid: process.pid,
      serverInstanceId,
    };
    logger.info(`[CodexCliTerminal] PTY started ${formatLogFields(startInfo)}`, startInfo);

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
      serverPid: process.pid,
      serverInstanceId,
    });
    if (this.buffer) {
      wsSend(ws, { type: 'replay', data: this.buffer });
    }
    if (this.exited && this.exitInfo) {
      wsSend(ws, { type: 'exit', ...this.exitInfo });
    }
  }

  attachEventStream(res) {
    const client = {
      res,
      heartbeatTimer: null,
      close: () => {
        clearInterval(client.heartbeatTimer);
        this.eventClients.delete(client);
        if (!res.destroyed) {
          res.end();
        }
      },
      send: (message) => {
        if (!res.destroyed) {
          writeSseMessage(res, message);
        }
      },
    };

    this.eventClients.add(client);
    client.heartbeatTimer = setInterval(() => {
      if (res.destroyed) {
        client.close();
        return;
      }
      res.write(': keepalive\n\n');
    }, SSE_HEARTBEAT_INTERVAL_MS);
    client.heartbeatTimer.unref?.();

    client.send({
      type: 'ready',
      sessionId: this.sessionId,
      mode: this.mode,
      pid: this.ptyProcess.pid,
      cwd: this.repoPath,
      serverPid: process.pid,
      serverInstanceId,
    });
    if (this.buffer) {
      client.send({ type: 'replay', data: this.buffer });
    }
    if (this.exited && this.exitInfo) {
      client.send({ type: 'exit', ...this.exitInfo });
      client.close();
    }

    return client;
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  broadcast(message) {
    for (const client of this.clients) {
      wsSend(client, message);
    }
    for (const client of this.eventClients) {
      client.send(message);
    }
  }

  finishExit(exitInfo = {}) {
    if (this.exited) {
      return false;
    }
    this.exited = true;
    this.exitInfo = exitInfo;
    sessions.delete(getSessionKey(this.userId, this.sessionId));
    this.broadcast({ type: 'exit', ...exitInfo });
    for (const client of this.clients) {
      try {
        client.close(1000, 'Terminal session ended');
      } catch {
        // Ignore close races.
      }
    }
    for (const client of [...this.eventClients]) {
      client.close();
    }
    const exitLog = {
      sessionId: this.sessionId,
      sessionKey: getSessionKey(this.userId, this.sessionId),
      userId: this.userId,
      mode: this.mode,
      pid: this.ptyProcess.pid,
      serverPid: process.pid,
      serverInstanceId,
      ...exitInfo,
    };
    logger.info(`[CodexCliTerminal] PTY exited ${formatLogFields(exitLog)}`, exitLog);
    return true;
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
    this.finishExit({ signal: 15 });
    try {
      this.killProcessGroup('SIGTERM');
      this.ptyProcess.kill('SIGTERM');
      setTimeout(() => {
        if (!this.processExited) {
          this.killProcessGroup('SIGKILL');
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

  killProcessGroup(signal) {
    const pid = Number(this.ptyProcess?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        logger.warn('[CodexCliTerminal] PTY process group kill failed', {
          sessionId: this.sessionId,
          pid,
          signal,
          error: error?.message ?? error,
        });
      }
    }
  }
}

function createCodexCliSession(user, options = {}) {
  const userId = normalizeUserId(user);
  if (!userId) {
    throw new Error('Cannot create terminal session without an authenticated user.');
  }
  const mode = normalizeMode(options.mode);
  const cols = clampTerminalSize(options.cols, 120, 20, 300);
  const rows = clampTerminalSize(options.rows, 36, 8, 120);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sessionId = crypto.randomUUID();
    const sessionKey = getSessionKey(userId, sessionId);
    if (sessions.has(sessionKey) || wasSessionTerminated(sessionKey)) {
      continue;
    }
    const session = new CodexCliSession({ sessionId, userId, mode, cols, rows });
    sessions.set(sessionKey, session);
    const createLog = {
      sessionId,
      sessionKey,
      userId,
      mode,
      pid: session.ptyProcess.pid,
      serverPid: process.pid,
      serverInstanceId,
    };
    logger.info(`[CodexCliTerminal] Session created ${formatLogFields(createLog)}`, createLog);
    return serializeSession(session);
  }

  throw new Error('Unable to allocate terminal session id.');
}

function getSessionForAttach({ sessionId, userId, mode }) {
  const sessionKey = getSessionKey(userId, sessionId);
  if (wasSessionTerminated(sessionKey)) {
    const endedSession = sessions.get(sessionKey);
    if (endedSession && !endedSession.exited) {
      endedSession.terminate();
    }
    throw new Error('Terminal session was ended.');
  }
  const existing = sessions.get(sessionKey);
  if (!existing) {
    throw new Error('Terminal session does not exist.');
  }
  if (existing.exited || existing.processExited) {
    sessions.delete(sessionKey);
    throw new Error('Terminal session has exited.');
  }
  if (existing.mode !== mode) {
    throw new Error('Codex CLI session mode mismatch.');
  }
  const attachLog = {
    sessionId,
    sessionKey,
    userId,
    mode,
    pid: existing.ptyProcess.pid,
    clients: existing.clients.size,
    serverPid: process.pid,
    serverInstanceId,
  };
  logger.info(`[CodexCliTerminal] PTY session attach ${formatLogFields(attachLog)}`, attachLog);
  return existing;
}

function getActiveSession({ sessionId, userId }) {
  const sessionKey = getSessionKey(userId, sessionId);
  if (wasSessionTerminated(sessionKey)) {
    const endedSession = sessions.get(sessionKey);
    if (endedSession && !endedSession.exited) {
      endedSession.terminate();
    }
    throw new Error('Terminal session was ended.');
  }
  const existing = sessions.get(sessionKey);
  if (!existing) {
    throw new Error('Terminal session does not exist.');
  }
  if (existing.exited || existing.processExited) {
    sessions.delete(sessionKey);
    throw new Error('Terminal session has exited.');
  }
  return existing;
}

function getCodexCliSessions(user) {
  const userId = normalizeUserId(user);
  if (!userId) {
    return [];
  }
  const visibleSessions = [...sessions.values()]
    .filter((session) => session.userId === userId)
    .map(serializeSession);
  const listLog = {
    userId,
    count: visibleSessions.length,
    sessionIds: visibleSessions.map((session) => `${session.mode}:${session.sessionId}`).join(','),
    serverPid: process.pid,
    serverInstanceId,
  };
  logger.info(`[CodexCliTerminal] Sessions listed ${formatLogFields(listLog)}`, listLog);
  return visibleSessions;
}

function terminateCodexCliSession(sessionId, user) {
  const userId = normalizeUserId(user);
  if (!userId) {
    return { ok: false, reason: 'missing_user', serverPid: process.pid, serverInstanceId };
  }
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) {
    return { ok: false, reason: 'invalid_session_id', serverPid: process.pid, serverInstanceId };
  }
  const sessionKey = getSessionKey(userId, normalized);
  markSessionTerminated(sessionKey);
  const session = sessions.get(sessionKey);
  if (!session) {
    const absentLog = {
      sessionId: normalized,
      sessionKey,
      userId,
      serverPid: process.pid,
      serverInstanceId,
    };
    logger.info(
      `[CodexCliTerminal] Terminal session already absent during terminate ${formatLogFields(absentLog)}`,
      absentLog,
    );
    return {
      ok: true,
      sessionId: normalized,
      alreadyEnded: true,
      serverPid: process.pid,
      serverInstanceId,
    };
  }
  const pid = session.ptyProcess?.pid;
  session.terminate();
  const terminateLog = {
    sessionId: normalized,
    sessionKey,
    userId,
    mode: session.mode,
    pid,
    serverPid: process.pid,
    serverInstanceId,
  };
  logger.info(
    `[CodexCliTerminal] Terminal session terminate requested ${formatLogFields(terminateLog)}`,
    terminateLog,
  );
  return { ok: true, sessionId: normalized, pid, serverPid: process.pid, serverInstanceId };
}

function attachCodexCliEventStream({ ticket: ticketValue, sessionId: sessionIdValue, mode, res }) {
  const ticket = consumeTicket(ticketValue);
  if (!ticket) {
    res.status(401).json({ ok: false, reason: 'Unauthorized' });
    return null;
  }

  const sessionId = normalizeSessionId(sessionIdValue);
  if (!sessionId) {
    res.status(400).json({ ok: false, reason: 'Invalid terminal session id.' });
    return null;
  }

  const normalizedMode = normalizeMode(mode);
  if (
    (ticket.sessionId && ticket.sessionId !== sessionId) ||
    (ticket.mode && ticket.mode !== normalizedMode)
  ) {
    const mismatchLog = {
      ticketSessionId: ticket.sessionId,
      querySessionId: sessionId,
      ticketMode: ticket.mode,
      queryMode: normalizedMode,
      userId: ticket.userId,
      serverPid: process.pid,
      serverInstanceId,
    };
    logger.warn(
      `[CodexCliTerminal] SSE ticket mismatch ${formatLogFields(mismatchLog)}`,
      mismatchLog,
    );
    res.status(403).json({ ok: false, reason: 'Forbidden' });
    return null;
  }

  let session;
  try {
    session = getSessionForAttach({
      sessionId,
      userId: ticket.userId,
      mode: normalizedMode,
    });
  } catch (error) {
    const attachError = {
      sessionId,
      sessionKey: getSessionKey(ticket.userId, sessionId),
      userId: ticket.userId,
      mode: normalizedMode,
      serverPid: process.pid,
      serverInstanceId,
      error: error?.message ?? error,
    };
    logger.warn(`[CodexCliTerminal] SSE attach failed ${formatLogFields(attachError)}`, attachError);
    res.status(404).json({ ok: false, reason: 'Terminal session unavailable.' });
    return null;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const client = session.attachEventStream(res);
  return { client, session };
}

function writeCodexCliSessionInput(sessionIdValue, user, data) {
  const userId = normalizeUserId(user);
  const sessionId = normalizeSessionId(sessionIdValue);
  if (!userId || !sessionId) {
    return { ok: false, reason: 'invalid_request', serverPid: process.pid, serverInstanceId };
  }
  if (typeof data !== 'string' || data.length > 65536) {
    return { ok: false, reason: 'invalid_input', serverPid: process.pid, serverInstanceId };
  }
  try {
    const session = getActiveSession({ sessionId, userId });
    session.write(data);
    return { ok: true, sessionId, serverPid: process.pid, serverInstanceId };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || 'unable_to_write',
      serverPid: process.pid,
      serverInstanceId,
    };
  }
}

function attachCodexCliInputStream(sessionIdValue, user, req, res) {
  const userId = normalizeUserId(user);
  const sessionId = normalizeSessionId(sessionIdValue);
  if (!userId || !sessionId) {
    res.status(400).json({ ok: false, reason: 'invalid_request' });
    return null;
  }

  let session;
  try {
    session = getActiveSession({ sessionId, userId });
  } catch (error) {
    res.status(404).json({
      ok: false,
      reason: error?.message || 'Terminal session unavailable.',
    });
    return null;
  }

  const decoder = new StringDecoder('utf8');
  const streamLog = {
    sessionId,
    sessionKey: getSessionKey(userId, sessionId),
    userId,
    mode: session.mode,
    pid: session.ptyProcess.pid,
    serverPid: process.pid,
    serverInstanceId,
  };
  logger.info(`[CodexCliTerminal] HTTP input stream attach ${formatLogFields(streamLog)}`, streamLog);

  req.on('data', (chunk) => {
    if (session.exited) {
      return;
    }
    const data = decoder.write(chunk);
    if (data) {
      session.write(data);
    }
  });

  req.on('end', () => {
    const data = decoder.end();
    if (data && !session.exited) {
      session.write(data);
    }
    if (!res.headersSent) {
      res.status(204).end();
      return;
    }
    res.end();
  });

  req.on('close', () => {
    const closeLog = {
      sessionId,
      sessionKey: getSessionKey(userId, sessionId),
      userId,
      mode: session.mode,
      pid: session.ptyProcess.pid,
      serverPid: process.pid,
      serverInstanceId,
    };
    logger.info(
      `[CodexCliTerminal] HTTP input stream closed ${formatLogFields(closeLog)}`,
      closeLog,
    );
  });

  req.on('error', (error) => {
    logger.warn('[CodexCliTerminal] HTTP input stream failed', {
      sessionId,
      userId,
      error: error?.message ?? error,
    });
  });

  return { session };
}

function resizeCodexCliSession(sessionIdValue, user, options = {}) {
  const userId = normalizeUserId(user);
  const sessionId = normalizeSessionId(sessionIdValue);
  if (!userId || !sessionId) {
    return { ok: false, reason: 'invalid_request', serverPid: process.pid, serverInstanceId };
  }
  try {
    const session = getActiveSession({ sessionId, userId });
    const cols = clampTerminalSize(options.cols, 120, 20, 300);
    const rows = clampTerminalSize(options.rows, 36, 8, 120);
    session.resize(cols, rows);
    return { ok: true, sessionId, cols, rows, serverPid: process.pid, serverInstanceId };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || 'unable_to_resize',
      serverPid: process.pid,
      serverInstanceId,
    };
  }
}

function shutdownCodexCliTerminal() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const session of [...sessions.values()]) {
    session.terminate();
  }
  if (websocketServer) {
    websocketServer.close();
    websocketServer = null;
  }
}

function handleWsConnection(ws, _request, params) {
  const { userId, sessionId, mode, cols, rows } = params;
  let session;
  try {
    session = getSessionForAttach({ sessionId, userId, mode, cols, rows });
    session.attach(ws);
  } catch (error) {
    const attachError = {
      sessionId,
      sessionKey: getSessionKey(userId, sessionId),
      userId,
      mode,
      serverPid: process.pid,
      serverInstanceId,
      error: error?.message ?? error,
    };
    logger.warn(
      `[CodexCliTerminal] WebSocket attach failed ${formatLogFields(attachError)}`,
      attachError,
    );
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

    if ((ticket.sessionId && ticket.sessionId !== sessionId) || (ticket.mode && ticket.mode !== mode)) {
      const mismatchLog = {
        ticketSessionId: ticket.sessionId,
        querySessionId: sessionId,
        ticketMode: ticket.mode,
        queryMode: mode,
        userId: ticket.userId,
        serverPid: process.pid,
        serverInstanceId,
      };
      logger.warn(
        `[CodexCliTerminal] WebSocket ticket mismatch ${formatLogFields(mismatchLog)}`,
        mismatchLog,
      );
      closeSocket(socket, 403, 'Forbidden');
      return;
    }

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

module.exports = {
  attachCodexCliEventStream,
  attachCodexCliInputStream,
  attachCodexCliTerminal,
  createCodexCliSession,
  createCodexCliTicket,
  getCodexCliSessions,
  resizeCodexCliSession,
  shutdownCodexCliTerminal,
  terminateCodexCliSession,
  writeCodexCliSessionInput,
};
