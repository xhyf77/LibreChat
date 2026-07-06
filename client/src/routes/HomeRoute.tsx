import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  FileDiff,
  GitCommitHorizontal,
  GitCompare,
  Loader2,
  MonitorUp,
  Power,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import { apiBaseUrl, request } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';
import { createTerminalSessionPath } from '~/utils';
import { rememberPrivatePathAliases } from '~/utils/privatePathMask';

const repoPath = '~/work/example-repo';
const terminalPollIntervalMs = 4000;
const endedTerminalTombstoneMs = 10_000;
const hiddenTerminalCwdLabel = 'cwd hidden';

type TerminalSession = {
  sessionId: string;
  mode: 'shell' | 'codex';
  pid: number;
  cwd: string;
  exited: boolean;
  clients: number;
};

type TerminalSessionsResponse = {
  sessions: TerminalSession[];
};

type TerminalActionResponse = {
  ok: boolean;
  reason?: string;
};

const diffRoutes = [
  {
    title: 'Single-column diff',
    description: 'Review the current workspace changes with diff2html.',
    href: '/diff/',
    label: 'Open diff',
    Icon: GitCompare,
  },
  {
    title: 'File editor',
    description: 'Search, preview, edit, copy, and save repo files.',
    href: '/diff/file',
    label: 'Edit files',
    Icon: FileDiff,
  },
  {
    title: 'Commit flow',
    description: 'Select files, preview staged diff, add, and commit locally.',
    href: '/diff/commit',
    label: 'Open commit',
    Icon: GitCommitHorizontal,
  },
];

const diffQuickLinks = [
  { label: 'Project explorer', href: '/diff/explorer' },
  { label: 'Split diff', href: '/diff/split' },
  { label: 'Paste import', href: '/diff/import' },
];

function terminalSessionHref(session: TerminalSession) {
  return `/${session.mode === 'codex' ? 'codex' : 'terminal'}/${session.sessionId}`;
}

function terminalSessionKey(session: Pick<TerminalSession, 'mode' | 'sessionId'>) {
  return `${session.mode}:${session.sessionId}`;
}

