export type WebTerminalMode = 'shell' | 'codex';
export type WebTerminalTransportPreference = 'auto' | 'websocket' | 'http';

const transportPreferenceKey = 'ruc-terminal-transport-preference';
const httpFallbackUntilKey = 'ruc-terminal-http-fallback-until';
const httpFallbackTtlMs = 60 * 60 * 1000;
const defaultTransportPreference: WebTerminalTransportPreference = 'http';

function normalizeTerminalTransportPreference(
  value: string | null | undefined,
): WebTerminalTransportPreference | null {
  if (value === 'auto' || value === 'websocket' || value === 'http') {
    return value;
  }
  if (value === 'ws') {
    return 'websocket';
  }
  if (value === 'sse') {
    return 'http';
  }
  return null;
}

export function getTerminalTransportPreference(
  search?: string,
): WebTerminalTransportPreference {
  if (typeof window === 'undefined') {
    return defaultTransportPreference;
  }

  const query = new URLSearchParams(search ?? window.location.search);
  const fromQuery = normalizeTerminalTransportPreference(query.get('transport'));
  if (fromQuery) {
    window.localStorage.setItem(transportPreferenceKey, fromQuery);
    return fromQuery;
  }

  const fromStorage = normalizeTerminalTransportPreference(
    window.localStorage.getItem(transportPreferenceKey),
  );
  return fromStorage ?? defaultTransportPreference;
}

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

export function shouldStartTerminalWithHttpFallback(
  transportPreference: WebTerminalTransportPreference = getTerminalTransportPreference(),
) {
  if (transportPreference === 'http') {
    return true;
  }
  if (transportPreference === 'websocket') {
    return false;
  }
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

export function createTerminalSessionPath(
  mode: WebTerminalMode = 'shell',
  transportPreference: WebTerminalTransportPreference = getTerminalTransportPreference(),
) {
  const prefix = mode === 'codex' ? 'codex' : 'terminal';
  const query = new URLSearchParams();
  query.set('transport', transportPreference);
  return `/${prefix}/new?${query.toString()}`;
}
