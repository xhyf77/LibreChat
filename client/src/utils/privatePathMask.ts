export const privatePathMask = '[cwd hidden]';

const privatePathMaskFill = '.';
const privatePathAliasMinChars = 4;
const privatePathAliasesStorageKey = 'ruc-private-path-aliases';
const privatePathAliasesMax = 80;
const privatePathSeparatorChars = '·•∙';
const privatePathPrefixSource =
  `(^|[\\s${privatePathSeparatorChars}"\\'` + '`' + `\\(\\[\\{<:=,;，。；：])`;
const privatePathBoundarySource = `(?=$|[/\\s"\\'` + '`' + `\\)\\]\\}>:;,，。；：])`;
const privatePathSegmentSource = `[^/\\s"\\'` + '`' + `\\)\\]\\}>:;,，。；：]+`;
const privatePathRemainderSource = `${privatePathSegmentSource}(?:\\/${privatePathSegmentSource})*`;
const privateHomeRelativePathPattern = new RegExp(
  `${privatePathPrefixSource}(~\\/${privatePathRemainderSource})${privatePathBoundarySource}`,
  'g',
);
const privateAbsoluteHomePathPattern = new RegExp(
  `${privatePathPrefixSource}(\\/home\\/${privatePathSegmentSource}(?:\\/${privatePathRemainderSource})?)${privatePathBoundarySource}`,
  'g',
);

let cachedStoredAliases: string[] | null = null;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizePrivatePath(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function maskPathToken(prefix: string, pathToken: string) {
  if (pathToken.length <= privatePathMask.length) {
    return `${prefix}${privatePathMask.slice(0, Math.max(1, pathToken.length))}`;
  }
  return `${prefix}${privatePathMask}${privatePathMaskFill.repeat(
    pathToken.length - privatePathMask.length,
  )}`;
}

export function getPrivatePathAliases(path: string) {
  const normalized = normalizePrivatePath(path);
  if (!normalized || normalized === '/') {
    return [];
  }

  const aliases = new Set<string>([normalized]);
  const homeMatch = normalized.match(/^\/home\/[^/]+(?=\/|$)/);
  if (homeMatch) {
    const suffix = normalized.slice(homeMatch[0].length);
    if (suffix) {
      aliases.add(`~${suffix}`);
    }

    const pathParts = normalized.split('/').filter(Boolean);
    for (let index = 2; index < pathParts.length; index += 1) {
      const suffixAlias = `/${pathParts.slice(index).join('/')}`;
      if (suffixAlias.length >= privatePathAliasMinChars) {
        aliases.add(suffixAlias);
      }
    }
  }

  return [...aliases]
    .filter((alias) => alias.length > 1)
    .sort((left, right) => right.length - left.length);
}

function readStoredAliases() {
  if (cachedStoredAliases) {
    return cachedStoredAliases;
  }
  if (typeof window === 'undefined') {
    cachedStoredAliases = [];
    return cachedStoredAliases;
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(privatePathAliasesStorageKey) ?? '[]');
    cachedStoredAliases = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && value.length > 1)
      : [];
  } catch {
    cachedStoredAliases = [];
  }
  return cachedStoredAliases;
}

function writeStoredAliases(aliases: string[]) {
  cachedStoredAliases = aliases;
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(privatePathAliasesStorageKey, JSON.stringify(aliases));
  } catch {
    // Privacy masking must never make rendering fail if localStorage is blocked.
  }
}

export function rememberPrivatePathAliases(path?: string | null) {
  if (!path || typeof path !== 'string') {
    return;
  }
  const aliases = getPrivatePathAliases(path);
  if (aliases.length === 0) {
    return;
  }
  const merged = new Set([...readStoredAliases(), ...aliases]);
  const next = [...merged]
    .filter((alias) => alias.length > 1)
    .sort((left, right) => right.length - left.length)
    .slice(0, privatePathAliasesMax);
  writeStoredAliases(next);
}

function maskExactPrivatePathAlias(data: string, alias: string) {
  const aliasPattern = new RegExp(
    `${privatePathPrefixSource}(${escapeRegExp(alias)})${privatePathBoundarySource}`,
    'g',
  );
  return data.replace(aliasPattern, (_match: string, prefix: string, pathToken: string) =>
    maskPathToken(prefix, pathToken),
  );
}

function collectAliases(extraAliases: string[]) {
  return [...new Set([...extraAliases, ...readStoredAliases()])]
    .filter((alias) => alias.length >= privatePathAliasMinChars)
    .sort((left, right) => right.length - left.length);
}

export function maskPrivateLocalPaths(value?: string | null, extraAliases: string[] = []) {
  if (!value || typeof value !== 'string') {
    return value ?? '';
  }

  let masked = value.replace(
    privateHomeRelativePathPattern,
    (_match: string, prefix: string, pathToken: string) => maskPathToken(prefix, pathToken),
  );
  masked = masked.replace(
    privateAbsoluteHomePathPattern,
    (_match: string, prefix: string, pathToken: string) => maskPathToken(prefix, pathToken),
  );

  for (const alias of collectAliases(extraAliases)) {
    masked = maskExactPrivatePathAlias(masked, alias);
  }

  return masked;
}
