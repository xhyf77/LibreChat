const crypto = require('crypto');
const { GenerationJobManager, sanitizeMessageForTransmit } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Constants, EModelEndpoint } = require('librechat-data-provider');
const db = require('~/models');
const { CodexReviewSidecar } = require('~/server/services/CodexReview/sidecar');

const ENDPOINT = 'codex-review';
const MODEL = 'Ruc-model';
const SENDER = 'Codex CLI';
const DEFAULT_TITLE = 'Codex CLI';
const sidecar = new CodexReviewSidecar();

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function titleFromPrompt(text) {
  const line = firstLine(text) || DEFAULT_TITLE;
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function responseTextForRun(run) {
  if (run?.stdout) {
    return withReasoningSummary(sanitizeRunText(run.stdout, run), run);
  }
  if (run?.status === 'canceled') {
    return withReasoningSummary('Codex Review run was canceled.', run);
  }
  if (run?.status === 'failed') {
    return withReasoningSummary(run?.error || 'Codex Review failed.', run);
  }
  return withReasoningSummary('Codex Review completed.', run);
}

function withReasoningSummary(text, run) {
  const summary = sanitizeRunText(run?.reasoning_summary || '', run).trim();
  if (!summary) {
    return text;
  }
  const safeSummary = summary.replaceAll(':::', '`:::`');
  return `:::thinking\n${safeSummary}\n:::\n\n${text}`;
}

function mimeForFilename(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return 'text/markdown';
  }
  if (lower.endsWith('.diff') || lower.endsWith('.patch')) {
    return 'text/x-diff';
  }
  if (lower.endsWith('.json')) {
    return 'application/json';
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return 'text/javascript';
  }
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    return 'text/x-typescript';
  }
  if (lower.endsWith('.py')) {
    return 'text/x-python';
  }
  if (lower.endsWith('.go')) {
    return 'text/x-go';
  }
  if (lower.endsWith('.rs')) {
    return 'text/x-rust';
  }
  if (lower.endsWith('.c') || lower.endsWith('.h')) {
    return 'text/x-c';
  }
  if (lower.endsWith('.cc') || lower.endsWith('.cpp') || lower.endsWith('.hpp')) {
    return 'text/x-c++';
  }
  if (lower.endsWith('.java')) {
    return 'text/x-java';
  }
  if (lower.endsWith('.css')) {
    return 'text/css';
  }
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) {
    return 'application/x-sh';
  }
  return 'text/plain';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function limitText(value, max) {
  const text = String(value ?? '');
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, max),
    truncated: true,
  };
}

function redacted(value) {
  return String(value ?? '').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]');
}

function markdownInlineCode(value) {
  const text = String(value ?? '');
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding = text.startsWith('`') || text.endsWith('`');
  const content = needsPadding ? ` ${text} ` : text;
  return `${fence}${content}${fence}`;
}

function relativeWorkspaceTarget(href, workspace) {
  const root = String(workspace || '').replace(/\/+$/, '');
  if (!root) {
    return undefined;
  }

  let target = String(href || '').trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1);
  }
  if (!target.startsWith(`${root}/`)) {
    return undefined;
  }

  const relative = target.slice(root.length + 1).replace(/^\/+/, '');
  return relative || '.';
}

function relativeTaskWorkspaceTarget(href) {
  let target = String(href || '').trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1);
  }
  const match = target.match(
    /(?:^|\/)backend\/data\/tasks\/[A-Za-z0-9_-]+\/(?:workspace|runs\/[A-Za-z0-9_-]+\/worktree)\/(.+)$/,
  );
  return match?.[1]?.replace(/^\/+/, '') || undefined;
}

function normalizePathRoot(value) {
  return String(value || '').replace(/\/+$/, '');
}

function visibleWorkspaceTarget(relative, repoRoot) {
  if (!repoRoot) {
    return relative;
  }
  if (!relative || relative === '.') {
    return repoRoot;
  }
  return `${repoRoot}/${relative.replace(/^\/+/, '')}`;
}

