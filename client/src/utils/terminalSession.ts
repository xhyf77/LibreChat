export type WebTerminalMode = 'shell' | 'codex';

export function createTerminalSessionId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createTerminalSessionPath(mode: WebTerminalMode = 'shell') {
  const prefix = mode === 'codex' ? 'codex' : 'terminal';
  return `/${prefix}/${createTerminalSessionId()}`;
}
