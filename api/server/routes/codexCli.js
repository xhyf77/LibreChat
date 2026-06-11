const express = require('express');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const {
  createCodexCliSession,
  createCodexCliTicket,
  getCodexCliSessions,
  terminateCodexCliSession,
} = require('~/server/services/CodexCliTerminal');

const router = express.Router();
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

module.exports = router;
