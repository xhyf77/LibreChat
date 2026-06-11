const mockGenerationJobManager = {
  getJob: jest.fn(),
  createJob: jest.fn(),
  updateMetadata: jest.fn(),
  emitChunk: jest.fn(),
  emitDone: jest.fn(),
  completeJob: jest.fn(),
  emitError: jest.fn(),
};
const mockDb = {
  saveConvo: jest.fn(),
};

jest.mock('@librechat/api', () => ({
  GenerationJobManager: mockGenerationJobManager,
  sanitizeMessageForTransmit: jest.fn((message) => message),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  Constants: {
    NO_PARENT: '00000000-0000-0000-0000-000000000000',
  },
  EModelEndpoint: {
    custom: 'custom',
  },
}));

jest.mock('diff2html', () => ({
  html: jest.fn(),
}));

jest.mock('~/models', () => mockDb);

jest.mock('~/server/services/CodexReview/sidecar', () => ({
  CodexReviewSidecar: jest.fn().mockImplementation(() => ({})),
}));

const CodexReviewController = require('../codexReview');

describe('CodexReviewController job startup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a second active run for the same conversation without replacing the job', async () => {
    mockGenerationJobManager.getJob.mockResolvedValue({
      status: 'running',
      metadata: { userId: 'user-1' },
      createdAt: 1000,
    });
    const req = {
      user: { id: 'user-1' },
      body: {
        text: 'follow up',
        conversationId: 'conversation-1',
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await CodexReviewController(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'A Codex run is already active for this conversation.',
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
    });
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
  });

  it('saves codex-review conversations with the custom endpoint type', async () => {
    mockDb.saveConvo.mockResolvedValue({ conversationId: 'conversation-1' });
    const req = {
      user: { id: 'user-1' },
      body: {},
      config: {},
    };

    await CodexReviewController._test.saveConversation(req, {
      conversationId: 'conversation-1',
      title: 'Review title',
    });

    expect(mockDb.saveConvo).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        isTemporary: undefined,
        interfaceConfig: undefined,
      },
      expect.objectContaining({
        conversationId: 'conversation-1',
        endpoint: 'codex-review',
        endpointType: 'custom',
        model: 'Ruc-model',
        title: 'Review title',
      }),
      expect.objectContaining({
        context: 'api/server/controllers/codexReview.js - save conversation',
      }),
    );
  });
});

describe('CodexReviewController text sanitization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const run = {
    worktree_path: '/tmp/codex-review/backend/data/tasks/task-1/workspace',
  };

  it('renders workspace markdown links as readable file locations', () => {
    const text = [
      'See [`forkvs()`](/tmp/codex-review/backend/data/tasks/task-1/workspace/sysmgr/memmgr/mem/backend/forkvs.c:139).',
      'Also [`anon.c:2435`](/tmp/codex-review/backend/data/tasks/task-1/workspace/sysmgr/memmgr/mem/backend/anon.c:2435).',
    ].join(' ');

    expect(CodexReviewController._test.sanitizeRunText(text, run)).toBe(
      [
        'See `sysmgr/memmgr/mem/backend/forkvs.c:139`.',
        'Also `sysmgr/memmgr/mem/backend/anon.c:2435`.',
      ].join(' '),
    );
  });

  it('leaves ordinary markdown links intact and strips plain workspace prefixes', () => {
    const text = [
      '[docs](https://example.test/docs)',
      '/tmp/codex-review/backend/data/tasks/task-1/workspace/src/main.c:27',
    ].join(' ');

    expect(CodexReviewController._test.sanitizeRunText(text, run)).toBe(
      '[docs](https://example.test/docs) src/main.c:27',
    );
  });

  it('normalizes sidecar workspace links even when the run worktree path is unavailable', () => {
    const text =
      'See [`hm_fork()`](/srv/app/backend/data/tasks/task-2/runs/run-3/worktree/ulibs/libhmsrv_sys/hm_procmgr.c:635).';

    expect(CodexReviewController._test.sanitizeRunText(text, {})).toBe(
      'See `ulibs/libhmsrv_sys/hm_procmgr.c:635`.',
    );
  });

  it('maps internal workspace paths to the configured project repository path when available', () => {
    const text = [
      '我现在在 /tmp/codex-review/backend/data/tasks/task-1/workspace。',
      '文件是 /tmp/codex-review/backend/data/tasks/task-1/workspace/src/main.c:27。',
    ].join(' ');

    expect(
      CodexReviewController._test.sanitizeRunText(text, {
        ...run,
        repo_path: '/home/xieminhui/fjj/hm_os/hm-verif-kernel',
      }),
    ).toBe(
      [
        '我现在在 /home/xieminhui/fjj/hm_os/hm-verif-kernel。',
        '文件是 /home/xieminhui/fjj/hm_os/hm-verif-kernel/src/main.c:27。',
      ].join(' '),
    );
  });

  it('maps workspace markdown links to project repository locations when available', () => {
    const text =
      'See [`forkvs.c:139`](/tmp/codex-review/backend/data/tasks/task-1/workspace/sysmgr/forkvs.c:139).';

    expect(
      CodexReviewController._test.sanitizeRunText(text, {
        ...run,
        repo_path: '/home/xieminhui/fjj/hm_os/hm-verif-kernel',
      }),
    ).toBe('See `/home/xieminhui/fjj/hm_os/hm-verif-kernel/sysmgr/forkvs.c:139`.');
  });
});

describe('CodexReviewController response messages', () => {
  it('wraps Codex reasoning summaries in the existing thinking block syntax', () => {
    const responseMessage = CodexReviewController._test.buildResponseMessage({
      run: {
        id: 'run-1',
        status: 'succeeded',
        stdout: 'Final answer.',
        reasoning_summary: 'Checked the repo.\nPrepared the answer.',
        changed_files: [],
        finished_at: '2026-06-11T08:00:00.000Z',
      },
      userMessage: {
        messageId: 'user-1',
        conversationId: 'conversation-1',
      },
      responseMessageId: 'user-1_',
      taskId: 'task-1',
      fileDetails: [],
    });

    expect(responseMessage.text).toBe(
      [
        ':::thinking',
        'Checked the repo.\nPrepared the answer.',
        ':::',
        '',
        'Final answer.',
      ].join('\n'),
    );
    expect(responseMessage.content[0].text).toBe(responseMessage.text);
  });

  it('includes timestamps so underscore response ids are not treated as pending placeholders', () => {
    const responseMessage = CodexReviewController._test.buildResponseMessage({
      run: {
        id: 'run-1',
        status: 'succeeded',
        stdout: 'Review complete.',
        changed_files: [],
        finished_at: '2026-06-11T08:00:00.000Z',
      },
      userMessage: {
        messageId: 'user-1',
        conversationId: 'conversation-1',
      },
      responseMessageId: 'user-1_',
      taskId: 'task-1',
      fileDetails: [],
    });

    expect(responseMessage).toEqual(
      expect.objectContaining({
        messageId: 'user-1_',
        createdAt: '2026-06-11T08:00:00.000Z',
        updatedAt: '2026-06-11T08:00:00.000Z',
        unfinished: false,
      }),
    );
  });
});