function replaceTaskWorkspacePaths(value, repoRoot) {
  return String(value ?? '').replace(
    /\/[^\s)\]]*backend\/data\/tasks\/[A-Za-z0-9_-]+\/(?:workspace|runs\/[A-Za-z0-9_-]+\/worktree)(\/[^\s)\]]*)?/g,
    (_match, suffix = '') => {
      if (repoRoot) {
        return `${repoRoot}${suffix}`;
      }
      const relative = String(suffix || '').replace(/^\/+/, '');
      return relative || '.';
    },
  );
}

function normalizeWorkspaceMarkdownLinks(value, workspace, repoRoot = '') {
  return String(value ?? '').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, _label, href) => {
    const relative = relativeWorkspaceTarget(href, workspace) || relativeTaskWorkspaceTarget(href);
    if (!relative) {
      return match;
    }
    return markdownInlineCode(visibleWorkspaceTarget(relative, repoRoot));
  });
}

function sanitizeRunText(value, run) {
  let text = redacted(value);
  const workspace = normalizePathRoot(run?.worktree_path);
  const repoRoot = normalizePathRoot(run?.repo_path);
  text = normalizeWorkspaceMarkdownLinks(text, workspace, repoRoot);
  if (workspace) {
    if (repoRoot) {
      text = text.split(`${workspace}/`).join(`${repoRoot}/`);
      text = text.split(workspace).join(repoRoot);
    } else {
      text = text.split(`${workspace}/`).join('');
      text = text.split(workspace).join('.');
    }
  }
  return replaceTaskWorkspacePaths(text, repoRoot);
}

function sanitizeProgressText(value) {
  return replaceTaskWorkspacePaths(redacted(value), '');
}

function compactString(value, max = 500) {
  if (value == null) {
    return undefined;
  }
  const text = sanitizeProgressText(value);
  if (!text) {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildProgressChunk({ taskId, runId, name, payload }) {
  const data = payload && typeof payload === 'object' ? payload : { message: payload };
  const message = compactString(data.message || data.status || data.detail);
  const delta = name === 'assistant_delta' ? compactString(data.delta, 1000) : undefined;
  const count = Number.isFinite(Number(data.count)) ? Number(data.count) : undefined;
  const status = compactString(data.status, 120);

  return {
    event: 'codex_review_progress',
    data: {
      taskId,
      runId,
      type: name,
      ...(message ? { message } : {}),
      ...(delta ? { delta } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(status ? { status } : {}),
      ts: data.ts || new Date().toISOString(),
    },
  };
}

async function emitCodexReviewProgress(streamId, { taskId, runId, name, payload }) {
  if (name === 'assistant_delta') {
    return;
  }
  if (!['progress', 'file_changes', 'message'].includes(name)) {
    return;
  }
  await GenerationJobManager.emitChunk(
    streamId,
    buildProgressChunk({ taskId, runId, name, payload }),
  );
}

async function isCurrentGenerationJob(streamId, createdAt) {
  const currentJob = await GenerationJobManager.getJob(streamId);
  return Boolean(currentJob && currentJob.createdAt === createdAt);
}

function loadDiff2HtmlCss() {
  if (diff2htmlCss !== undefined) {
    return diff2htmlCss;
  }
  try {
    diff2htmlCss = fs.readFileSync(
      require.resolve('diff2html/bundles/css/diff2html.min.css'),
      'utf8',
    );
  } catch (error) {
    logger.warn('[CodexReviewController] Failed to load diff2html CSS', {
      error: error?.message ?? error,
    });
    diff2htmlCss = '';
  }
  return diff2htmlCss;
}

function renderDiffHtml(diff) {
  if (!diff) {
    return '<p class="muted">No unified diff was produced for this run.</p>';
  }

  const max = Number(process.env.CODEX_REVIEW_HTML_DIFF_MAX_CHARS || 200000);
  const { text, truncated } = limitText(redacted(diff), max);
  if (truncated) {
    return [
      '<p class="notice">The full diff is available as a separate changes.diff artifact. This preview is truncated.</p>',
      `<pre class="code">${escapeHtml(text)}</pre>`,
    ].join('\n');
  }

  try {
    return Diff2Html.html(text, {
      drawFileList: true,
      matching: 'lines',
      outputFormat: 'line-by-line',
      renderNothingWhenEmpty: false,
    });
  } catch (error) {
    logger.warn('[CodexReviewController] Failed to render diff2html preview', {
      error: error?.message ?? error,
    });
    return `<pre class="code">${escapeHtml(text)}</pre>`;
  }
}

function makeAttachment({
  text,
  type,
  fileId,
  filename,
  toolCallId,
  messageId,
  conversationId,
  updatedAt,
}) {
  return {
    file_id: fileId,
    filename,
    filepath: '',
    type,
    text: text ?? '',
    conversationId,
    messageId,
    toolCallId,
    source: ENDPOINT,
    embedded: true,
    createdAt: updatedAt,
    updatedAt,
  };
}

function formatChangedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return 'No files changed.';
  }

  const lines = ['| File | Status | + | - |', '| --- | --- | ---: | ---: |'];
  for (const file of files) {
    const path = String(file.path || file.new_path || file.old_path || '(unknown)')
      .replaceAll('|', '\\|')
      .replaceAll('`', '\\`');
    lines.push(
      `| \`${path}\` | ${file.status || ''} | ${file.additions ?? ''} | ${file.deletions ?? ''} |`,
    );
  }
  return lines.join('\n');
}

function formatProgressEntry(entry) {
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry && typeof entry === 'object') {
    const type = entry.type ? `[${entry.type}] ` : '';
    const message = entry.message || entry.delta || entry.status;
    if (message) {
      return `${type}${message}`;
    }
    try {
      return JSON.stringify(entry);
    } catch {
      return String(entry);
    }
  }
  return String(entry ?? '');
}

