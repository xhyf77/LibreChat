const http = require('http');
const fetch = require('node-fetch');

const DEFAULT_API_BASE = 'http://127.0.0.1:8000/api';
const DEFAULT_PROJECT_ID = 'hm-verif-kernel';
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CodexReviewSidecar {
  constructor(env = process.env) {
    this.apiBase = (env.CODEX_REVIEW_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.socketPath = env.CODEX_REVIEW_API_SOCKET || '';
    this.projectId = env.CODEX_REVIEW_PROJECT_ID || DEFAULT_PROJECT_ID;
    this.staticToken = env.CODEX_REVIEW_API_TOKEN || '';
    this.adminUser = env.CODEX_REVIEW_ADMIN_USER || '';
    this.adminPassword = env.CODEX_REVIEW_ADMIN_PASSWORD || '';
    this.pollIntervalMs = Number(env.CODEX_REVIEW_POLL_INTERVAL_MS || 1000);
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
    this.projectCache = null;
  }

  async getProjects() {
    if (this.projectCache) {
      return this.projectCache;
    }
    const projects = (await this.request('/projects')).json;
    this.projectCache = Array.isArray(projects) ? projects : [];
    return this.projectCache;
  }

  async getProject(projectId = this.projectId) {
    const projects = await this.getProjects();
    return projects.find((project) => project?.id === projectId) || null;
  }

  async getProjectStatus(projectId = this.projectId) {
    return (
      await this.request(`/projects/${encodeURIComponent(projectId)}/status`, {
        allowNotFound: true,
      })
    ).json;
  }

  async getTaskByConversation(conversationId) {
    const response = await this.request(
      `/tasks/by-conversation/${encodeURIComponent(conversationId)}`,
      {
        allowNotFound: true,
      },
    );
    return response.status === 404 ? null : response.json;
  }

  async createTask({ conversationId, title, prompt }) {
    return (
      await this.request('/tasks', {
        method: 'POST',
        body: {
          project_id: this.projectId,
          title,
          prompt,
          conversation_id: conversationId,
          mode: 'auto',
        },
      })
    ).json;
  }

  async createRun(taskId, prompt) {
    return (
      await this.request(`/tasks/${encodeURIComponent(taskId)}/runs`, {
        method: 'POST',
        body: {
          prompt,
          mode: 'auto',
        },
      })
    ).json;
  }

  async getRun(taskId, runId) {
    return (
      await this.request(`/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`)
    ).json;
  }

  async getRunFiles(taskId, runId) {
    return (
      await this.request(
        `/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/files`,
      )
    ).json;
  }

  async getRunFile(taskId, runId, fileId) {
    return (
      await this.request(
        `/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(
          fileId,
        )}`,
      )
    ).json;
  }

  async cancelRun(taskId, runId) {
    return (
      await this.request(
        `/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/cancel`,
        { method: 'POST' },
      )
    ).json;
  }

  async deleteTask(taskId, { allowNotFound = true } = {}) {
    const response = await this.request(`/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
      allowNotFound,
    });
    return response.status === 404 ? null : response.json;
  }

  async deleteTaskByConversation(conversationId, { allowNotFound = true } = {}) {
    const response = await this.request(
      `/tasks/by-conversation/${encodeURIComponent(conversationId)}`,
      {
        method: 'DELETE',
        allowNotFound,
      },
    );
    return response.status === 404 ? null : response.json;
  }

  async waitForRun(taskId, runId, { signal, onEvent } = {}) {
    try {
      return await this.waitForRunEvents(taskId, runId, { signal, onEvent });
    } catch (error) {
      if (signal?.aborted) {
        await this.cancelRun(taskId, runId).catch(() => null);
        throw new Error('Codex Review run was aborted.');
      }
      return this.pollRun(taskId, runId, { signal });
    }
  }

  async pollRun(taskId, runId, { signal } = {}) {
    while (true) {
      if (signal?.aborted) {
        await this.cancelRun(taskId, runId).catch(() => null);
        throw new Error('Codex Review run was aborted.');
      }
      const run = await this.getRun(taskId, runId);
      if (TERMINAL_STATUSES.has(run.status)) {
        return run;
      }
      await sleep(this.pollIntervalMs);
    }
  }

  async waitForRunEvents(taskId, runId, { signal, onEvent } = {}) {
    const response = await this.rawRequest(
      `/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/events`,
      { signal },
    );

    let eventName = 'message';
    let eventData = '';
    let sawDone = false;
    let lastStatus = null;

    const handleEvent = async (name, data) => {
      if (!data) {
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(data);
      } catch {
        payload = data;
      }
      if (name === 'done') {
        sawDone = true;
        lastStatus = payload?.status || null;
        return;
      }
      if (typeof onEvent === 'function') {
        await onEvent({ name, payload });
      }
    };

    const flush = async () => {
      await handleEvent(eventName, eventData);
      eventName = 'message';
      eventData = '';
    };

    try {
      let buffered = '';
      for await (const chunk of response.body) {
        if (signal?.aborted) {
          await this.cancelRun(taskId, runId).catch(() => null);
          throw new Error('Codex Review run was aborted.');
        }
        buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || '';
        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line) {
            await flush();
            continue;
          }
          if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim() || 'message';
          } else if (line.startsWith('data:')) {
            eventData += (eventData ? '\n' : '') + line.slice('data:'.length).trimStart();
          }
        }
      }
      if (buffered) {
        const line = buffered.trimEnd();
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim() || 'message';
        } else if (line.startsWith('data:')) {
          eventData += (eventData ? '\n' : '') + line.slice('data:'.length).trimStart();
        }
      }
      if (eventData) {
        await flush();
      }
    } finally {
      response.body?.destroy?.();
    }

    const run = await this.getRun(taskId, runId);
    if (sawDone || TERMINAL_STATUSES.has(run.status) || TERMINAL_STATUSES.has(lastStatus)) {
      return run;
    }
    throw new Error('Codex Review event stream ended before run completion.');
  }

  async rawRequest(path, options = {}) {
    const { signal } = options;
    const headers = {
      Accept: 'text/event-stream, application/json',
    };
    const token = await this.getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await this.fetch(`${this.apiBase}${path}`, {
      method: 'GET',
      headers,
      signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Codex Review sidecar ${response.status}: ${text || response.statusText}`);
    }
    return response;
  }

  async request(path, options = {}) {
    const { method = 'GET', body, allowNotFound = false } = options;
    const headers = {
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const token = await this.getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (allowNotFound && response.status === 404) {
      return { status: response.status, json };
    }
    if (!response.ok) {
      const rawDetail = json?.detail || json?.message || text || response.statusText;
      const detail =
        rawDetail && typeof rawDetail === 'object' ? JSON.stringify(rawDetail) : rawDetail;
      throw new Error(`Codex Review sidecar ${response.status}: ${detail}`);
    }
    return { status: response.status, json };
  }

  async getToken() {
    if (this.staticToken) {
      return this.staticToken;
    }
    if (!this.adminUser || !this.adminPassword) {
      return '';
    }
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }
    const response = await this.fetch(`${this.apiBase}/auth/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: this.adminUser,
        password: this.adminPassword,
      }),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`Codex Review login failed: ${json?.detail || response.statusText}`);
    }
    this.cachedToken = json.access_token;
    this.tokenExpiresAt = Date.parse(json.expires_at || '') || now + 30 * 60_000;
    return this.cachedToken;
  }

  async fetch(url, options = {}) {
    if (!this.socketPath) {
      return fetch(url, options);
    }
    return fetchUnixSocket(url, options, this.socketPath);
  }
}

function fetchUnixSocket(url, options, socketPath) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: options.method || 'GET',
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
        signal: options.signal,
      },
      (res) => {
        res.status = res.statusCode || 0;
        res.ok = res.status >= 200 && res.status < 300;
        res.statusText = res.statusMessage || '';
        res.body = res;
        res.text = () =>
          new Promise((resolveText, rejectText) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => resolveText(Buffer.concat(chunks).toString('utf8')));
            res.on('error', rejectText);
          });
        resolve(res);
      },
    );
    req.on('error', reject);
    if (options.body === undefined) {
      req.end();
    } else {
      req.end(options.body);
    }
  });
}

module.exports = {
  CodexReviewSidecar,
};
