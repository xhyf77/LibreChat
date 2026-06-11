import { Link } from 'react-router-dom';
import {
  ArrowRight,
  FileDiff,
  GitCommitHorizontal,
  GitCompare,
  ShieldCheck,
  TerminalSquare,
  Workflow,
} from 'lucide-react';
import { useAuthContext } from '~/hooks';

const repoPath = '~/fjj/hm_os/hm-verif-kernel';

const primaryActions = [
  {
    title: 'Server Terminal',
    description: 'A browser tab maps to a live PTY on the server.',
    href: '/terminal/new',
    label: 'Open terminal',
    Icon: TerminalSquare,
    accent: 'text-blue-600 bg-blue-500/10',
  },
  {
    title: 'Codex CLI',
    description: 'Start Codex inside the same server workspace.',
    href: '/codex/new',
    label: 'Open Codex',
    Icon: Workflow,
    accent: 'text-emerald-600 bg-emerald-500/10',
  },
];

const diffItems = [
  {
    title: 'Diff view',
    description: 'Review current repository changes with a focused diff surface.',
    Icon: GitCompare,
  },
  {
    title: 'File workspace',
    description: 'Open changed files, inspect latest content, and copy clean source text.',
    Icon: FileDiff,
  },
  {
    title: 'Commit flow',
    description: 'Stage selected files and create local commits without pushing upstream.',
    Icon: GitCommitHorizontal,
  },
];

export default function HomeRoute() {
  const { user } = useAuthContext();
  const displayName = user?.name || user?.username || user?.email || 'xieminhui';

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
            <span className="rounded-md border border-[#d9d9dc] bg-white px-2.5 py-1">Codex CLI</span>
            <span className="rounded-md border border-[#d9d9dc] bg-white px-2.5 py-1">Local git</span>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          {primaryActions.map(({ title, description, href, label, Icon, accent }) => (
            <Link
              key={title}
              to={href}
              className="group flex min-h-[172px] flex-col justify-between rounded-lg border border-[#d9d9dc] bg-white p-5 shadow-sm transition-colors hover:border-[#b8bbc3] hover:bg-[#fbfbfb] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2]"
            >
              <div>
                <div className={`mb-5 flex size-10 items-center justify-center rounded-md ${accent}`}>
                  <Icon className="size-5" aria-hidden="true" />
                </div>
                <h2 className="text-lg font-semibold text-[#202227]">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-[#5f626b]">{description}</p>
              </div>
              <div className="mt-5 flex items-center gap-2 text-sm font-medium text-[#2f5fbe]">
                {label}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </div>
            </Link>
          ))}
        </section>

        <section className="rounded-lg border border-[#d9d9dc] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-[#e4e4e7] pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-[#202227]">Diff2HTML workbench</h2>
              <p className="mt-1.5 text-sm leading-6 text-[#5f626b]">
                Local diff review, file inspection, editing, staging, and commit flow.
              </p>
            </div>
            <span className="w-fit rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
              Next module
            </span>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {diffItems.map(({ title, description, Icon }) => (
              <div key={title} className="rounded-lg border border-[#e4e4e7] bg-[#fafafa] p-4">
                <Icon className="mb-4 size-5 text-[#4078f2]" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-[#202227]">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#5f626b]">{description}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