function formatLogs(run) {
  const progress = Array.isArray(run?.progress_log) ? run.progress_log : [];
  const sections = [];
  if (progress.length > 0) {
    sections.push(
      [
        '# Progress',
        progress.map((entry) => `- ${sanitizeRunText(formatProgressEntry(entry), run)}`).join('\n'),
      ].join('\n\n'),
    );
  }
  if (run?.stdout) {
    sections.push(['# Final Answer', sanitizeRunText(run.stdout, run)].join('\n\n'));
  }
  if (run?.stderr) {
    sections.push(['# Logs', sanitizeRunText(run.stderr, run)].join('\n\n'));
  }
  if (run?.error) {
    sections.push(['# Error', sanitizeRunText(run.error, run)].join('\n\n'));
  }
  return sections.join('\n\n') || 'No logs were produced.';
}

function buildFileRows(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return '<tr><td colspan="4" class="muted">No files changed.</td></tr>';
  }

  return files
    .map((file) => {
      const path = file.path || file.new_path || file.old_path || '(unknown)';
      return [
        '<tr>',
        `<td><code>${escapeHtml(path)}</code></td>`,
        `<td>${escapeHtml(file.status || '')}</td>`,
        `<td class="num plus">${escapeHtml(file.additions ?? '')}</td>`,
        `<td class="num minus">${escapeHtml(file.deletions ?? '')}</td>`,
        '</tr>',
      ].join('');
    })
    .join('\n');
}

