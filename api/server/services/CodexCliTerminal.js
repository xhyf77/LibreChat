const crypto = require('crypto');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { logger } = require('@librechat/data-schemas');

const DEFAULT_REPO_PATH = '/srv/work/example-repo';
const DEFAULT_CODEX_HOME = '/home/connect/.codex';
const TICKET_TTL_MS = 30_000;
const TERMINATED_SESSION_TTL_MS = 60_000;
const MAX_REPLAY_BYTES = 192 * 1024;
const REPLAY_TRIM_TARGET_BYTES = Math.floor(MAX_REPLAY_BYTES * 0.75);
const DEFAULT_REPLAY_SCROLLBACK_ROWS = 400;
const COMPACT_REPLAY_SCROLLBACK_ROWS = 80;
const MAX_ATTACH_BACKLOG_BYTES = 1024 * 1024;
const LIVE_OUTPUT_FLUSH_MS = 2;
const LIVE_OUTPUT_IMMEDIATE_CHARS = 512;
const LIVE_OUTPUT_FLUSH_CHARS = 64 * 1024;
const OUTPUT_HISTORY_MAX_BYTES = 1024 * 1024;
const HEADLESS_WRITE_FLUSH_MS = 16;
const HEADLESS_WRITE_FLUSH_CHARS = 128 * 1024;
const HEADLESS_MAX_PENDING_BYTES = 2 * 1024 * 1024;
const HEADLESS_REPLAY_WAIT_MS = 250;
const WS_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const SSE_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const SSE_CLIENT_HIGH_WATER_BYTES = 384 * 1024;
const SSE_CLIENT_LOW_WATER_BYTES = 96 * 1024;
const SSE_CLIENT_ACK_TIMEOUT_MS = 30_000;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_INPUT_BATCH_BYTES = 128 * 1024;
const MAX_INPUT_CLIENT_PENDING_BYTES = 1024 * 1024;
const MAX_INPUT_CLIENT_PENDING_FRAMES = 2048;
const MAX_INPUT_STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_INPUT_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_STREAM_LINE_BYTES = 256 * 1024;
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
  if (ws.readyState !== ws.OPEN) {
    return false;
  }
  if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
    try {
      ws.close(1013, 'Terminal client is too far behind');
    } catch {
      // Ignore close races.
    }
    return false;
  }
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    try {
      ws.close(1011, 'Terminal send failed');
    } catch {
      // Ignore close races.
    }
    return false;
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

function getReplayScrollbackRows() {
  return clampTerminalSize(
    process.env.CODEX_CLI_REPLAY_SCROLLBACK_ROWS,
    DEFAULT_REPLAY_SCROLLBACK_ROWS,
    100,
    50000,
  );
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
  if (res.destroyed || res.writableEnded || res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    return false;
  }
  try {
    const eventId = Number.isSafeInteger(message?.seq) ? `id: ${message.seq}\n` : '';
    const ok = res.write(`${eventId}data: ${JSON.stringify(message)}\n\n`);
    res.flush?.();
    return ok || res.writableLength <= SSE_MAX_BUFFERED_BYTES;
  } catch {
    return false;
  }
}

function isValidInputData(data, maxBytes = MAX_INPUT_BYTES) {
  return typeof data === 'string' && Buffer.byteLength(data, 'utf8') <= maxBytes;
}

function normalizeResumeSeq(value) {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    return 0;
  }
  return seq;
}

function normalizeInputClientId(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function normalizeInputSeq(value) {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    return 0;
  }
  return seq;
}

function normalizeInputFrame(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const seq = normalizeInputSeq(value.seq);
  const data = typeof value.data === 'string' ? value.data : null;
  if (!seq || data == null || !isValidInputData(data)) {
    return null;
  }
  return { seq, data, bytes: Buffer.byteLength(data, 'utf8') };
}

function normalizeInputBatch(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const inputClientId = normalizeInputClientId(input.inputClientId);
  if (!inputClientId) {
    return null;
  }
  const rawFrames = Array.isArray(input.chunks) ? input.chunks : [input];
  const frames = [];
  let totalBytes = 0;
  for (const rawFrame of rawFrames) {
    const frame = normalizeInputFrame(rawFrame);
    if (!frame) {
      return null;
    }
    totalBytes += frame.bytes;
    if (totalBytes > MAX_INPUT_BATCH_BYTES) {
      return null;
    }
    frames.push(frame);
  }
  return frames.length > 0 ? { inputClientId, frames } : null;
}

