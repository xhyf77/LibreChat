const mongoose = require('mongoose');
const { GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CodexReviewSidecar } = require('./sidecar');

const ENDPOINT = 'codex-review';
const DELETE_RETRIES = 6;
const DELETE_RETRY_DELAY_MS = 1000;

const sidecar = new CodexReviewSidecar();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function uniqueConversationIds(conversationIds) {
  return [...new Set((conversationIds || []).filter((id) => typeof id === 'string' && id))];
}

async function findCodexReviewConversationIds(userId, filter = {}) {
  const Conversation = mongoose.models.Conversation;
  if (!Conversation || !userId) {
    return [];
  }

  const conversations = await Conversation.find({
    ...filter,
    user: userId,
    endpoint: ENDPOINT,
  })
    .select('conversationId')
    .lean();

  return uniqueConversationIds(conversations.map((conversation) => conversation.conversationId));
}

async function abortCodexReviewJobs(conversationIds) {
  const ids = uniqueConversationIds(conversationIds);
  if (ids.length === 0) {
    return;
  }

  const results = await Promise.allSettled(ids.map((id) => GenerationJobManager.abortJob(id)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn('[CodexReviewCleanup] Failed to abort active job', {
        conversationId: ids[index],
        error: result.reason?.message ?? result.reason,
      });
    }
  });
}

function isActiveRunConflict(error) {
  return /409:.*active run/i.test(error?.message || '');
}

async function deleteSidecarTaskByConversation(conversationId) {
  for (let attempt = 1; attempt <= DELETE_RETRIES; attempt += 1) {
    try {
      return await sidecar.deleteTaskByConversation(conversationId, { allowNotFound: true });
    } catch (error) {
      if (!isActiveRunConflict(error) || attempt === DELETE_RETRIES) {
        throw error;
      }
      await sleep(DELETE_RETRY_DELAY_MS);
    }
  }
  return null;
}

async function deleteSidecarTasksByConversation(conversationIds) {
  const ids = uniqueConversationIds(conversationIds);
  if (ids.length === 0) {
    return;
  }

  const results = await Promise.allSettled(ids.map((id) => deleteSidecarTaskByConversation(id)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn('[CodexReviewCleanup] Failed to delete sidecar task', {
        conversationId: ids[index],
        error: result.reason?.message ?? result.reason,
      });
    }
  });
}

module.exports = {
  abortCodexReviewJobs,
  deleteSidecarTasksByConversation,
  findCodexReviewConversationIds,
};
