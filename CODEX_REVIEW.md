# Codex Review Integration

This fork keeps LibreChat as the chat application. Codex Review is exposed as a
LibreChat endpoint named `codex-review`; the endpoint handler calls the FastAPI
sidecar instead of an OpenAI-compatible model API.

## Local Environment

Copy `.env.codex-review.example` into your real LibreChat `.env` or process
environment, then replace the placeholder secrets:

```bash
CONFIG_PATH=librechat.codex-review.yaml
ENDPOINTS=custom
HOST=127.0.0.1
PORT=3080
MONGO_URI=mongodb://127.0.0.1:27017/LibreChatCodex

CODEX_REVIEW_API_BASE=http://127.0.0.1:8000/api
CODEX_REVIEW_PROJECT_ID=hm-verif-kernel
CODEX_REVIEW_API_TOKEN=
CODEX_REVIEW_ADMIN_USER=
CODEX_REVIEW_ADMIN_PASSWORD=
CODEX_REVIEW_DUMMY_API_KEY=codex-review-local
```

Set either `CODEX_REVIEW_API_TOKEN` to a bearer token accepted by the sidecar, or
set `CODEX_REVIEW_ADMIN_USER` and `CODEX_REVIEW_ADMIN_PASSWORD` so the adapter can
log in to the sidecar automatically. Keep these values in environment variables,
not in repo-tracked files.

For the public demo deployment, only `client/dist` is copied to the public
server. Caddy serves that static directory and proxies `/api`, `/oauth`,
`/images`, and health-check routes through a reverse SSH tunnel to the local
LibreChat backend on `127.0.0.1:3080`. The local LibreChat backend calls the
FastAPI sidecar directly through `CODEX_REVIEW_API_BASE=http://127.0.0.1:8000/api`.

## Data Flow

```text
LibreChat conversation
  -> /api/agents/chat/codex-review
  -> FastAPI sidecar task/run APIs
  -> Codex CLI in the task workspace
  -> LibreChat assistant message + Codex Review artifacts
```

The user's prompt is sent as-is to the sidecar. Repo path, project id, base ref,
workspace path, raw logs, and diff metadata stay out of the assistant message.
If Codex mentions the task workspace absolute path in its final answer, the
adapter rewrites that path to a repo-relative path before saving the LibreChat
assistant message.

## Native Codex Experience

- Do not wrap the user's prompt before handing it to Codex. If a UI or API layer
  ever needs display metadata, unwrap it back to the user's text before the
  runner writes `prompt.md` or sends stdin to `codex exec`.
- One LibreChat conversation maps to one sidecar task and one Codex thread. The
  first run captures the Codex `thread_id`; follow-up runs use
  `codex exec resume <thread_id>` so Codex sees native conversation continuity.
- Treat the repository state as the source of truth for file changes. The
  sidecar snapshots the task workspace before each run, lets Codex operate
  normally, then uses git status/diff against that snapshot to decide whether
  artifacts or file-change UI are needed.
- Avoid adding product-level system prompts, hidden task wrappers, or synthetic
  "review" instructions unless the user explicitly asks for that behavior.

The LibreChat adapter waits on the sidecar run event stream first:

```text
GET /tasks/:taskId/runs/:runId/events
```

If that stream fails before completion, it falls back to polling the run status.
Abort signals from LibreChat also request sidecar run cancellation.

## Message and Artifact Behavior

- Runs with no changed files save a normal assistant text message only. They do
  not attach internal `summary.md` or `logs.txt` files.
- Runs with changed files attach Codex Review artifacts to the assistant message
  using LibreChat's native tool-call attachment shape.
- The first changed-file artifact is `review.html`, a generated review dashboard
  with Files, Diff, Content, and Logs tabs. The Diff tab is rendered server-side
  with the open-source `diff2html` package.
- `changes.diff`, per-file `.diff`, and per-file content are also attached as
  native LibreChat artifacts. Source files route through LibreChat's existing
  Monaco-backed artifact editor.
- The sidecar task id, run id, status, and changed-file count are kept in message
  metadata for bookkeeping.

Preview size can be tuned with:

```bash
CODEX_REVIEW_HTML_DIFF_MAX_CHARS=200000
CODEX_REVIEW_HTML_FILE_MAX_CHARS=30000
CODEX_REVIEW_HTML_LOG_MAX_CHARS=100000
```

## Cleanup Behavior

LibreChat `conversationId` maps to one sidecar task. Deleting a Codex Review
conversation calls the sidecar `DELETE /tasks/by-conversation/:conversationId`
endpoint after the LibreChat conversation is removed.

Delete paths covered:

- `DELETE /api/convos` for a single conversation.
- `DELETE /api/convos/all` for deleting all conversations.
- Account deletion through the user controller.

If a run is active, LibreChat first aborts the active generation job. The sidecar
then requests run cancellation and deletion is retried briefly so the workspace
can be removed once the runner exits.
