const express = require('express');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const {
  attachCodexCliEventStream,
  createCodexCliSession,
  createCodexCliTicket,
  getCodexCliSessions,
  resizeCodexCliSession,
  terminateCodexCliSession,
  writeCodexCliSessionInput,
} = require('~/server/services/CodexCliTerminal');

const router = express.Router();

router.get('/sessions/:sessionId/events', (req, res) => {
  const result = attachCodexCliEventStream({
    ticket: req.query.ticket,
    sessionId: req.params.sessionId,
    mode: req.query.mode,
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
  const result = writeCodexCliSessionInput(req.params.sessionId, req.user, req.body?.data);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/sessions/:sessionId/resize', (req, res) => {
  const result = resizeCodexCliSession(req.params.sessionId, req.user, req.body);
  res.status(result.ok ? 200 : 400).json(result);
});

module.exports = router;