function buildFileDetailSections(fileDetails) {
  if (!Array.isArray(fileDetails) || fileDetails.length === 0) {
    return '<p class="muted">No file content details were loaded.</p>';
  }

  const max = Number(process.env.CODEX_REVIEW_HTML_FILE_MAX_CHARS || 30000);
  return fileDetails
    .map((file) => {
      const path = file.path || file.new_path || file.old_path || file.id;
      const parts = [
        '<section class="file-card">',
        `<h3>${escapeHtml(path)}</h3>`,
        `<p class="muted">${escapeHtml(file.status || '')} +${escapeHtml(
          file.additions ?? 0,
        )} -${escapeHtml(file.deletions ?? 0)}</p>`,
      ];

      if (file.warnings?.length) {
        parts.push(
          `<p class="notice">${escapeHtml(Array.isArray(file.warnings) ? file.warnings.join('; ') : file.warnings)}</p>`,
        );
      }

      if (file.diff) {
        const limitedDiff = limitText(redacted(file.diff), max);
        parts.push('<h4>File diff</h4>', `<pre class="code">${escapeHtml(limitedDiff.text)}</pre>`);
        if (limitedDiff.truncated) {
          parts.push(
            '<p class="muted">Diff preview truncated. Open the per-file diff artifact for the full text.</p>',
          );
        }
      }

      if (
        file.new_content != null &&
        !file.is_binary &&
        !file.too_large &&
        !file.is_sensitive &&
        file.copyable !== false
      ) {
        const limitedContent = limitText(redacted(file.new_content), max);
        parts.push(
          '<h4>New content</h4>',
          `<pre class="code">${escapeHtml(limitedContent.text)}</pre>`,
        );
        if (limitedContent.truncated) {
          parts.push(
            '<p class="muted">Content preview truncated. Open the per-file content artifact for the full text.</p>',
          );
        }
      }

      parts.push('</section>');
      return parts.join('\n');
    })
    .join('\n');
}

