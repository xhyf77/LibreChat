export type WebTerminalMode = 'shell' | 'codex';

export function createTerminalSessionPath(mode: WebTerminalMode = 'shell') {
  const prefix = mode === 'codex' ? 'codex' : 'terminal';
  return `/${prefix}/new`;
}
