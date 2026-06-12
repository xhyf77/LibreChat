export type WebTerminalMode = 'shell' | 'codex';

const httpFallbackUntilKey = 'ruc-terminal-http-fallback-until';
const httpFallbackTtlMs = 60 * 60 * 1000;

export function rememberHttpTerminalFallback() {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(httpFallbackUntilKey, String(Date.now() + httpFallbackTtlMs));
}

export function clearHttpTerminalFallback() {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.removeItem(httpFallbackUntilKey);
}

export function shouldStartTerminalWithHttpFallback() {
  if (typeof window === 'undefined') {
    return false;
  }
  const value = Number(window.localStorage.getItem(httpFallbackUntilKey) || 0);
  if (!Number.isFinite(value) || value <= Date.now()) {
    window.localStorage.removeItem(httpFallbackUntilKey);
    return false;
  }
  return true;
}

export function createTerminalSessionPath(mode: WebTerminalMode = 'shell') {
  const prefix = mode === 'codex' ? 'codex' : 'terminal';
  return `/${prefix}/new`;
}