function timeout(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

class CodexCliSession {
  constructor({ sessionId, userId, mode, cols, rows }) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.mode = mode;
    this.repoPath = getRepoPath();
    this.buffer = '';
    this.bufferBytes = 0;
    this.clients = new Set();
    this.eventClients = new Set();
    this.inputClients = new Map();
    this.outputPaused = false;
    this.exited = false;
    this.processExited = false;
    this.exitInfo = null;
    this.replaySeq = 0;
    this.outputHistory = [];
    this.outputHistoryBytes = 0;
    this.liveOutputBuffer = '';
    this.liveOutputSeq = 0;
    this.liveOutputTimer = null;
    this.headlessPendingBuffer = '';
    this.headlessPendingBytes = 0;
    this.headlessFlushTimer = null;
    this.headlessWriteChain = Promise.resolve();
    this.headlessWriteFailed = false;
    this.headlessTerminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: getReplayScrollbackRows(),
    });
    this.serializeAddon = new SerializeAddon();
    this.headlessTerminal.loadAddon(this.serializeAddon);

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
      const seq = this.queueHeadlessWrite(data);
      this.appendOutputHistory(data, seq);
      this.queueLiveOutput(data, seq);
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

  hasLiveClients() {
    return this.clients.size > 0 || this.eventClients.size > 0;
  }

  refreshOutputFlowControl() {
    const shouldPause = [...this.eventClients].some(
      (client) => !client.closed && client.unackedBytes > SSE_CLIENT_HIGH_WATER_BYTES,
    );
    const shouldResume = [...this.eventClients].every(
      (client) => client.closed || client.unackedBytes < SSE_CLIENT_LOW_WATER_BYTES,
    );

    if (shouldPause && !this.outputPaused) {
      this.outputPaused = true;
      this.ptyProcess.pause?.();
      return;
    }
    if (this.outputPaused && shouldResume) {
      this.outputPaused = false;
      this.ptyProcess.resume?.();
    }
  }

  ackEventClient(clientId, bytes) {
    if (!clientId || !Number.isFinite(bytes) || bytes <= 0) {
      return false;
    }
    for (const client of this.eventClients) {
      if (client.id !== clientId || client.closed) {
        continue;
      }
      client.unackedBytes = Math.max(0, client.unackedBytes - bytes);
      client.lastAckAt = now();
      this.refreshOutputFlowControl();
      return true;
    }
    return false;
  }

  getInputClientState(inputClientId) {
    let state = this.inputClients.get(inputClientId);
    if (!state) {
      state = {
        lastSeq: 0,
        pending: new Map(),
        pendingBytes: 0,
      };
      this.inputClients.set(inputClientId, state);
    }
    return state;
  }

  sendInputAck(inputClientId, inputSeq) {
    if (!inputClientId || !Number.isSafeInteger(inputSeq)) {
      return;
    }
    this.broadcast({ type: 'inputAck', inputClientId, inputSeq });
  }

  applyInputFrames(inputClientId, frames) {
    if (!inputClientId || !Array.isArray(frames) || frames.length === 0) {
      return 0;
    }
    const state = this.getInputClientState(inputClientId);
    for (const frame of frames) {
      if (!frame || frame.seq <= state.lastSeq || state.pending.has(frame.seq)) {
        continue;
      }
      state.pending.set(frame.seq, {
        data: frame.data,
        bytes: frame.bytes ?? Buffer.byteLength(frame.data, 'utf8'),
      });
      state.pendingBytes += frame.bytes ?? Buffer.byteLength(frame.data, 'utf8');
      if (
        state.pending.size > MAX_INPUT_CLIENT_PENDING_FRAMES ||
        state.pendingBytes > MAX_INPUT_CLIENT_PENDING_BYTES
      ) {
        throw new Error('input_client_backlog_too_large');
      }
    }

    let nextSeq = state.lastSeq + 1;
    while (state.pending.has(nextSeq)) {
      const nextFrame = state.pending.get(nextSeq);
      state.pending.delete(nextSeq);
      state.pendingBytes = Math.max(0, state.pendingBytes - (nextFrame?.bytes || 0));
      if (nextFrame?.data && !this.exited) {
        this.write(nextFrame.data);
      }
      state.lastSeq = nextSeq;
      nextSeq += 1;
    }

    this.sendInputAck(inputClientId, state.lastSeq);
    return state.lastSeq;
  }

  cancelLiveOutputTimer() {
    if (!this.liveOutputTimer) {
      return;
    }
    clearTimeout(this.liveOutputTimer);
    this.liveOutputTimer = null;
  }

  flushLiveOutput() {
    this.cancelLiveOutputTimer();
    const data = this.liveOutputBuffer;
    const seq = this.liveOutputSeq || this.replaySeq;
    this.liveOutputBuffer = '';
    this.liveOutputSeq = 0;
    if (!data || !this.hasLiveClients()) {
      return;
    }
    this.broadcast({ type: 'data', data, seq });
  }

  queueLiveOutput(data, seq = this.replaySeq) {
    if (!data || !this.hasLiveClients()) {
      return;
    }
    if (!this.liveOutputBuffer && data.length <= LIVE_OUTPUT_IMMEDIATE_CHARS) {
      this.broadcast({ type: 'data', data, seq });
      return;
    }
    this.liveOutputBuffer += data;
    this.liveOutputSeq = seq;
    if (this.liveOutputBuffer.length >= LIVE_OUTPUT_FLUSH_CHARS) {
      this.flushLiveOutput();
      return;
    }
    if (this.liveOutputTimer) {
      return;
    }
    this.liveOutputTimer = setTimeout(() => {
      this.liveOutputTimer = null;
      this.flushLiveOutput();
    }, LIVE_OUTPUT_FLUSH_MS);
    this.liveOutputTimer.unref?.();
  }

  cancelHeadlessFlushTimer() {
    if (!this.headlessFlushTimer) {
      return;
    }
    clearTimeout(this.headlessFlushTimer);
    this.headlessFlushTimer = null;
  }

  flushHeadlessWrite() {
    this.cancelHeadlessFlushTimer();
    const data = this.headlessPendingBuffer;
    this.headlessPendingBuffer = '';
    this.headlessPendingBytes = 0;
    if (!data || !this.headlessTerminal || this.headlessWriteFailed) {
      return;
    }
    this.headlessWriteChain = this.headlessWriteChain
      .then(
        () =>
          new Promise((resolve) => {
            try {
              this.headlessTerminal.write(data, resolve);
            } catch (error) {
              this.headlessWriteFailed = true;
              logger.warn('[CodexCliTerminal] Headless terminal write failed', {
                sessionId: this.sessionId,
                error: error?.message ?? error,
              });
              resolve();
            }
          }),
      )
      .catch((error) => {
        this.headlessWriteFailed = true;
        logger.warn('[CodexCliTerminal] Headless terminal write chain failed', {
          sessionId: this.sessionId,
          error: error?.message ?? error,
        });
      });
  }

  appendBuffer(data) {
    this.buffer += data;
    this.bufferBytes += Buffer.byteLength(data, 'utf8');
    if (this.bufferBytes <= MAX_REPLAY_BYTES) {
      return;
    }

    const keepRatio = REPLAY_TRIM_TARGET_BYTES / this.bufferBytes;
    let keepChars = Math.max(1, Math.floor(this.buffer.length * keepRatio));
    this.buffer = this.buffer.slice(-keepChars);
    this.bufferBytes = Buffer.byteLength(this.buffer, 'utf8');

    while (this.bufferBytes > MAX_REPLAY_BYTES && keepChars > 1) {
      keepChars = Math.max(1, Math.floor(keepChars * 0.75));
      this.buffer = this.buffer.slice(-keepChars);
      this.bufferBytes = Buffer.byteLength(this.buffer, 'utf8');
    }
  }

  appendOutputHistory(data, seq) {
    if (!data || !Number.isSafeInteger(seq)) {
      return;
    }
    const bytes = Buffer.byteLength(data, 'utf8');
    this.outputHistory.push({ seq, data, bytes });
    this.outputHistoryBytes += bytes;
    while (this.outputHistoryBytes > OUTPUT_HISTORY_MAX_BYTES && this.outputHistory.length > 0) {
      const dropped = this.outputHistory.shift();
      this.outputHistoryBytes -= dropped?.bytes || 0;
    }
  }

  queueHeadlessWrite(data) {
    this.replaySeq += 1;
    if (!this.headlessTerminal || this.headlessWriteFailed) {
      return this.replaySeq;
    }
    this.headlessPendingBuffer += data;
    this.headlessPendingBytes += Buffer.byteLength(data, 'utf8');
    if (this.headlessPendingBytes > HEADLESS_MAX_PENDING_BYTES) {
      this.headlessWriteFailed = true;
      this.headlessPendingBuffer = '';
      this.headlessPendingBytes = 0;
      this.cancelHeadlessFlushTimer();
      logger.warn('[CodexCliTerminal] Headless terminal disabled after falling behind', {
        sessionId: this.sessionId,
      });
      return this.replaySeq;
    }
    if (this.headlessPendingBytes >= HEADLESS_WRITE_FLUSH_CHARS) {
      this.flushHeadlessWrite();
      return this.replaySeq;
    }
    if (this.headlessFlushTimer) {
      return this.replaySeq;
    }
    this.headlessFlushTimer = setTimeout(() => {
      this.headlessFlushTimer = null;
      this.flushHeadlessWrite();
    }, HEADLESS_WRITE_FLUSH_MS);
    this.headlessFlushTimer.unref?.();
    return this.replaySeq;
  }

  async createReplayMessage() {
    const seq = this.replaySeq;
    if (!this.headlessTerminal || !this.serializeAddon || this.headlessWriteFailed) {
      return { type: 'replay', data: this.buffer, seq, replayKind: 'raw-tail' };
    }
    try {
      this.flushHeadlessWrite();
      let timedOut = false;
      await Promise.race([
        this.headlessWriteChain,
        timeout(HEADLESS_REPLAY_WAIT_MS).then(() => {
          timedOut = true;
        }),
      ]);
      if (timedOut) {
        return { type: 'replay', data: this.buffer, seq, replayKind: 'raw-tail' };
      }
      let replayScrollbackRows = getReplayScrollbackRows();
      let replayData = this.serializeAddon.serialize({ scrollback: replayScrollbackRows });
      if (
        Buffer.byteLength(replayData, 'utf8') > MAX_REPLAY_BYTES &&
        replayScrollbackRows > COMPACT_REPLAY_SCROLLBACK_ROWS
      ) {
        replayScrollbackRows = COMPACT_REPLAY_SCROLLBACK_ROWS;
        replayData = this.serializeAddon.serialize({ scrollback: replayScrollbackRows });
      }
      if (Buffer.byteLength(replayData, 'utf8') > MAX_REPLAY_BYTES) {
        return { type: 'replay', data: this.buffer, seq, replayKind: 'raw-tail' };
      }
      return {
        type: 'replay',
        data: replayData,
        seq,
        replayKind: 'xterm-serialize',
        cols: this.headlessTerminal.cols,
        rows: this.headlessTerminal.rows,
      };
    } catch (error) {
      this.headlessWriteFailed = true;
      logger.warn('[CodexCliTerminal] Headless terminal serialize failed', {
        sessionId: this.sessionId,
        error: error?.message ?? error,
      });
      return { type: 'replay', data: this.buffer, seq, replayKind: 'raw-tail' };
    }
  }

  getOutputHistoryAfter(afterSeq) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq <= 0) {
      return null;
    }
    if (afterSeq >= this.replaySeq) {
      return [];
    }
    const first = this.outputHistory[0];
    if (!first || first.seq > afterSeq + 1) {
      return null;
    }
    const messages = [];
    for (const record of this.outputHistory) {
      if (record.seq > afterSeq) {
        messages.push({ type: 'data', data: record.data, seq: record.seq });
      }
    }
    return messages.length > 0 ? messages : null;
  }

  startResumeOrReplay(client, send, close, afterSeq = 0) {
    const resumeMessages = this.getOutputHistoryAfter(afterSeq);
    if (!resumeMessages) {
      this.startReplay(client, send, close);
      return;
    }

    client.replaying = false;
    client.replayBacklog = [];
    client.replayBacklogBytes = 0;
    for (const message of resumeMessages) {
      if (client.closed) {
        return;
      }
      if (send(message) === false) {
        client.closed = true;
        close();
        return;
      }
    }
    if (this.exited && this.exitInfo && !client.closed) {
      send({ type: 'exit', ...this.exitInfo });
      close();
    }
  }

  startReplay(client, send, close) {
    client.replaying = true;
    client.replayBacklog = [];
    client.replayBacklogBytes = 0;
    void this.createReplayMessage()
      .then((message) => {
        if (client.closed) {
          return;
        }
        if (send(message) === false) {
          client.closed = true;
          close();
          return;
        }
        client.replaying = false;
        const backlog = client.replayBacklog || [];
        client.replayBacklog = [];
        client.replayBacklogBytes = 0;
        for (const backlogMessage of backlog) {
          if (client.closed) {
            return;
          }
          if (send(backlogMessage) === false) {
            client.closed = true;
            close();
            return;
          }
        }
        if (this.exited && this.exitInfo && !client.closed) {
          send({ type: 'exit', ...this.exitInfo });
          close();
        }
      })
      .catch((error) => {
        logger.warn('[CodexCliTerminal] Replay delivery failed', {
          sessionId: this.sessionId,
          error: error?.message ?? error,
        });
        if (!client.closed) {
          client.replaying = false;
          if (send({ type: 'replay', data: this.buffer, seq: this.replaySeq, replayKind: 'raw-tail' }) === false) {
            client.closed = true;
          }
        }
      });
  }

  sendOrBufferClient(client, send, message) {
    if (client.closed) {
      return;
    }
    if (client.replaying && message.type === 'data') {
      const data = message.data ?? '';
      client.replayBacklog.push(message);
      client.replayBacklogBytes += Buffer.byteLength(data, 'utf8');
      if (client.replayBacklogBytes > MAX_ATTACH_BACKLOG_BYTES) {
        client.replayBacklog = [message];
        client.replayBacklogBytes = Buffer.byteLength(data, 'utf8');
      }
      return;
    }
    if (send(message) === false) {
      client.closed = true;
      client.close?.();
    }
  }

  attach(ws) {
    const client = {
      closed: false,
      replaying: false,
      replayBacklog: [],
      replayBacklogBytes: 0,
    };
    ws.codexReplayClient = client;
    this.flushLiveOutput();
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
    this.startReplay(
      client,
      (message) => wsSend(ws, message),
      () => ws.close(1000, 'Terminal session ended'),
    );
  }

  attachEventStream(res, options = {}) {
    const afterSeq = normalizeResumeSeq(options.afterSeq);
    const client = {
      id: crypto.randomBytes(12).toString('base64url'),
      res,
      heartbeatTimer: null,
      closed: false,
      replaying: false,
      replayBacklog: [],
      replayBacklogBytes: 0,
      unackedBytes: 0,
      lastAckAt: now(),
      lastDataAt: 0,
      close: () => {
        if (client.closed) {
          return;
        }
        client.closed = true;
        clearInterval(client.heartbeatTimer);
        this.eventClients.delete(client);
        this.refreshOutputFlowControl();
        if (!res.destroyed) {
          res.end();
        }
      },
      send: (message) => {
        if (client.closed || res.destroyed) {
          client.close();
          return false;
        }
        const dataBytes =
          message?.type === 'data' || message?.type === 'replay'
            ? Buffer.byteLength(message.data ?? '', 'utf8')
            : 0;
        const ok = writeSseMessage(res, message);
        if (ok && dataBytes > 0) {
          client.unackedBytes += dataBytes;
          client.lastDataAt = now();
          this.refreshOutputFlowControl();
        }
        if (!ok && res.writableLength > SSE_MAX_BUFFERED_BYTES) {
          client.close();
        }
        return ok;
      },
    };

    this.flushLiveOutput();
    this.eventClients.add(client);
    client.heartbeatTimer = setInterval(() => {
      if (res.destroyed) {
        client.close();
        return;
      }
      try {
        const lastProgressAt = Math.max(client.lastAckAt || 0, client.lastDataAt || 0);
        if (
          client.unackedBytes > SSE_CLIENT_HIGH_WATER_BYTES &&
          lastProgressAt &&
          now() - lastProgressAt > SSE_CLIENT_ACK_TIMEOUT_MS
        ) {
          client.close();
          return;
        }
        if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
          client.close();
          return;
        }
        res.write(': keepalive\n\n');
      } catch {
        client.close();
      }
    }, SSE_HEARTBEAT_INTERVAL_MS);
    client.heartbeatTimer.unref?.();

    client.send({
      type: 'ready',
      sessionId: this.sessionId,
      mode: this.mode,
      pid: this.ptyProcess.pid,
      cwd: this.repoPath,
      clientId: client.id,
      serverPid: process.pid,
      serverInstanceId,
    });
    this.startResumeOrReplay(client, (message) => client.send(message), () => client.close(), afterSeq);

    return client;
  }

  detach(ws) {
    if (ws.codexReplayClient) {
      ws.codexReplayClient.closed = true;
    }
    this.clients.delete(ws);
  }

  broadcast(message) {
    for (const client of this.clients) {
      this.sendOrBufferClient(
        client.codexReplayClient || {},
        (payload) => wsSend(client, payload),
        message,
      );
    }
    for (const client of this.eventClients) {
      this.sendOrBufferClient(client, (payload) => client.send(payload), message);
    }
  }

  finishExit(exitInfo = {}) {
    if (this.exited) {
      return false;
    }
    this.exited = true;
    this.exitInfo = exitInfo;
    sessions.delete(getSessionKey(this.userId, this.sessionId));
    this.flushLiveOutput();
    this.broadcast({ type: 'exit', ...exitInfo });
    for (const client of this.clients) {
      if (client.codexReplayClient) {
        client.codexReplayClient.closed = true;
      }
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
    this.cancelLiveOutputTimer();
    this.cancelHeadlessFlushTimer();
    this.serializeAddon?.dispose?.();
    this.headlessTerminal?.dispose?.();
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
      this.headlessTerminal?.resize(cols, rows);
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

function attachCodexCliEventStream({
  ticket: ticketValue,
  sessionId: sessionIdValue,
  mode,
  afterSeq,
  res,
}) {
  res.req?.socket?.setNoDelay?.(true);
  res.req?.socket?.setKeepAlive?.(true, 30_000);
  res.req?.setTimeout?.(0);
  res.socket?.setNoDelay?.(true);
  res.socket?.setKeepAlive?.(true, 30_000);
  res.setTimeout?.(0);
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

  const client = session.attachEventStream(res, { afterSeq });
  const cleanup = () => client.close();
  res.req?.on('close', cleanup);
  res.req?.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
  return { client, session };
}

function writeCodexCliSessionInput(sessionIdValue, user, input) {
  const userId = normalizeUserId(user);
  const sessionId = normalizeSessionId(sessionIdValue);
  if (!userId || !sessionId) {
    return { ok: false, reason: 'invalid_request', serverPid: process.pid, serverInstanceId };
  }
  try {
    const session = getActiveSession({ sessionId, userId });
    if (typeof input === 'string') {
      if (!isValidInputData(input)) {
        return { ok: false, reason: 'invalid_input', serverPid: process.pid, serverInstanceId };
      }
      session.write(input);
      return { ok: true, sessionId, serverPid: process.pid, serverInstanceId };
    }
    if (
      input &&
      typeof input === 'object' &&
      !input.inputClientId &&
      typeof input.data === 'string'
    ) {
      if (!isValidInputData(input.data)) {
        return { ok: false, reason: 'invalid_input', serverPid: process.pid, serverInstanceId };
      }
      session.write(input.data);
      return { ok: true, sessionId, serverPid: process.pid, serverInstanceId };
    }

    const inputBatch = normalizeInputBatch(input);
    if (!inputBatch) {
      return { ok: false, reason: 'invalid_input', serverPid: process.pid, serverInstanceId };
    }
    const inputAckSeq = session.applyInputFrames(inputBatch.inputClientId, inputBatch.frames);
    return {
      ok: true,
      sessionId,
      inputClientId: inputBatch.inputClientId,
      inputAckSeq,
      serverPid: process.pid,
      serverInstanceId,
    };
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
  req.socket?.setNoDelay?.(true);
  req.socket?.setKeepAlive?.(true, 30_000);
  req.setTimeout?.(0);
  res.socket?.setNoDelay?.(true);
  res.socket?.setKeepAlive?.(true, 30_000);
  res.setTimeout?.(0);
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
  const inputProtocol = req.headers['x-codex-input-protocol'] === 'jsonl-v1' ? 'jsonl-v1' : 'raw';
  const inputClientId = normalizeInputClientId(req.headers['x-codex-input-client']);
  if (inputProtocol === 'jsonl-v1' && !inputClientId) {
    res.status(400).json({ ok: false, reason: 'invalid_input_client' });
    return null;
  }
  let inputStreamBytes = 0;
  let inputStreamRejected = false;
  let inputLineBuffer = '';
  const rejectInputStream = (status, reason) => {
    inputStreamRejected = true;
    if (!res.headersSent) {
      res.status(status).json({ ok: false, reason });
    }
    req.destroy();
  };
  const applyInputLine = (line) => {
    if (!line) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      rejectInputStream(400, 'invalid_input_frame');
      return;
    }
    const frame = normalizeInputFrame(parsed);
    if (!frame) {
      rejectInputStream(400, 'invalid_input_frame');
      return;
    }
    try {
      session.applyInputFrames(inputClientId, [frame]);
    } catch (error) {
      rejectInputStream(413, error?.message || 'input_client_backlog_too_large');
    }
  };
  const applyInputText = (text) => {
    if (!text || session.exited || inputStreamRejected) {
      return;
    }
    if (inputProtocol !== 'jsonl-v1') {
      session.write(text);
      return;
    }
    inputLineBuffer += text;
    if (Buffer.byteLength(inputLineBuffer, 'utf8') > MAX_INPUT_STREAM_LINE_BYTES) {
      rejectInputStream(413, 'input_frame_too_large');
      return;
    }
    let newlineIndex = inputLineBuffer.indexOf('\n');
    while (newlineIndex !== -1 && !inputStreamRejected) {
      const line = inputLineBuffer.slice(0, newlineIndex);
      inputLineBuffer = inputLineBuffer.slice(newlineIndex + 1);
      applyInputLine(line);
      newlineIndex = inputLineBuffer.indexOf('\n');
    }
  };
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
    if (session.exited || inputStreamRejected) {
      return;
    }
    inputStreamBytes += chunk.length;
    if (
      chunk.length > MAX_INPUT_STREAM_CHUNK_BYTES ||
      inputStreamBytes > MAX_INPUT_STREAM_BYTES
    ) {
      rejectInputStream(413, 'input_stream_too_large');
      return;
    }
    applyInputText(decoder.write(chunk));
  });

  req.on('end', () => {
    if (inputStreamRejected) {
      return;
    }
    applyInputText(decoder.end());
    if (inputStreamRejected) {
      return;
    }
    if (inputProtocol === 'jsonl-v1' && inputLineBuffer) {
      inputLineBuffer = '';
    }
    if (!res.headersSent) {
      if (inputProtocol === 'jsonl-v1') {
        const state = session.inputClients.get(inputClientId);
        res.json({
          ok: true,
          inputClientId,
          inputAckSeq: state?.lastSeq || 0,
          serverPid: process.pid,
          serverInstanceId,
        });
        return;
      }
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

function ackCodexCliSessionOutput(sessionIdValue, user, options = {}) {
  const userId = normalizeUserId(user);
  const sessionId = normalizeSessionId(sessionIdValue);
  if (!userId || !sessionId) {
    return { ok: false, reason: 'invalid_request', serverPid: process.pid, serverInstanceId };
  }
  const clientId = typeof options.clientId === 'string' ? options.clientId : '';
  const bytes = Number(options.bytes ?? options.chars);
  if (!clientId || !Number.isFinite(bytes) || bytes <= 0 || bytes > SSE_MAX_BUFFERED_BYTES) {
    return { ok: false, reason: 'invalid_ack', serverPid: process.pid, serverInstanceId };
  }
  try {
    const session = getActiveSession({ sessionId, userId });
    const acked = session.ackEventClient(clientId, bytes);
    return { ok: acked, sessionId, serverPid: process.pid, serverInstanceId };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || 'unable_to_ack',
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
  ws._socket?.setNoDelay?.(true);
  ws._socket?.setKeepAlive?.(true, 30_000);
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
      if (!isValidInputData(message.data)) {
        ws.close(1009, 'Input too large');
        return;
      }
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
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 30_000);
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
  ackCodexCliSessionOutput,
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