function buildReviewHtml({ run, taskId, fileDetails, truncatedFileArtifacts }) {
  const changedFiles = Array.isArray(run?.changed_files) ? run.changed_files : [];
  const plus = changedFiles.reduce((sum, file) => sum + Number(file.additions || 0), 0);
  const minus = changedFiles.reduce((sum, file) => sum + Number(file.deletions || 0), 0);
  const logsLimit = Number(process.env.CODEX_REVIEW_HTML_LOG_MAX_CHARS || 100000);
  const limitedLogs = limitText(formatLogs(run), logsLimit);
  const diffCss = loadDiff2HtmlCss();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
  <title>Codex Review</title>
  <style>
    ${diffCss}
    :root { color-scheme: light dark; --bg: #ffffff; --panel: #f7f7f8; --text: #171717; --muted: #666f7a; --line: #d8dee4; --accent: #0f766e; --bad: #b42318; --good: #067647; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111214; --panel: #1b1d21; --text: #f1f5f9; --muted: #a2aab8; --line: #30363d; --accent: #2dd4bf; --bad: #f97066; --good: #32d583; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 18px; }
    h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.2; }
    h2 { margin: 0 0 14px; font-size: 16px; }
    h3 { margin: 0 0 6px; font-size: 14px; }
    h4 { margin: 18px 0 8px; font-size: 12px; color: var(--muted); text-transform: uppercase; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .meta { color: var(--muted); margin: 0; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(82px, 1fr)); gap: 8px; min-width: 260px; }
    .stat { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--panel); }
    .stat strong { display: block; font-size: 18px; line-height: 1.1; }
    .stat span { color: var(--muted); font-size: 12px; }
    .tabs { margin-top: 18px; }
    .tabs > input { position: absolute; opacity: 0; pointer-events: none; }
    .tab-list { display: flex; gap: 6px; border-bottom: 1px solid var(--line); overflow-x: auto; }
    .tab-list label { cursor: pointer; padding: 10px 12px; border: 1px solid transparent; border-bottom: 0; border-radius: 8px 8px 0 0; color: var(--muted); white-space: nowrap; }
    #tab-files:checked ~ .tab-list label[for="tab-files"],
    #tab-diff:checked ~ .tab-list label[for="tab-diff"],
    #tab-content:checked ~ .tab-list label[for="tab-content"],
    #tab-logs:checked ~ .tab-list label[for="tab-logs"] { background: var(--panel); border-color: var(--line); color: var(--text); }
    .panel { display: none; padding-top: 16px; }
    #tab-files:checked ~ .panels #panel-files,
    #tab-diff:checked ~ .panels #panel-diff,
    #tab-content:checked ~ .panels #panel-content,
    #tab-logs:checked ~ .panels #panel-logs { display: block; }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    th, td { padding: 9px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; background: var(--panel); }
    tr:last-child td { border-bottom: 0; }
    .num { text-align: right; width: 72px; }
    .plus { color: var(--good); }
    .minus { color: var(--bad); }
    .muted { color: var(--muted); }
    .notice { margin: 10px 0; border-left: 3px solid var(--accent); padding: 8px 10px; background: var(--panel); color: var(--text); }
    .code { margin: 0; overflow: auto; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--panel); white-space: pre-wrap; word-break: break-word; }
    .file-card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-bottom: 12px; background: color-mix(in srgb, var(--panel) 55%, transparent); }
    .d2h-wrapper { color: var(--text); }
    .d2h-file-wrapper, .d2h-file-header { border-color: var(--line); }
    .d2h-file-header { background: var(--panel); }
    .d2h-code-line, .d2h-code-side-line, .d2h-code-linenumber, .d2h-code-side-linenumber { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    @media (max-width: 720px) { main { padding: 16px; } header { display: block; } .stats { margin-top: 14px; min-width: 0; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Codex Review</h1>
        <p class="meta">Status: ${escapeHtml(run?.status || 'unknown')} · Task ${escapeHtml(taskId)} · Run ${escapeHtml(run?.id || '')}</p>
      </div>
      <div class="stats" aria-label="Run stats">
        <div class="stat"><strong>${escapeHtml(changedFiles.length)}</strong><span>files</span></div>
        <div class="stat"><strong class="plus">+${escapeHtml(plus)}</strong><span>additions</span></div>
        <div class="stat"><strong class="minus">-${escapeHtml(minus)}</strong><span>deletions</span></div>
      </div>
    </header>
    ${truncatedFileArtifacts > 0 ? `<p class="notice">${escapeHtml(truncatedFileArtifacts)} file artifacts were omitted from the attachment row. Use the sidecar API for the full file list.</p>` : ''}
    <section class="tabs">
      <input id="tab-files" name="tab" type="radio" checked>
      <input id="tab-diff" name="tab" type="radio">
      <input id="tab-content" name="tab" type="radio">
      <input id="tab-logs" name="tab" type="radio">
      <div class="tab-list" role="tablist">
        <label for="tab-files">Files</label>
        <label for="tab-diff">Diff</label>
        <label for="tab-content">Content</label>
        <label for="tab-logs">Logs</label>
      </div>
      <div class="panels">
        <section id="panel-files" class="panel">
          <h2>Changed files</h2>
          <table>
            <thead><tr><th>File</th><th>Status</th><th class="num">+</th><th class="num">-</th></tr></thead>
            <tbody>${buildFileRows(changedFiles)}</tbody>
          </table>
        </section>
        <section id="panel-diff" class="panel">
          <h2>Unified diff</h2>
          ${renderDiffHtml(run?.full_diff)}
        </section>
        <section id="panel-content" class="panel">
          <h2>File details</h2>
          ${buildFileDetailSections(fileDetails)}
        </section>
        <section id="panel-logs" class="panel">
          <h2>Run logs</h2>
          <pre class="code">${escapeHtml(limitedLogs.text)}</pre>
          ${limitedLogs.truncated ? '<p class="muted">Logs preview truncated. Open logs.txt for the full text.</p>' : ''}
        </section>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function buildSummary({ run, taskId, truncatedFileArtifacts }) {
  const changedFiles = Array.isArray(run?.changed_files) ? run.changed_files : [];
  const lines = [
    '# Codex Review',
    '',
    `Status: ${run?.status || 'unknown'}`,
    `Task: ${taskId}`,
    `Run: ${run?.id || ''}`,
    '',
    '## Changed Files',
    '',
    formatChangedFiles(changedFiles),
  ];

  if (truncatedFileArtifacts > 0) {
    lines.push('', `File content artifacts truncated: ${truncatedFileArtifacts}`);
  }

  return lines.join('\n');
}

async function getFileDetails(taskId, run) {
  const files = Array.isArray(run?.changed_files) ? run.changed_files : [];
  if (files.length === 0) {
    return [];
  }

  const max = Number(process.env.CODEX_REVIEW_MAX_FILE_ARTIFACTS || 20);
  const selected = Number.isFinite(max) && max > 0 ? files.slice(0, max) : files;
  const results = await Promise.allSettled(
    selected.map((file) => sidecar.getRunFile(taskId, run.id, file.id)),
  );

  return results
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value);
}

function buildAttachments({ taskId, run, fileDetails, messageId, toolCallId, conversationId }) {
  const updatedAt = run?.finished_at || run?.updated_at || new Date().toISOString();
  const runLabel = run?.id || crypto.randomUUID();
  const changedFiles = Array.isArray(run?.changed_files) ? run.changed_files : [];
  const max = Number(process.env.CODEX_REVIEW_MAX_FILE_ARTIFACTS || 20);
  const selectedLimit = Number.isFinite(max) && max > 0 ? max : changedFiles.length;
  const truncatedFileArtifacts = Math.max(0, changedFiles.length - selectedLimit);
  const attachments = [
    makeAttachment({
      text: buildReviewHtml({ run, taskId, fileDetails, truncatedFileArtifacts }),
      type: 'text/html',
      fileId: `${ENDPOINT}:${runLabel}:review`,
      filename: `codex-review/${runLabel}/review.html`,
      toolCallId,
      messageId,
      conversationId,
      updatedAt,
    }),
    makeAttachment({
      text: buildSummary({ run, taskId, truncatedFileArtifacts }),
      type: 'text/markdown',
      fileId: `${ENDPOINT}:${runLabel}:summary`,
      filename: `codex-review/${runLabel}/summary.md`,
      toolCallId,
      messageId,
      conversationId,
      updatedAt,
    }),
  ];

  if (run?.full_diff) {
    attachments.push(
      makeAttachment({
        text: run.full_diff,
        type: 'text/x-diff',
        fileId: `${ENDPOINT}:${runLabel}:changes`,
        filename: `codex-review/${runLabel}/changes.diff`,
        toolCallId,
        messageId,
        conversationId,
        updatedAt,
      }),
    );
  }

  attachments.push(
    makeAttachment({
      text: formatLogs(run),
      type: 'text/plain',
      fileId: `${ENDPOINT}:${runLabel}:logs`,
      filename: `codex-review/${runLabel}/logs.txt`,
      toolCallId,
      messageId,
      conversationId,
      updatedAt,
    }),
  );

  for (const file of fileDetails) {
    const path = file.path || file.new_path || file.old_path || file.id;
    if (file.diff) {
      attachments.push(
        makeAttachment({
          text: file.diff,
          type: 'text/x-diff',
          fileId: `${ENDPOINT}:${runLabel}:file-diff:${file.id}`,
          filename: `codex-review/${runLabel}/files/${path}.diff`,
          toolCallId,
          messageId,
          conversationId,
          updatedAt,
        }),
      );
    }

    if (
      file.new_content != null &&
      !file.is_binary &&
      !file.too_large &&
      !file.is_sensitive &&
      file.copyable !== false
    ) {
      attachments.push(
        makeAttachment({
          text: file.new_content,
          type: mimeForFilename(path),
          fileId: `${ENDPOINT}:${runLabel}:file-content:${file.id}`,
          filename: `codex-review/${runLabel}/files/${path}`,
          toolCallId,
          messageId,
          conversationId,
          updatedAt,
        }),
      );
    }
  }

  return attachments;
}

function buildResponseMessage({ run, userMessage, responseMessageId, taskId, fileDetails }) {
  const toolCallId = `${ENDPOINT}:${run.id}`;
  const text = responseTextForRun(run);
  const updatedAt = run?.finished_at || run?.updated_at || new Date().toISOString();
  const changedFilesCount = Array.isArray(run.changed_files) ? run.changed_files.length : 0;
  const hasChangedFiles = changedFilesCount > 0;
  const attachments = hasChangedFiles
    ? buildAttachments({
        taskId,
        run,
        fileDetails,
        messageId: responseMessageId,
        toolCallId,
        conversationId: userMessage.conversationId,
      })
    : undefined;
  const content = [{ type: 'text', text }];

  if (hasChangedFiles) {
    content.push({
      type: 'tool_call',
      tool_call: {
        id: toolCallId,
        type: 'tool_call',
        name: ENDPOINT,
        args: JSON.stringify({ taskId, runId: run.id }),
        output: `${run.status}; ${changedFilesCount} changed file(s)`,
        progress: 1,
      },
    });
  }

  return {
    messageId: responseMessageId,
    conversationId: userMessage.conversationId,
    parentMessageId: userMessage.messageId,
    isCreatedByUser: false,
    sender: SENDER,
    endpoint: ENDPOINT,
    model: MODEL,
    createdAt: updatedAt,
    updatedAt,
    text,
    content,
    attachments,
    metadata: {
      codexReview: {
        taskId,
        runId: run.id,
        status: run.status,
        changedFilesCount,
      },
    },
    error: run.status === 'failed',
    unfinished: false,
  };
}

function reqContext(req) {
  return {
    userId: req?.user?.id,
    isTemporary: req?.body?.isTemporary,
    interfaceConfig: req?.config?.interfaceConfig,
  };
}

async function saveConversation(req, { conversationId, title, createdAtOnInsert }) {
  const conversation = {
    conversationId,
    endpoint: ENDPOINT,
    endpointType: EModelEndpoint.custom,
    model: MODEL,
  };
  if (title) {
    conversation.title = title;
  }

  return db.saveConvo(reqContext(req), conversation, {
    context: 'api/server/controllers/codexReview.js - save conversation',
    createdAtOnInsert,
  });
}

async function runCodexReview(req, { job, conversationId, userMessage, responseMessageId, title }) {
  const streamId = conversationId;
  const jobCreatedAt = job.createdAt;
  const prompt = userMessage.text;
  let completed = false;
  let conversationTitle = title;

  try {
    await db.saveMessage(reqContext(req), userMessage, {
      context: 'api/server/controllers/codexReview.js - user message',
    });
    let conversation = await saveConversation(req, {
      conversationId,
      title,
      createdAtOnInsert: new Date(),
    });

    let task = await sidecar.getTaskByConversation(conversationId);
    let run;
    if (!task) {
      conversationTitle = conversationTitle || titleFromPrompt(prompt);
      if (!conversation?.title) {
        conversation = await saveConversation(req, {
          conversationId,
          title: conversationTitle,
        });
      }
      task = await sidecar.createTask({ conversationId, title: conversationTitle, prompt });
      run = task.latest_run;
      if (!run) {
        throw new Error('Codex Review sidecar did not create an initial run.');
      }
    } else {
      run = await sidecar.createRun(task.id, prompt);
    }
    const project = await sidecar.getProject(task.project_id).catch((error) => {
      logger.warn('[CodexReviewController] Failed to load Codex Review project metadata', {
        projectId: task.project_id,
        error: error?.message ?? error,
      });
      return null;
    });

    await GenerationJobManager.updateMetadata(streamId, {
      responseMessageId,
      sender: SENDER,
      endpoint: ENDPOINT,
      model: MODEL,
      conversationId,
      userMessage,
    });

    run = await sidecar.waitForRun(task.id, run.id, {
      signal: job.abortController.signal,
      onEvent: async ({ name, payload }) => {
        try {
          if (!(await isCurrentGenerationJob(streamId, jobCreatedAt))) {
            return;
          }
          await emitCodexReviewProgress(streamId, {
            taskId: task.id,
            runId: run.id,
            name,
            payload,
          });
        } catch (error) {
          logger.warn('[CodexReviewController] Failed to emit progress event', {
            taskId: task.id,
            runId: run.id,
            event: name,
            error: error?.message ?? error,
          });
        }
      },
    });
    if (job.abortController.signal.aborted) {
      return;
    }
    if (project?.repo_path) {
      run = { ...run, repo_path: project.repo_path };
    }

    const fileDetails = await getFileDetails(task.id, run).catch((error) => {
      logger.warn('[CodexReviewController] Failed to load file details', {
        taskId: task.id,
        runId: run.id,
        error: error?.message ?? error,
      });
      return [];
    });

    const responseMessage = buildResponseMessage({
      run,
      userMessage,
      responseMessageId,
      taskId: task.id,
      fileDetails,
    });

    await db.saveMessage(reqContext(req), responseMessage, {
      context: 'api/server/controllers/codexReview.js - response message',
    });
    conversation = await saveConversation(req, { conversationId, title: conversationTitle });

    completed = true;
    if (!(await isCurrentGenerationJob(streamId, jobCreatedAt))) {
      logger.debug('[CodexReviewController] Skipping final emit because job was replaced', {
        streamId,
        originalCreatedAt: jobCreatedAt,
      });
      return;
    }
    await GenerationJobManager.emitDone(streamId, {
      final: true,
      conversation: conversation || { conversationId, title: conversationTitle },
      title: conversation?.title || conversationTitle || DEFAULT_TITLE,
      requestMessage: sanitizeMessageForTransmit(userMessage),
      responseMessage,
    });
    await GenerationJobManager.completeJob(streamId);
  } catch (error) {
    if (job.abortController.signal.aborted) {
      return;
    }
    if (!(await isCurrentGenerationJob(streamId, jobCreatedAt))) {
      logger.debug('[CodexReviewController] Skipping error emit because job was replaced', {
        streamId,
        originalCreatedAt: jobCreatedAt,
      });
      return;
    }
    logger.error('[CodexReviewController] Failed to run Codex Review', error);
    await GenerationJobManager.emitError(
      streamId,
      error?.message || 'Codex Review request failed.',
    );
    await GenerationJobManager.completeJob(streamId, error?.message || 'Codex Review failed');
  } finally {
    if (!completed && job.abortController.signal.aborted) {
      logger.debug('[CodexReviewController] Run aborted', { conversationId });
    }
  }
}

async function CodexReviewController(req, res) {
  const userId = req.user?.id;
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    return res.status(400).json({ error: 'Missing message text.' });
  }

  const reqConversationId = req.body?.conversationId;
  const isNewConvo = !reqConversationId || reqConversationId === 'new';
  const conversationId = isNewConvo ? crypto.randomUUID() : reqConversationId;
  const streamId = conversationId;
  const parentMessageId = req.body?.parentMessageId || Constants.NO_PARENT;
  const userMessageId = req.body?.messageId || crypto.randomUUID();
  const responseMessageId = req.body?.responseMessageId || `${userMessageId.replace(/_+$/, '')}_`;
  const title = isNewConvo ? titleFromPrompt(text) : undefined;

  const userMessage = {
    messageId: userMessageId,
    parentMessageId,
    conversationId,
    sender: 'User',
    text,
    isCreatedByUser: true,
    user: userId,
    endpoint: ENDPOINT,
  };

  try {
    const existingJob = await GenerationJobManager.getJob(streamId);
    if (existingJob?.status === 'running') {
      if (existingJob.metadata?.userId && existingJob.metadata.userId !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }
      return res.status(409).json({
        error: 'A Codex run is already active for this conversation.',
        streamId,
        conversationId,
      });
    }

    const job = await GenerationJobManager.createJob(streamId, userId, conversationId);
    req._resumableStreamId = streamId;
    req.body.conversationId = conversationId;

    await GenerationJobManager.updateMetadata(streamId, {
      responseMessageId,
      sender: SENDER,
      endpoint: ENDPOINT,
      model: MODEL,
      conversationId,
      userMessage,
    });

    await GenerationJobManager.emitChunk(streamId, {
      created: true,
      message: userMessage,
      streamId,
    });

    res.json({ streamId, conversationId, status: 'started' });

    runCodexReview(req, {
      job,
      conversationId,
      userMessage,
      responseMessageId,
      title,
    }).catch((error) => {
      logger.error('[CodexReviewController] Unhandled background error', error);
    });
  } catch (error) {
    logger.error('[CodexReviewController] Failed to start Codex Review', error);
    return res.status(500).json({ error: error?.message || 'Failed to start Codex Review.' });
  }
}

module.exports = CodexReviewController;
module.exports._test = {
  buildResponseMessage,
  saveConversation,
  normalizeWorkspaceMarkdownLinks,
  sanitizeRunText,
};