export default function HomeRoute() {
  const { user } = useAuthContext();
  const navigate = useNavigate();
  const endedSessionIdsRef = useRef<Map<string, number>>(new Map());
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [endingSessionIds, setEndingSessionIds] = useState<Set<string>>(() => new Set());
  const displayName = user?.name || user?.username || user?.email || 'connect-user';

  const refreshSessions = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setIsLoadingSessions(true);
    }
    setSessionError(null);
    try {
      const data = await request.get<TerminalSessionsResponse>(
        `${apiBaseUrl()}/api/codex-cli/sessions`,
      );
      const now = Date.now();
      for (const [sessionId, expiresAt] of endedSessionIdsRef.current.entries()) {
        if (expiresAt <= now) {
          endedSessionIdsRef.current.delete(sessionId);
        }
      }
      const activeSessions = (data.sessions ?? []).filter(
        (session) => !session.exited && !endedSessionIdsRef.current.has(terminalSessionKey(session)),
      );
      activeSessions.forEach((session) => rememberPrivatePathAliases(session.cwd));
      setSessions(activeSessions);
    } catch {
      setSessionError('Unable to load terminals');
    } finally {
      setIsLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    void refreshSessions(true);
    const interval = window.setInterval(() => {
      void refreshSessions();
    }, terminalPollIntervalMs);
    return () => window.clearInterval(interval);
  }, [refreshSessions]);

  const endSession = useCallback(
    async (session: TerminalSession) => {
      const key = terminalSessionKey(session);
      endedSessionIdsRef.current.set(key, Date.now() + endedTerminalTombstoneMs);
      setEndingSessionIds((current) => new Set(current).add(key));
      setSessions((current) => current.filter((item) => terminalSessionKey(item) !== key));
      try {
        const result = await request.delete<TerminalActionResponse>(
          `${apiBaseUrl()}/api/codex-cli/sessions/${encodeURIComponent(session.sessionId)}`,
        );
        if (!result.ok) {
          endedSessionIdsRef.current.delete(key);
          setSessionError(result.reason || 'Unable to end terminal');
          await refreshSessions();
          return;
        }
        window.setTimeout(() => {
          void refreshSessions();
        }, 500);
      } catch {
        endedSessionIdsRef.current.delete(key);
        setSessionError('Unable to end terminal');
        await refreshSessions();
      } finally {
        setEndingSessionIds((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [refreshSessions],
  );

  const openNewTerminal = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }
      const nextPath = createTerminalSessionPath('shell');
      if (event.ctrlKey || event.metaKey) {
        window.open(nextPath, '_blank');
        return;
      }
      navigate(nextPath);
    },
    [navigate],
  );

  return (
    <main className="min-h-full overflow-auto bg-[#fafafa] text-[#383a42]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 sm:px-7 lg:px-9">
        <section className="flex flex-col gap-5 border-b border-[#d9d9dc] pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-4 inline-flex items-center gap-2 rounded-md border border-[#d9d9dc] bg-[#f4f4f5] px-2.5 py-1 text-xs font-medium text-[#696c77]">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Authenticated workspace
            </div>
            <h1 className="text-3xl font-semibold leading-tight tracking-normal text-[#202227] sm:text-4xl">
              Ruc workspace
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#5f626b] sm:text-[15px]">
              {displayName} · {repoPath}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#696c77]">
            <span className="rounded-md border border-[#d9d9dc] bg-white px-2.5 py-1">PTY native</span>
            <span className="rounded-md border border-[#d9d9dc] bg-white px-2.5 py-1">Server terminal</span>
            <span className="rounded-md border border-[#d9d9dc] bg-white px-2.5 py-1">Local git</span>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(380px,1.1fr)]">
          <section className="flex min-h-[232px] flex-col justify-between rounded-lg border border-[#d9d9dc] bg-white p-5 text-left shadow-sm">
            <div>
              <div className="mb-5 flex size-10 items-center justify-center rounded-md bg-blue-500/10 text-blue-600">
                <TerminalSquare className="size-5" aria-hidden="true" />
              </div>
              <h2 className="text-lg font-semibold text-[#202227]">New server terminal</h2>
              <p className="mt-2 text-sm leading-6 text-[#5f626b]">
                Start a fresh PTY in the server workspace. Each browser tab maps to one live terminal.
              </p>
              <p className="mt-4 text-xs leading-5 text-[#696c77]">
                Transport is automatic: WebSocket first, with HTTP fallback remembered for restricted networks.
              </p>
            </div>
            <button
              type="button"
              className="group mt-5 inline-flex h-10 w-fit items-center justify-center gap-2 rounded-md bg-[#4078f2] px-3 text-sm font-medium text-white transition-colors hover:bg-[#2f5fbe] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2] focus-visible:ring-offset-2"
              onClick={openNewTerminal}
            >
              Open terminal
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          </section>

          <section className="rounded-lg border border-[#d9d9dc] bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3 border-b border-[#e4e4e7] pb-4">
              <div>
                <h2 className="text-lg font-semibold text-[#202227]">Open terminals</h2>
                <p className="mt-1.5 text-sm leading-6 text-[#5f626b]">
                  Live PTY sessions currently held by the server.
                </p>
              </div>
              <button
                type="button"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-[#d9d9dc] bg-[#fafafa] text-[#5f626b] transition-colors hover:border-[#b8bbc3] hover:text-[#202227] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2]"
                aria-label="Refresh terminals"
                onClick={() => void refreshSessions(true)}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 min-h-[132px]">
              {isLoadingSessions && sessions.length === 0 ? (
                <div className="flex h-[132px] items-center justify-center gap-2 text-sm text-[#696c77]">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Loading terminals
                </div>
              ) : sessionError ? (
                <div className="flex h-[132px] items-center justify-center rounded-md border border-rose-200 bg-rose-50 px-4 text-sm text-rose-700">
                  {sessionError}
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex h-[132px] flex-col items-center justify-center rounded-md border border-dashed border-[#d9d9dc] bg-[#fafafa] px-4 text-center">
                  <MonitorUp className="mb-3 size-5 text-[#696c77]" aria-hidden="true" />
                  <p className="text-sm font-medium text-[#383a42]">No open terminals</p>
                  <p className="mt-1 text-xs text-[#696c77]">Create one from the panel on the left.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {sessions.map((session) => {
                    const sessionKey = terminalSessionKey(session);
                    const isEnding = endingSessionIds.has(sessionKey);
                    const sessionHref = terminalSessionHref(session);
                    return (
                      <div
                        key={sessionKey}
                        className="grid gap-3 rounded-md border border-[#e4e4e7] bg-[#fafafa] p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                      >
                        <Link
                          to={sessionHref}
                          className="min-w-0 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2]"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <TerminalSquare className="size-4 shrink-0 text-[#4078f2]" aria-hidden="true" />
                            <span className="truncate text-sm font-semibold text-[#202227]">
                              {session.sessionId}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#696c77]">
                            <span>pid {session.pid}</span>
                            <span>{session.clients} client{session.clients === 1 ? '' : 's'}</span>
                            <span>{session.mode}</span>
                          </div>
                          <p className="mt-1 truncate text-xs text-[#696c77]">
                            {hiddenTerminalCwdLabel}
                          </p>
                        </Link>
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            to={sessionHref}
                            className="inline-flex h-8 items-center justify-center rounded-md border border-[#d9d9dc] bg-white px-3 text-xs font-medium text-[#2f5fbe] transition-colors hover:border-[#b8bbc3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2]"
                          >
                            Open
                          </Link>
                          <button
                            type="button"
                            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 text-xs font-medium text-rose-700 transition-colors hover:border-rose-300 hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={isEnding}
                            onClick={() => void endSession(session)}
                          >
                            {isEnding ? (
                              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <Power className="size-3.5" aria-hidden="true" />
                            )}
                            End
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </section>

        <section className="rounded-lg border border-[#d9d9dc] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-[#e4e4e7] pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-[#202227]">Diff2HTML workbench</h2>
              <p className="mt-1.5 text-sm leading-6 text-[#5f626b]">
                Independent diff workspace for review, file editing, import, staging, and commit.
              </p>
            </div>
            <a
              href="/diff/"
              className="inline-flex h-9 w-fit items-center justify-center gap-2 rounded-md bg-[#4078f2] px-3 text-sm font-medium text-white transition-colors hover:bg-[#2f5fbe] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2] focus-visible:ring-offset-2"
            >
              Open workbench
              <ArrowRight className="size-4" aria-hidden="true" />
            </a>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {diffRoutes.map(({ title, description, href, label, Icon }) => (
              <a
                key={title}
                href={href}
                className="group rounded-md border border-[#e4e4e7] bg-[#fafafa] p-4 transition-colors hover:border-[#b8bbc3] hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2]"
              >
                <Icon className="mb-4 size-5 text-[#4078f2]" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-[#202227]">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#5f626b]">{description}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-[#2f5fbe]">
                  {label}
                  <ArrowRight
                    className="size-3.5 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </a>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {diffQuickLinks.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rounded-md border border-[#d9d9dc] bg-white px-2.5 py-1 text-xs font-medium text-[#5f626b] transition-colors hover:border-[#b8bbc3] hover:text-[#202227] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2]"
              >
                {item.label}
              </a>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
