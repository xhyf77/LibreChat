const express = require('express');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const {
  createCodexCliTicket,
  getCodexCliSessions,
  terminateCodexCliSession,
} = require('~/server/services/CodexCliTerminal');

const router = express.Router();
router.use(requireJwtAuth);

router.post('/ticket', (req, res) => {
  res.json(createCodexCliTicket(req.user));
});

router.get('/sessions', (req, res) => {
  res.json({ sessions: getCodexCliSessions(req.user) });
});

router.delete('/sessions/:sessionId', (req, res) => {
  res.json({ ok: terminateCodexCliSession(req.params.sessionId, req.user) });
});

module.exports = router;
