const express = require('express');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const {
  ackCodexCliSessionOutput,
  attachCodexCliEventStream,
  attachCodexCliInputStream,
  createCodexCliSession,
  createCodexCliTicket,
  getCodexCliSessions,
  resizeCodexCliSession,
  terminateCodexCliSession,
  writeCodexCliSessionInput,
} = require('~/server/services/CodexCliTerminal');

const router = express.Router();

router.use((req, res, next) => {
  req.socket?.setNoDelay?.(true);
  res.socket?.setNoDelay?.(true);
  next();
});

router.get('/sessions/:sessionId/events', (req, res) => {
  req.setTimeout?.(0);
  res.setTimeout?.(0);
  const result = attachCodexCliEventStream({
    ticket: req.query.ticket,
    sessionId: req.params.sessionId,
    mode: req.query.mode,
    afterSeq: req.query.afterSeq,
    replay: req.query.replay,
    res,
  });
  if (!result) {
    return;
  }
  req.on('close', () => {
    result.client.close();
  });
});

router.use(requireJwtAuth);

router.post('/ticket', (req, res) => {
  try {
    res.json(createCodexCliTicket(req.user, req.body));
  } catch (error) {
    res.status(400).json({
      ok: false,
      reason: error?.message || 'Unable to create terminal ticket',
    });
  }
});

router.post('/sessions', (req, res) => {
  try {
    res.json(createCodexCliSession(req.user, req.body));
  } catch (error) {
    res.status(400).json({
      ok: false,
      reason: error?.message || 'Unable to create terminal session',
    });
  }
});

router.get('/sessions', (req, res) => {
  res.json({ sessions: getCodexCliSessions(req.user) });
});

router.delete('/sessions/:sessionId', (req, res) => {
  res.json(terminateCodexCliSession(req.params.sessionId, req.user));
});

router.post('/sessions/:sessionId/input', (req, res) => {
  const result = writeCodexCliSessionInput(req.params.sessionId, req.user, req.body);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/sessions/:sessionId/input-stream', (req, res) => {
  req.setTimeout?.(0);
  res.setTimeout?.(0);
  attachCodexCliInputStream(req.params.sessionId, req.user, req, res);
});

router.post('/sessions/:sessionId/resize', (req, res) => {
  const result = resizeCodexCliSession(req.params.sessionId, req.user, req.body);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/sessions/:sessionId/ack', (req, res) => {
  const result = ackCodexCliSessionOutput(req.params.sessionId, req.user, req.body);
  res.status(result.ok ? 200 : 400).json(result);
});

module.exports = router;
