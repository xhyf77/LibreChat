import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Terminal, type IBufferLine } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import { apiBaseUrl, request } from 'librechat-data-provider';
import copyToClipboard from 'copy-to-clipboard';
import { Eye } from 'lucide-react';
import { useAuthContext } from '~/hooks';
import {
  clearHttpTerminalFallback,
  createTerminalSessionPath,
  getTerminalTransportPreference,
  rememberHttpTerminalFallback,
  shouldStartTerminalWithHttpFallback,
} from '~/utils';
import { rememberPrivatePathAliases } from '~/utils/privatePathMask';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';

type TicketResponse = {
  ticket: string;
  expiresAt: string;
};

type TerminalMode = 'shell' | 'codex';

type TerminalExitInfo = {
  exitCode?: number;
  signal?: number;
};

type TerminalSessionResponse = {
  sessionId: string;
  mode: TerminalMode;
  pid: number;
  cwd: string;
  serverPid?: number;
  serverInstanceId?: string;
};

type TerminalTransport = 'websocket' | 'sse';

type HttpInputStream = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  closed: boolean;
};

type TerminalSnapshot = {
  key: string;
  data: string;
};

type PendingInputChunk = {
  seq: number;
  data: string;
};

type TerminalServerMessage = {
  type?: string;
  data?: string;
  replayKind?: 'xterm-serialize' | 'raw-tail';
  seq?: number;
  clientId?: string;
  inputClientId?: string;
  inputSeq?: number;
  pid?: number;
  cwd?: string;
  sessionId?: string;
  mode?: TerminalMode;
  serverPid?: number;
  serverInstanceId?: string;
  exitCode?: number;
  signal?: number;
};

type TerminalDebugMetrics = {
  reconnects: number;
  sseMessages: number;
  sseErrors: number;
  wsMessages: number;
  inputEvents: number;
  inputChars: number;
  outputMessages: number;
  outputChars: number;
  httpStreamChars: number;
  httpPostChars: number;
  httpStreamRetries: number;
  wsInputChars: number;
  terminalWriteOverflows: number;
  blankRecoveries: number;
  currentTerminalWritePendingChars: number;
  maxTerminalWritePendingChars: number;
  lastInputAt: number;
  lastEchoMs: number | null;
  lastSseMessageAt: number;
  lastSseGapMs: number | null;
  maxSseGapMs: number;
  lastReconnectAt: number;
};

const atomOneLightTheme = {
  background: '#fafafa',
  foreground: '#202227',
  cursor: '#526fff',
  cursorAccent: '#fafafa',
  selectionBackground: '#e5e5e6',
  black: '#202227',
  red: '#b8292f',
  green: '#2d7d35',
  yellow: '#7c5b00',
  blue: '#245fc7',
  magenta: '#8b2388',
  cyan: '#007197',
  white: '#4b4f58',
  brightBlack: '#5f626b',
  brightRed: '#9f1239',
  brightGreen: '#256f30',
  brightYellow: '#684900',
  brightBlue: '#1f55b5',
  brightMagenta: '#7d1f79',
  brightCyan: '#005f80',
  brightWhite: '#202227',
};

const terminalFont =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "Symbols Nerd Font Mono", "Roboto Mono", "SFMono-Regular", "SF Mono", "Cascadia Code", Menlo, Consolas, "Liberation Mono", monospace';
const terminalFontSize = 14;
const terminalScrollbackRows = 4000;
const terminalSnapshotScrollbackRows = 400;
const terminalSnapshotMaxBytes = 192 * 1024;
const terminalSnapshotMinIntervalMs = 3000;
const terminalSnapshotSlowMs = 120;
const terminalSnapshotSlowBackoffMs = 15000;
const terminalSnapshotTtlMs = 30000;
const terminalReplayChunkChars = 4 * 1024;
const terminalLiveWriteFlushChars = 4 * 1024;
const terminalLiveDirectWriteChars = 1024;
const terminalLiveDirectWriteMinIntervalMs = 6;
const terminalWritePendingMaxChars = 128 * 1024;
const terminalHiddenBacklogMaxChars = 256 * 1024;
const terminalHiddenForceReplayMs = 5 * 60_000;
const terminalRestoreThrottleMs = 250;
const terminalResponseSuppressMs = 1500;
const httpInputFlushMs = 1;
const httpInputPostMaxBytes = 96 * 1024;
const httpInputStreamRetryMinMs = 500;
const httpInputStreamRetryMaxMs = 4000;
const httpOutputAckFlushMs = 40;
const httpOutputAckFlushBytes = 16 * 1024;
const websocketFallbackMs = 1800;
const websocketUnstableCloseMs = 120_000;
const reconnectMinDelayMs = 150;
const reconnectMaxDelayMs = 5000;
const reconnectNoticeMinIntervalMs = 5000;
const pendingReconnectInputFlushMs = 150;
const pendingReconnectInputLimit = 1024 * 1024;
const terminalQueryResponsePattern =
  /^(?:\x1b\[[?>]?[0-9;]*[Rc]|\x1b\](?:10|11);rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\))+$/;
const terminalFileLinePattern =
  /(^|[\s([{<"'`:;，。；：])((?:(?:\.{1,2}|~)?\/)?(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+\.[A-Za-z0-9_+-]+:[1-9][0-9]*(?::[1-9][0-9]*)?)(?=$|[\s)\]}>,"'`:;，。；：])/g;
const terminalWordSequences = {
  backward: '\x1b[1;5D',
  forward: '\x1b[1;5C',
  deleteBackward: '\x17',
};
const terminalDebugStorageKey = 'ruc-terminal-debug';
const terminalWebglStorageKey = 'ruc-terminal-webgl';
const terminalInputStorageKey = 'ruc-terminal-input';
const terminalDebugRefreshMs = 1000;
const terminalBlankRecoveryMinIntervalMs = 1500;
const terminalCodexStatusTailMaxChars = 512;
const terminalPrivatePathMask = '[cwd hidden]';
const terminalPrivatePathMaskFill = '.';
const terminalPrivatePathAliasMinChars = 4;
const terminalCwdRevealKey = 'F2';
const terminalCodexStatusSeparatorChars = '·•∙';
const terminalCodexStatusSeparatorSource = `[${terminalCodexStatusSeparatorChars}]`;
const terminalAnsiSequenceSource =
  '\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1b\\\\)|.)';
const terminalAnsiSequenceAtPattern = new RegExp(`^(?:${terminalAnsiSequenceSource})`);
const terminalPrivatePathPrefixSource =
  `(^|[\\s${terminalCodexStatusSeparatorChars}"'\\\`([{<:=,;，。；：](?:${terminalAnsiSequenceSource})*)`;
const terminalVisiblePrivatePathPrefixSource =
  `(^|[\\s${terminalCodexStatusSeparatorChars}"'\\\`([{<:=,;，。；：])`;
const terminalPrivatePathBoundarySource = `(?=$|[/\\s"'\\\`)\\]}>:;,，。；：])`;
const terminalHomeRelativePathTokenSource = '~\\/[^\\s"\'`\\)\\]}>\\x1b]+';
const terminalAbsoluteHomePathTokenSource =
  '\\/home\\/[^\\/\\s"\'`\\)\\]}>\\x1b]+\\/[^\\s"\'`\\)\\]}>\\x1b]+';
const terminalPrivatePathFragmentTokenSource = '(?:~(?:\\/[^\\s"\'`\\)\\]}>\\x1b]*)?|\\/[^\\s"\'`\\)\\]}>\\x1b]*)';
const terminalHomeRelativePathPattern = new RegExp(
  `${terminalPrivatePathPrefixSource}(${terminalHomeRelativePathTokenSource})`,
  'g',
);
const terminalAbsoluteHomePathPattern = new RegExp(
  `${terminalPrivatePathPrefixSource}(${terminalAbsoluteHomePathTokenSource})`,
  'g',
);
const terminalStatusPrivatePathPattern = new RegExp(
  `(·(?:${terminalAnsiSequenceSource})*\\s*(?:${terminalAnsiSequenceSource})*)` +
    `(${terminalHomeRelativePathTokenSource}|${terminalAbsoluteHomePathTokenSource})`,
  'g',
);
const terminalAnsiSequencePattern = new RegExp(terminalAnsiSequenceSource, 'g');
const terminalVisibleSpaceSource = `(?:\\s|${terminalAnsiSequenceSource})+`;
const terminalVisibleOptionalSpaceSource = `(?:\\s|${terminalAnsiSequenceSource})*`;
const terminalCodexStatusModelSource = '(?:gpt-[A-Za-z0-9._-]+|o[0-9][A-Za-z0-9._-]*)';
const terminalCodexStatusEffortSource = '(?:xhigh|high|medium|low|minimal)';
const terminalCodexStatusOptionsSource = '(?:\\s+[A-Za-z0-9._-]+){0,2}';
const terminalCodexStatusPlainPrefixSource =
  `\\b${terminalCodexStatusModelSource}\\s+${terminalCodexStatusEffortSource}` +
  `${terminalCodexStatusOptionsSource}\\s+${terminalCodexStatusSeparatorSource}`;
const terminalCodexStatusPrivatePathPattern = new RegExp(
  `${terminalCodexStatusPlainPrefixSource}\\s+` +
    `(${terminalHomeRelativePathTokenSource}|${terminalAbsoluteHomePathTokenSource})`,
  'g',
);
const terminalCodexStatusTrailingPathFragmentPattern = new RegExp(
  `${terminalCodexStatusPlainPrefixSource}\\s+(${terminalPrivatePathFragmentTokenSource})$`,
);
const terminalCodexStatusPathLeadPattern = new RegExp(
  `${terminalCodexStatusPlainPrefixSource}\\s*$`,
);
const terminalLeadingPrivatePathPattern = new RegExp(
  `^((?:${terminalAnsiSequenceSource})*\\s*(?:${terminalAnsiSequenceSource})*)` +
    `(${terminalHomeRelativePathTokenSource}|${terminalAbsoluteHomePathTokenSource})`,
  'g',
);
const terminalLeadingPathContinuationPattern = new RegExp(
  `^((?:${terminalAnsiSequenceSource})*)([^\\s"'\\\`)\\]}>\\x1b]+)`,
  'g',
);
const terminalLeadingPathFragmentPattern = new RegExp(
  `^((?:${terminalAnsiSequenceSource})*\\s*(?:${terminalAnsiSequenceSource})*)` +
    `(${terminalPrivatePathFragmentTokenSource})`,
  'g',
);
const terminalCodexStatusPrivatePathMaskPattern = new RegExp(
  `((?:(?:^|[^A-Za-z0-9._-])(?:${terminalAnsiSequenceSource})*|(?:${terminalAnsiSequenceSource})+)` +
    `${terminalCodexStatusModelSource}${terminalVisibleSpaceSource}` +
    `${terminalCodexStatusEffortSource}` +
    `(?:${terminalVisibleSpaceSource}[A-Za-z0-9._-]+){0,2}` +
    `${terminalVisibleSpaceSource}${terminalCodexStatusSeparatorSource}` +
    `${terminalVisibleOptionalSpaceSource})` +
    `(${terminalHomeRelativePathTokenSource}|${terminalAbsoluteHomePathTokenSource})`,
  'g',
);

function createTerminalDebugMetrics(): TerminalDebugMetrics {
  return {
    reconnects: 0,
    sseMessages: 0,
    sseErrors: 0,
    wsMessages: 0,
    inputEvents: 0,
    inputChars: 0,
    outputMessages: 0,
    outputChars: 0,
    httpStreamChars: 0,
    httpPostChars: 0,
    httpStreamRetries: 0,
    wsInputChars: 0,
    terminalWriteOverflows: 0,
    blankRecoveries: 0,
    currentTerminalWritePendingChars: 0,
    maxTerminalWritePendingChars: 0,
    lastInputAt: 0,
    lastEchoMs: null,
    lastSseMessageAt: 0,
    lastSseGapMs: null,
    maxSseGapMs: 0,
    lastReconnectAt: 0,
  };
}

let terminalOutputEncoder: TextEncoder | null = null;

function getTerminalOutputBytes(data: string) {
  if (typeof TextEncoder === 'undefined') {
    return data.length;
  }
  terminalOutputEncoder ??= new TextEncoder();
  return terminalOutputEncoder.encode(data).length;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTerminalPath(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function getTerminalPrivatePathAliases(cwd: string) {
  const normalized = normalizeTerminalPath(cwd);
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
  }
  const pathParts = normalized.split('/').filter(Boolean);
  for (let index = 2; index < pathParts.length; index += 1) {
    const suffix = `/${pathParts.slice(index).join('/')}`;
    if (suffix.length >= terminalPrivatePathAliasMinChars) {
      aliases.add(suffix);
    }
  }

  return [...aliases]
    .filter((alias) => alias.length > 1)
    .sort((left, right) => right.length - left.length);
}

function maskTerminalPathToken(prefix: string, pathToken: string) {
  if (pathToken.length <= terminalPrivatePathMask.length) {
    return `${prefix}${terminalPrivatePathMask.slice(0, Math.max(1, pathToken.length))}`;
  }
  // Avoid space padding here: WebGL can leave old glyphs visible for blank cells.
  return `${prefix}${terminalPrivatePathMask}${terminalPrivatePathMaskFill.repeat(
    pathToken.length - terminalPrivatePathMask.length,
  )}`;
}

function maskExactTerminalPathAlias(data: string, alias: string) {
  const aliasPattern = new RegExp(
    `${terminalPrivatePathPrefixSource}(${escapeRegExp(alias)})${terminalPrivatePathBoundarySource}`,
    'g',
  );
  return data.replace(aliasPattern, (_match: string, prefix: string, pathToken: string) =>
    maskTerminalPathToken(prefix, pathToken),
  );
}

function expandTerminalHomePath(pathToken: string, cwd: string) {
  if (!pathToken.startsWith('~/')) {
    return pathToken;
  }
  const homeMatch = normalizeTerminalPath(cwd).match(/^\/home\/[^/]+(?=\/|$)/);
  if (!homeMatch) {
    return pathToken;
  }
  return `${homeMatch[0]}${pathToken.slice(1)}`;
}

function collectTerminalPathMatches(
  paths: string[],
  data: string,
  pattern: RegExp,
  cwd: string,
) {
  pattern.lastIndex = 0;
  for (const match of data.matchAll(pattern)) {
    const pathToken = match[2];
    if (pathToken) {
      paths.push(expandTerminalHomePath(pathToken, cwd));
    }
  }
}

function stripTerminalAnsiSequences(data: string) {
  terminalAnsiSequencePattern.lastIndex = 0;
  return data.replace(terminalAnsiSequencePattern, '');
}

function getTerminalPathMatchingText(data: string) {
  return stripTerminalAnsiSequences(data).replace(/[\x00-\x1f\x7f]+/g, '');
}

function getTerminalAnsiSequenceLengthAt(data: string, index: number) {
  if (data.charCodeAt(index) !== 0x1b) {
    return 0;
  }
  const match = terminalAnsiSequenceAtPattern.exec(data.slice(index));
  return match?.[0]?.length ?? 1;
}

function getTerminalVisibleTextMap(data: string) {
  let visible = '';
  const originalIndexes: number[] = [];
  let index = 0;
  while (index < data.length) {
    const ansiLength = getTerminalAnsiSequenceLengthAt(data, index);
    if (ansiLength > 0) {
      index += ansiLength;
      continue;
    }

    const char = data[index];
    const charCode = char.charCodeAt(0);
    if (charCode < 0x20 || charCode === 0x7f) {
      index += 1;
      continue;
    }

    visible += char;
    originalIndexes.push(index);
    index += 1;
  }
  return { visible, originalIndexes };
}

type TerminalVisiblePathRange = {
  visibleEnd: number;
  visiblePath: string;
  visibleStart: number;
};

type TerminalTextPathRange = {
  end: number;
  path: string;
  start: number;
};

function addTerminalVisiblePathRange(
  ranges: TerminalVisiblePathRange[],
  originalIndexes: number[],
  visibleStart: number,
  visiblePath: string,
) {
  if (!visiblePath) {
    return;
  }
  const visibleEnd = visibleStart + visiblePath.length;
  if (
    !Number.isSafeInteger(visibleStart) ||
    !Number.isSafeInteger(visibleEnd) ||
    originalIndexes[visibleStart] == null ||
    originalIndexes[visibleEnd - 1] == null ||
    visibleEnd <= visibleStart
  ) {
    return;
  }
  ranges.push({ visibleStart, visibleEnd, visiblePath });
}

function mergeTerminalVisiblePathRanges(ranges: TerminalVisiblePathRange[]) {
  const sorted = [...ranges].sort((left, right) =>
    left.visibleStart === right.visibleStart
      ? right.visibleEnd - left.visibleEnd
      : left.visibleStart - right.visibleStart,
  );
  const merged: TerminalVisiblePathRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.visibleStart >= previous.visibleEnd) {
      merged.push({ ...range });
      continue;
    }
    if (range.visibleEnd > previous.visibleEnd) {
      previous.visibleEnd = range.visibleEnd;
      if (range.visiblePath.length > previous.visiblePath.length) {
        previous.visiblePath = range.visiblePath;
      }
    }
  }
  return merged;
}

function addTerminalTextPathRange(
  ranges: TerminalTextPathRange[],
  start: number,
  path: string,
) {
  const end = start + path.length;
  if (!path || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    return;
  }
  ranges.push({ start, end, path });
}

function collectTerminalTextPathMatches(
  ranges: TerminalTextPathRange[],
  text: string,
  pattern: RegExp,
) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const pathToken = match[2];
    if (!pathToken || match.index == null) {
      continue;
    }
    const pathOffset = match[0].lastIndexOf(pathToken);
    if (pathOffset < 0) {
      continue;
    }
    addTerminalTextPathRange(ranges, match.index + pathOffset, pathToken);
  }
}

function collectTerminalExactAliasTextMatches(
  ranges: TerminalTextPathRange[],
  text: string,
  alias: string,
) {
  const aliasPattern = new RegExp(
    `${terminalVisiblePrivatePathPrefixSource}(${escapeRegExp(alias)})${terminalPrivatePathBoundarySource}`,
    'g',
  );
  aliasPattern.lastIndex = 0;
  for (const match of text.matchAll(aliasPattern)) {
    const pathToken = match[2];
    if (!pathToken || match.index == null) {
      continue;
    }
    const pathOffset = match[0].lastIndexOf(pathToken);
    if (pathOffset < 0) {
      continue;
    }
    addTerminalTextPathRange(ranges, match.index + pathOffset, pathToken);
  }
}

function collectTerminalCodexStatusPathFragmentTextMatches(
  ranges: TerminalTextPathRange[],
  text: string,
) {
  terminalCodexStatusTrailingPathFragmentPattern.lastIndex = 0;
  const match = terminalCodexStatusTrailingPathFragmentPattern.exec(text);
  const pathToken = match?.[1];
  if (!pathToken || match?.index == null) {
    return;
  }
  const pathOffset = match[0].lastIndexOf(pathToken);
  if (pathOffset < 0) {
    return;
  }
  addTerminalTextPathRange(ranges, match.index + pathOffset, pathToken);
}

function mergeTerminalTextPathRanges(ranges: TerminalTextPathRange[]) {
  const sorted = [...ranges].sort((left, right) =>
    left.start === right.start ? right.end - left.end : left.start - right.start,
  );
  const merged: TerminalTextPathRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start >= previous.end) {
      merged.push({ ...range });
      continue;
    }
    if (range.end > previous.end) {
      previous.end = range.end;
      if (range.path.length > previous.path.length) {
        previous.path = range.path;
      }
    }
  }
  return merged;
}

function collectTerminalPrivatePathTextRanges(text: string, cwd: string) {
  const ranges: TerminalTextPathRange[] = [];
  collectTerminalTextPathMatches(ranges, text, terminalHomeRelativePathPattern);
  collectTerminalTextPathMatches(ranges, text, terminalAbsoluteHomePathPattern);
  if (cwd) {
    for (const alias of getTerminalPrivatePathAliases(cwd)) {
      collectTerminalExactAliasTextMatches(ranges, text, alias);
    }
  }
  collectTerminalCodexStatusPathFragmentTextMatches(ranges, text);
  return mergeTerminalTextPathRanges(ranges);
}

function maskTerminalControlSequencePrivatePaths(sequence: string, cwd: string) {
  if (!sequence.startsWith('\x1b]')) {
    return sequence;
  }

  const terminatorLength = sequence.endsWith('\x1b\\') ? 2 : sequence.endsWith('\x07') ? 1 : 0;
  const bodyEnd = terminatorLength ? sequence.length - terminatorLength : sequence.length;
  const body = sequence.slice(2, bodyEnd);
  if (!body) {
    return sequence;
  }

  const maskedBody = maskTerminalPrivatePaths(body, cwd);
  if (maskedBody === body) {
    return sequence;
  }
  return `${sequence.slice(0, 2)}${maskedBody}${sequence.slice(bodyEnd)}`;
}

function maskTerminalVisiblePrivatePaths(data: string, cwd: string) {
  const { visible, originalIndexes } = getTerminalVisibleTextMap(data);
  if (!visible || originalIndexes.length === 0) {
    return data;
  }

  const ranges: TerminalVisiblePathRange[] = [];
  for (const range of collectTerminalPrivatePathTextRanges(visible, cwd)) {
    addTerminalVisiblePathRange(ranges, originalIndexes, range.start, range.path);
  }

  const merged = mergeTerminalVisiblePathRanges(ranges);
  if (merged.length === 0) {
    return data;
  }

  const replacementByOriginalIndex = new Map<number, string>();
  for (const range of merged) {
    const maskText = maskTerminalPathToken('', range.visiblePath);
    for (let visibleIndex = range.visibleStart; visibleIndex < range.visibleEnd; visibleIndex += 1) {
      const originalIndex = originalIndexes[visibleIndex];
      const maskIndex = visibleIndex - range.visibleStart;
      if (originalIndex != null && maskIndex < maskText.length) {
        replacementByOriginalIndex.set(originalIndex, maskText[maskIndex]);
      }
    }
  }

  let masked = '';
  let index = 0;
  while (index < data.length) {
    const ansiLength = getTerminalAnsiSequenceLengthAt(data, index);
    if (ansiLength > 0) {
      masked += maskTerminalControlSequencePrivatePaths(data.slice(index, index + ansiLength), cwd);
      index += ansiLength;
      continue;
    }

    const replacement = replacementByOriginalIndex.get(index);
    masked += replacement ?? data[index];
    index += 1;
  }
  return masked;
}

function appendTerminalCodexStatusTail(tail: string, data: string) {
  const combined = `${tail}${getTerminalPathMatchingText(data)}`;
  return combined.slice(-terminalCodexStatusTailMaxChars);
}

function endsWithTerminalCodexStatusPathLead(data: string) {
  terminalCodexStatusPathLeadPattern.lastIndex = 0;
  return terminalCodexStatusPathLeadPattern.test(getTerminalPathMatchingText(data));
}

function extractTerminalPrivatePathCandidates(data: string, cwd: string) {
  const statusPaths = extractTerminalStatusPrivatePathCandidates(data, cwd);
  if (statusPaths.length > 0) {
    return statusPaths;
  }

  const paths: string[] = [];
  collectTerminalPathMatches(paths, data, terminalHomeRelativePathPattern, cwd);
  collectTerminalPathMatches(paths, data, terminalAbsoluteHomePathPattern, cwd);
  return paths;
}

function extractTerminalStatusPrivatePathCandidates(data: string, cwd: string) {
  const statusPaths: string[] = [];
  collectTerminalPathMatches(statusPaths, data, terminalStatusPrivatePathPattern, cwd);
  return statusPaths;
}

function extractTerminalCodexStatusPrivatePathCandidates(data: string, cwd: string) {
  const plain = getTerminalPathMatchingText(data);
  const paths: string[] = [];
  terminalCodexStatusPrivatePathPattern.lastIndex = 0;
  for (const match of plain.matchAll(terminalCodexStatusPrivatePathPattern)) {
    const pathToken = match[1];
    if (pathToken) {
      paths.push(expandTerminalHomePath(pathToken, cwd));
    }
  }
  return paths;
}

function extractTerminalLeadingPrivatePathCandidates(data: string, cwd: string) {
  const paths: string[] = [];
  collectTerminalPathMatches(paths, data, terminalLeadingPrivatePathPattern, cwd);
  return paths;
}

function extractTerminalCodexStatusTrailingPathFragment(data: string) {
  const plain = getTerminalPathMatchingText(data);
  const match = plain.match(terminalCodexStatusTrailingPathFragmentPattern);
  return match?.[1] ?? '';
}

function extractTerminalLeadingPathContinuationToken(data: string) {
  terminalLeadingPathContinuationPattern.lastIndex = 0;
  const match = terminalLeadingPathContinuationPattern.exec(data);
  return match?.[2] ?? '';
}

function extractTerminalLeadingPathFragmentToken(data: string) {
  terminalLeadingPathFragmentPattern.lastIndex = 0;
  const match = terminalLeadingPathFragmentPattern.exec(data);
  return match?.[2] ?? '';
}

function joinTerminalPathContinuation(pathPrefix: string, continuation: string) {
  if (!pathPrefix || !continuation) {
    return '';
  }
  return `${pathPrefix}${continuation}`;
}

function extractTerminalPathContinuationCandidates(
  data: string,
  cwd: string,
  pathPrefix: string,
) {
  const continuation = extractTerminalLeadingPathContinuationToken(data);
  const joined = joinTerminalPathContinuation(pathPrefix, continuation);
  return joined ? [expandTerminalHomePath(joined, cwd)] : [];
}

function extractTerminalLeadingPathFragmentCandidates(data: string, cwd: string) {
  const fragment = extractTerminalLeadingPathFragmentToken(data);
  return fragment ? [expandTerminalHomePath(fragment, cwd)] : [];
}

function maskTerminalPrivatePaths(data: string, cwd: string) {
  if (!data) {
    return data;
  }

  let masked = maskTerminalVisiblePrivatePaths(data, cwd);
  masked = masked.replace(
    terminalHomeRelativePathPattern,
    (_match: string, prefix: string, pathToken: string) =>
      maskTerminalPathToken(prefix, pathToken),
  );
  masked = masked.replace(
    terminalAbsoluteHomePathPattern,
    (_match: string, prefix: string, pathToken: string) =>
      maskTerminalPathToken(prefix, pathToken),
  );
  if (cwd) {
    for (const alias of getTerminalPrivatePathAliases(cwd)) {
      masked = maskExactTerminalPathAlias(masked, alias);
    }
  }
  return masked;
}

function maskTerminalCodexStatusPrivatePaths(data: string) {
  if (!data) {
    return data;
  }
  terminalCodexStatusPrivatePathMaskPattern.lastIndex = 0;
  return data.replace(
    terminalCodexStatusPrivatePathMaskPattern,
    (_match: string, prefix: string, pathToken: string) =>
      maskTerminalPathToken(prefix, pathToken),
  );
}

function maskTerminalLeadingPrivatePath(data: string) {
  if (!data) {
    return data;
  }
  terminalLeadingPrivatePathPattern.lastIndex = 0;
  return data.replace(
    terminalLeadingPrivatePathPattern,
    (_match: string, prefix: string, pathToken: string) =>
      maskTerminalPathToken(prefix, pathToken),
  );
}

function maskTerminalLeadingPathContinuation(data: string) {
  if (!data) {
    return data;
  }
  terminalLeadingPathContinuationPattern.lastIndex = 0;
  return data.replace(
    terminalLeadingPathContinuationPattern,
    (_match: string, prefix: string, pathToken: string) =>
      maskTerminalPathToken(prefix, pathToken),
  );
}

function maskTerminalLeadingPathFragment(data: string) {
  if (!data) {
    return data;
  }
  terminalLeadingPathFragmentPattern.lastIndex = 0;
  return data.replace(
    terminalLeadingPathFragmentPattern,
    (_match: string, prefix: string, pathToken: string) =>
      maskTerminalPathToken(prefix, pathToken),
  );
}

function hasTerminalCodexStatusPrivatePath(data: string, cwd: string) {
  return extractTerminalCodexStatusPrivatePathCandidates(data, cwd).length > 0;
}

function maskTerminalRestoredPrivatePaths(
  data: string,
  cwd: string,
  isCodexRoute: boolean,
  privacyActive: boolean,
) {
  if (!data) {
    return data;
  }
  const hasCodexStatusPath = hasTerminalCodexStatusPrivatePath(data, cwd);
  if (!hasCodexStatusPath && !privacyActive && !isCodexRoute) {
    return data;
  }
  return maskTerminalPrivatePaths(data, cwd);
}

function createInputClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function encodeInputChunk(chunk: PendingInputChunk) {
  return `${JSON.stringify({ seq: chunk.seq, data: chunk.data })}\n`;
}

function isTerminalDebugEnabled(search: string) {
  if (typeof window === 'undefined') {
    return false;
  }
  const query = new URLSearchParams(search);
  const value = query.get('terminalDebug');
  if (value === '1' || value === 'true') {
    window.localStorage.setItem(terminalDebugStorageKey, '1');
    return true;
  }
  if (value === '0' || value === 'false') {
    window.localStorage.removeItem(terminalDebugStorageKey);
    return false;
  }
  return window.localStorage.getItem(terminalDebugStorageKey) === '1';
}

function isTerminalWebglEnabled(search: string) {
  if (typeof window === 'undefined') {
    return true;
  }
  const query = new URLSearchParams(search);
  const value = query.get('terminalWebgl');
  if (value === '0' || value === 'false' || value === 'off') {
    window.localStorage.setItem(terminalWebglStorageKey, '0');
    return false;
  }
  if (value === '1' || value === 'true' || value === 'on') {
    window.localStorage.setItem(terminalWebglStorageKey, '1');
    return true;
  }
  return window.localStorage.getItem(terminalWebglStorageKey) !== '0';
}

function isTerminalReplayEnabled(search: string) {
  const query = new URLSearchParams(search);
  const value = query.get('terminalReplay');
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'none';
}

function isTerminalInputStreamEnabled(search: string) {
  if (typeof window === 'undefined') {
    return false;
  }
  const query = new URLSearchParams(search);
  const value = query.get('terminalInput');
  if (value === 'post' || value === 'http-post' || value === 'short') {
    window.localStorage.setItem(terminalInputStorageKey, 'post');
    return false;
  }
  if (value === 'stream' || value === 'streaming' || value === 'input-stream') {
    window.localStorage.setItem(terminalInputStorageKey, 'stream');
    return true;
  }
  return false;
}

function formatMs(value: number | null) {
  if (value == null) {
    return '-';
  }
  return `${Math.round(value)}ms`;
}

function loadTerminalFonts(fontSize: number) {
  if (typeof document === 'undefined' || !document.fonts) {
    return Promise.resolve();
  }
  return Promise.allSettled([
    document.fonts.load(`400 ${fontSize}px "JetBrainsMono Nerd Font Mono"`),
    document.fonts.load(`700 ${fontSize}px "JetBrainsMono Nerd Font Mono"`),
    document.fonts.load(`400 ${fontSize}px "Symbols Nerd Font Mono"`),
  ]).then(() => undefined);
}

function buildWebSocketUrl({
  ticket,
  sessionId,
  mode,
  cols,
  rows,
}: {
  ticket: string;
  sessionId: string;
  mode: TerminalMode;
  cols: number;
  rows: number;
}) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = apiBaseUrl();
  const path = `${base}/api/codex-cli/terminal`;
  const url = new URL(path || '/api/codex-cli/terminal', `${protocol}//${window.location.host}`);
  url.protocol = protocol;
  url.searchParams.set('ticket', ticket);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('mode', mode);
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));
  return url.toString();
}

function buildEventSourceUrl({
  ticket,
  sessionId,
  mode,
  afterSeq,
  replay,
}: {
  ticket: string;
  sessionId: string;
  mode: TerminalMode;
  afterSeq?: number;
  replay?: 'none';
}) {
  const base = apiBaseUrl();
  const path = `${base}/api/codex-cli/sessions/${encodeURIComponent(sessionId)}/events`;
  const url = new URL(path || `/api/codex-cli/sessions/${encodeURIComponent(sessionId)}/events`, window.location.origin);
  url.searchParams.set('ticket', ticket);
  url.searchParams.set('mode', mode);
  if (typeof afterSeq === 'number' && Number.isSafeInteger(afterSeq) && afterSeq > 0) {
    url.searchParams.set('afterSeq', String(afterSeq));
  }
  if (replay) {
    url.searchParams.set('replay', replay);
  }
  return url.toString();
}

function isValidSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && sessionId !== 'new' && /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId);
}

function isTerminalShortcut(event: KeyboardEvent, key: string) {
  return (
    !event.altKey &&
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === key
  );
}

function getTerminalWordSequence(event: KeyboardEvent) {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
    return null;
  }

  if (event.key === 'Backspace' || event.code === 'Backspace') {
    return terminalWordSequences.deleteBackward;
  }
  if (event.key === 'ArrowLeft' || event.key === 'Left' || event.code === 'ArrowLeft') {
    return terminalWordSequences.backward;
  }
  if (event.key === 'ArrowRight' || event.key === 'Right' || event.code === 'ArrowRight') {
    return terminalWordSequences.forward;
  }

  return null;
}

function installClipboardHandlers(
  terminal: Terminal,
  container: HTMLDivElement,
  writeInput: (data: string) => void,
) {
  terminal.attachCustomKeyEventHandler((event) => {
    const wordSequence = getTerminalWordSequence(event);
    if (wordSequence) {
      if (event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        writeInput(wordSequence);
      }
      return false;
    }

    if (isTerminalShortcut(event, 'c')) {
      const selection = terminal.getSelection();
      if (!selection) {
        return true;
      }
      if (event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        copyToClipboard(selection);
      }
      return false;
    }

    if (isTerminalShortcut(event, 'v')) {
      if (event.type === 'keydown') {
        event.stopPropagation();
      }
      return false;
    }

    return true;
  });

  const handlePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    terminal.paste(text);
    terminal.focus();
  };

  container.addEventListener('paste', handlePaste, true);
  return () => container.removeEventListener('paste', handlePaste, true);
}

function getTerminalLineTextWithColumns(line: IBufferLine, columns: number) {
  const columnByTextIndex: number[] = [];
  let text = '';

  for (let column = 0; column < Math.min(columns, line.length); column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) {
      continue;
    }
    const chars = cell.getChars() || ' ';
    const start = text.length;
    text += chars;
    for (let index = start; index < text.length; index += 1) {
      columnByTextIndex[index] = column;
    }
  }

  while (text.endsWith(' ')) {
    text = text.slice(0, -1);
  }

  return { text, columnByTextIndex };
}

function findFileLineSelectionAtColumn(line: IBufferLine, columns: number, column: number) {
  const { text, columnByTextIndex } = getTerminalLineTextWithColumns(line, columns);
  terminalFileLinePattern.lastIndex = 0;

  for (const match of text.matchAll(terminalFileLinePattern)) {
    const token = match[2];
    if (!token || typeof match.index !== 'number') {
      continue;
    }
    const tokenTextIndex = match.index + match[0].indexOf(token);
    const tokenEndTextIndex = tokenTextIndex + token.length - 1;
    const startColumn = columnByTextIndex[tokenTextIndex] ?? tokenTextIndex;
    const endColumn = (columnByTextIndex[tokenEndTextIndex] ?? tokenEndTextIndex) + 1;

    if (column >= startColumn && column < endColumn) {
      return {
        column: startColumn,
        length: endColumn - startColumn,
      };
    }
  }

  return null;
}

function getTerminalMouseBufferPosition(terminal: Terminal, event: MouseEvent) {
  const screenElement = terminal.element?.querySelector('.xterm-screen');
  if (!(screenElement instanceof HTMLElement)) {
    return null;
  }
  if (event.target instanceof Node && !screenElement.contains(event.target)) {
    return null;
  }

  const rect = screenElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) {
    return null;
  }

  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    return null;
  }

  const column = Math.max(0, Math.min(terminal.cols - 1, Math.floor((x / rect.width) * terminal.cols)));
  const viewportRow = Math.max(0, Math.min(terminal.rows - 1, Math.floor((y / rect.height) * terminal.rows)));

  return {
    column,
    row: terminal.buffer.active.viewportY + viewportRow,
  };
}

function installFileLineSelectionHandler(terminal: Terminal, container: HTMLDivElement) {
  const handleDoubleClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    const position = getTerminalMouseBufferPosition(terminal, event);
    if (!position) {
      return;
    }

    const line = terminal.buffer.active.getLine(position.row);
    if (!line) {
      return;
    }

    const selection = findFileLineSelectionAtColumn(line, terminal.cols, position.column);
    if (!selection) {
      return;
    }

    event.preventDefault();
    window.setTimeout(() => {
      terminal.select(selection.column, position.row, selection.length);
    }, 0);
  };

  container.addEventListener('dblclick', handleDoubleClick, true);
  return () => container.removeEventListener('dblclick', handleDoubleClick, true);
}

function isTerminalQueryResponse(data: string) {
  return terminalQueryResponsePattern.test(data);
}

function isTerminalViewportBlank(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.baseY);
  const end = Math.min(buffer.length, buffer.baseY + terminal.rows);
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (line?.translateToString(true).trim()) {
      return false;
    }
  }
  return true;
}

function writeTerminalData(
  terminal: Terminal,
  data: string,
  callback?: () => void,
) {
  if (!data || data.length <= terminalReplayChunkChars) {
    terminal.write(data, callback);
    return;
  }

  let offset = 0;
  const writeNextChunk = () => {
    const chunk = data.slice(offset, offset + terminalReplayChunkChars);
    offset += terminalReplayChunkChars;
    terminal.write(chunk, () => {
      if (offset >= data.length) {
        callback?.();
        return;
      }
      window.requestAnimationFrame(writeNextChunk);
    });
  };
  writeNextChunk();
}

function captureTerminalViewport(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return {
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
    offsetFromBottom: Math.max(0, buffer.baseY - buffer.viewportY),
    atBottom: buffer.viewportY >= buffer.baseY,
  };
}

function restoreTerminalViewport(
  terminal: Terminal,
  snapshot: ReturnType<typeof captureTerminalViewport> | null,
) {
  if (!snapshot || snapshot.atBottom) {
    return;
  }

  const buffer = terminal.buffer.active;
  const targetLine =
    buffer.baseY >= snapshot.baseY
      ? Math.min(snapshot.viewportY, buffer.baseY)
      : Math.max(0, buffer.baseY - snapshot.offsetFromBottom);
  terminal.scrollToLine(targetLine);
  terminal.refresh(0, Math.max(0, terminal.rows - 1));
}

function refreshTerminalGlyphs(terminal: Terminal) {
  try {
    terminal.clearTextureAtlas();
  } catch {
    // Texture atlas cleanup is best-effort; refresh still helps fallback renderers.
  }
  terminal.refresh(0, Math.max(0, terminal.rows - 1));
  window.requestAnimationFrame(() => {
    try {
      terminal.clearTextureAtlas();
    } catch {
      // Ignore renderer races during tab restore or addon replacement.
    }
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  });
}

function scheduleIdleTask(callback: () => void, timeoutMs: number) {
  const browserWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (browserWindow.requestIdleCallback && browserWindow.cancelIdleCallback) {
    const handle = browserWindow.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => browserWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, Math.min(timeoutMs, 1000));
  return () => window.clearTimeout(handle);
}

export default function CodexCliRoute() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, token } = useAuthContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const renderAddonRef = useRef<WebglAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const eventClientIdRef = useRef<string | null>(null);
  const transportRef = useRef<TerminalTransport | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const terminalCwdRef = useRef('');
  const terminalCwdFromOutputRef = useRef(false);
  const inputStreamRef = useRef<HttpInputStream | null>(null);
  const inputStreamDisabledRef = useRef(false);
  const inputStreamRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputStreamRetryAttemptRef = useRef(0);
  const inputClientIdRef = useRef(createInputClientId());
  const nextInputSeqRef = useRef(1);
  const pendingInputChunksRef = useRef<PendingInputChunk[]>([]);
  const queuedInputChunksRef = useRef<PendingInputChunk[]>([]);
  const inputPostInFlightRef = useRef(false);
  const flushQueuedInputRef = useRef<() => void>(() => undefined);
  const pendingReconnectInputRef = useRef('');
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestReconnectRef = useRef<() => void>(() => undefined);
  const reconnectAttemptRef = useRef(0);
  const lastReconnectNoticeAtRef = useRef(0);
  const snapshotClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSnapshotCancelRef = useRef<(() => void) | null>(null);
  const lastSnapshotAtRef = useRef(0);
  const skipSnapshotsUntilRef = useRef(0);
  const lastBlankRecoveryAtRef = useRef(0);
  const hiddenAtRef = useRef(0);
  const reconnectCounter = useRef(0);
  const lastSessionIdRef = useRef<string | null>(null);
  const pendingSessionCreateRef = useRef<TerminalMode | null>(null);
  const connectedRef = useRef(false);
  const reconnectOnVisibleRef = useRef(false);
  const resetBeforeReplayRef = useRef(false);
  const terminalSnapshotRef = useRef<TerminalSnapshot | null>(null);
  const terminalOutputBufferRef = useRef('');
  const terminalOutputAckBytesRef = useRef(0);
  const terminalOutputSeqRef = useRef(0);
  const terminalOutputPrivacyRefreshRef = useRef(false);
  const terminalCodexStatusTailRef = useRef('');
  const terminalCodexStatusPathPrefixRef = useRef('');
  const appliedOutputSeqRef = useRef(0);
  const terminalOutputFrameRef = useRef(0);
  const terminalOutputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalPrivacyRefreshFrameRef = useRef(0);
  const outputAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOutputAckBytesRef = useRef(0);
  const sendOutputAckRef = useRef<(bytes: number) => void>(() => undefined);
  const terminalWriteInFlightRef = useRef(false);
  const terminalWritePendingRef = useRef('');
  const terminalWritePendingCallbacksRef = useRef<(() => void)[]>([]);
  const terminalWriteGenerationRef = useRef(0);
  const writeTerminalOutputRef = useRef<(data: string, callback?: () => void) => void>(
    () => undefined,
  );
  const lastDirectTerminalWriteAtRef = useRef(0);
  const suppressTerminalResponsesUntilRef = useRef(0);
  const hasExitedRef = useRef(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [exitInfo, setExitInfo] = useState<TerminalExitInfo | null>(null);
  const [terminalCwd, setTerminalCwd] = useState('');
  const [cwdReveal, setCwdReveal] = useState(false);

  const terminalMode: TerminalMode = location.pathname.startsWith('/codex') ? 'codex' : 'shell';
  const [terminalCwdPrivacyActive, setTerminalCwdPrivacyActive] = useState(
    () => terminalMode === 'codex',
  );
  const terminalModeRef = useRef<TerminalMode>(terminalMode);
  terminalModeRef.current = terminalMode;
  const terminalCwdPrivacyActiveRef = useRef(terminalMode === 'codex');
  const shouldHideTerminalCwd = terminalCwdPrivacyActive;
  const routePrefix = terminalMode === 'codex' ? 'codex' : 'terminal';
  const terminalDebugEnabled = useMemo(
    () => isTerminalDebugEnabled(location.search),
    [location.search],
  );
  const terminalWebglEnabled = useMemo(
    () => isTerminalWebglEnabled(location.search),
    [location.search],
  );
  const terminalWebglEnabledRef = useRef(terminalWebglEnabled);
  terminalWebglEnabledRef.current = terminalWebglEnabled;
  const terminalReplayEnabled = useMemo(
    () => isTerminalReplayEnabled(location.search),
    [location.search],
  );
  const terminalReplayEnabledRef = useRef(terminalReplayEnabled);
  terminalReplayEnabledRef.current = terminalReplayEnabled;
  const terminalInputStreamEnabled = useMemo(
    () => isTerminalInputStreamEnabled(location.search),
    [location.search],
  );
  const terminalInputStreamEnabledRef = useRef(terminalInputStreamEnabled);
  terminalInputStreamEnabledRef.current = terminalInputStreamEnabled;
  const transportPreference = useMemo(
    () => getTerminalTransportPreference(location.search),
    [location.search],
  );
  const terminalDebugMetricsRef = useRef<TerminalDebugMetrics>(createTerminalDebugMetrics());
  const [terminalDebugSnapshot, setTerminalDebugSnapshot] = useState('');

  const enableTerminalCwdPrivacy = useCallback(() => {
    if (terminalCwdPrivacyActiveRef.current) {
      return;
    }
    terminalCwdPrivacyActiveRef.current = true;
    setTerminalCwdPrivacyActive(true);
  }, []);

  useEffect(() => {
    const active = terminalMode === 'codex';
    terminalCwdPrivacyActiveRef.current = active;
    setTerminalCwdPrivacyActive(active);
    if (!active) {
      setCwdReveal(false);
    }
  }, [terminalMode]);

  const rememberTerminalCwd = useCallback((cwd?: string, source: 'session' | 'output' = 'session') => {
    if (!cwd || typeof cwd !== 'string') {
      return;
    }
    const normalizedCwd = normalizeTerminalPath(cwd);
    if (!normalizedCwd) {
      return;
    }
    rememberPrivatePathAliases(normalizedCwd);
    if (!terminalCwdPrivacyActiveRef.current) {
      if (source === 'session') {
        terminalCwdRef.current = normalizedCwd;
      }
      return;
    }
    if (source !== 'output' && terminalCwdFromOutputRef.current && terminalCwdRef.current) {
      return;
    }
    if (source === 'output') {
      terminalCwdFromOutputRef.current = true;
    }
    if (terminalCwdRef.current === normalizedCwd) {
      return;
    }
    terminalCwdRef.current = normalizedCwd;
    setTerminalCwd(normalizedCwd);
  }, []);

  const rememberTerminalOutputPaths = useCallback(
    (data: string, codexStatusPathsOverride?: string[]) => {
      const cwd = terminalCwdRef.current;
      const codexStatusPaths =
        codexStatusPathsOverride ?? extractTerminalCodexStatusPrivatePathCandidates(data, cwd);
      if (codexStatusPaths.length > 0) {
        enableTerminalCwdPrivacy();
      }
      if (!terminalCwdPrivacyActiveRef.current) {
        return;
      }
      const paths =
        codexStatusPaths.length > 0
          ? codexStatusPaths
          : extractTerminalPrivatePathCandidates(data, cwd);
      const latestPath = paths.at(-1);
      if (latestPath) {
        rememberTerminalCwd(latestPath, 'output');
      }
    },
    [enableTerminalCwdPrivacy, rememberTerminalCwd],
  );

  const scheduleTerminalPrivacyRefresh = useCallback(() => {
    if (terminalPrivacyRefreshFrameRef.current) {
      return;
    }
    terminalPrivacyRefreshFrameRef.current = window.requestAnimationFrame(() => {
      terminalPrivacyRefreshFrameRef.current = 0;
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      refreshTerminalGlyphs(terminal);
    });
  }, []);

  const activeSessionId = useMemo(() => {
    if (isValidSessionId(sessionId)) {
      return sessionId;
    }
    return null;
  }, [sessionId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!terminalDebugEnabled) {
      setTerminalDebugSnapshot('');
      return;
    }

    const updateDebugSnapshot = () => {
      const metrics = terminalDebugMetricsRef.current;
      setTerminalDebugSnapshot(
        [
          `transport pref: ${transportPreference}`,
          `live transport: ${transportRef.current ?? '-'}`,
          `renderer: ${
            renderAddonRef.current ? 'webgl' : terminalWebglEnabled ? 'default' : 'default (webgl off)'
          }`,
          `replay: ${terminalReplayEnabled ? 'on' : 'off'}`,
          `input mode: ${terminalInputStreamEnabled ? 'stream' : 'post'}`,
          `connected: ${connectedRef.current ? 'yes' : 'no'}`,
          `session: ${activeSessionIdRef.current ?? '-'}`,
          `reconnects: ${metrics.reconnects}`,
          `echo latency: ${formatMs(metrics.lastEchoMs)}`,
          `sse gap: ${formatMs(metrics.lastSseGapMs)} / max ${formatMs(metrics.maxSseGapMs)}`,
          `input events/chars: ${metrics.inputEvents}/${metrics.inputChars}`,
          `output msgs/chars: ${metrics.outputMessages}/${metrics.outputChars}`,
          `sse/ws msgs: ${metrics.sseMessages}/${metrics.wsMessages}`,
          `http stream/post chars: ${metrics.httpStreamChars}/${metrics.httpPostChars}`,
          `http stream retries: ${metrics.httpStreamRetries}`,
          `ws input chars: ${metrics.wsInputChars}`,
          `xterm pending: ${metrics.currentTerminalWritePendingChars} / max ${metrics.maxTerminalWritePendingChars}`,
          `xterm overflows: ${metrics.terminalWriteOverflows}`,
          `blank recoveries: ${metrics.blankRecoveries}`,
        ].join('\n'),
      );
    };

    updateDebugSnapshot();
    const timer = window.setInterval(updateDebugSnapshot, terminalDebugRefreshMs);
    return () => window.clearInterval(timer);
  }, [
    terminalDebugEnabled,
    terminalInputStreamEnabled,
    terminalReplayEnabled,
    terminalWebglEnabled,
    transportPreference,
  ]);

  const closeInputStream = useCallback(() => {
    const stream = inputStreamRef.current;
    inputStreamRef.current = null;
    if (!stream || stream.closed) {
      return;
    }
    stream.closed = true;
    try {
      stream.controller.close();
    } catch {
      // The browser may already have closed or errored the request body.
    }
  }, []);

  const clearHttpInputStreamRetry = useCallback(() => {
    if (inputStreamRetryTimerRef.current) {
      clearTimeout(inputStreamRetryTimerRef.current);
      inputStreamRetryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (terminalInputStreamEnabled) {
      return;
    }
    closeInputStream();
    clearHttpInputStreamRetry();
    inputStreamDisabledRef.current = false;
  }, [clearHttpInputStreamRetry, closeInputStream, terminalInputStreamEnabled]);

  const scheduleHttpInputStreamRetry = useCallback(() => {
    if (hasExitedRef.current || inputStreamRetryTimerRef.current) {
      return;
    }

    inputStreamDisabledRef.current = true;
    terminalDebugMetricsRef.current.httpStreamRetries += 1;
    const attempt = inputStreamRetryAttemptRef.current;
    inputStreamRetryAttemptRef.current = Math.min(attempt + 1, 4);
    const delay = Math.min(
      httpInputStreamRetryMaxMs,
      httpInputStreamRetryMinMs * 2 ** Math.min(attempt, 3),
    );

    inputStreamRetryTimerRef.current = setTimeout(() => {
      inputStreamRetryTimerRef.current = null;
      inputStreamDisabledRef.current = false;
    }, delay);
  }, []);

  const markOutputApplied = useCallback((seq?: number) => {
    if (
      typeof seq === 'number' &&
      Number.isSafeInteger(seq) &&
      seq > appliedOutputSeqRef.current
    ) {
      appliedOutputSeqRef.current = seq;
    }
  }, []);

  const hasPendingTerminalOutput = useCallback(
    () =>
      terminalWriteInFlightRef.current ||
      !!terminalWritePendingRef.current ||
      !!terminalOutputBufferRef.current ||
      !!terminalOutputFrameRef.current ||
      !!terminalOutputTimerRef.current,
    [],
  );

  const createInputChunk = useCallback((data: string): PendingInputChunk => {
    const chunk = {
      seq: nextInputSeqRef.current,
      data,
    };
    nextInputSeqRef.current += 1;
    pendingInputChunksRef.current.push(chunk);
    return chunk;
  }, []);

  const ackInputChunks = useCallback((seq?: number) => {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) {
      return;
    }
    pendingInputChunksRef.current = pendingInputChunksRef.current.filter(
      (chunk) => chunk.seq > seq,
    );
    queuedInputChunksRef.current = queuedInputChunksRef.current.filter(
      (chunk) => chunk.seq > seq,
    );
  }, []);

  const queueInputPostChunks = useCallback((chunks: PendingInputChunk[]) => {
    if (!chunks.length || hasExitedRef.current) {
      return;
    }
    const queuedSeqs = new Set(queuedInputChunksRef.current.map((chunk) => chunk.seq));
    for (const chunk of chunks) {
      if (!queuedSeqs.has(chunk.seq)) {
        queuedInputChunksRef.current.push(chunk);
        queuedSeqs.add(chunk.seq);
      }
    }
    if (!inputFlushTimerRef.current && !inputPostInFlightRef.current) {
      inputFlushTimerRef.current = setTimeout(
        () => flushQueuedInputRef.current(),
        httpInputFlushMs,
      );
    }
  }, []);

  const cancelQueuedTerminalOutput = useCallback(() => {
    if (terminalOutputFrameRef.current) {
      window.cancelAnimationFrame(terminalOutputFrameRef.current);
      terminalOutputFrameRef.current = 0;
    }
    if (terminalOutputTimerRef.current) {
      clearTimeout(terminalOutputTimerRef.current);
      terminalOutputTimerRef.current = null;
    }
  }, []);

  const resetTerminalWriteQueue = useCallback(() => {
    terminalWriteGenerationRef.current += 1;
    terminalWriteInFlightRef.current = false;
    terminalWritePendingRef.current = '';
    terminalWritePendingCallbacksRef.current = [];
    terminalDebugMetricsRef.current.currentTerminalWritePendingChars = 0;
  }, []);

  const writeTerminalOutput = useCallback((data: string, callback?: () => void) => {
    const terminal = terminalRef.current;
    const shouldMaskWriteData =
      terminalModeRef.current === 'codex' || terminalCwdPrivacyActiveRef.current;
    const outputData = shouldMaskWriteData
      ? maskTerminalPrivatePaths(data, terminalCwdRef.current)
      : data;
    const needsPrivacyRefresh = shouldMaskWriteData && outputData !== data;
    if (!terminal || !outputData) {
      callback?.();
      return;
    }

    if (terminalWriteInFlightRef.current) {
      terminalWritePendingRef.current += outputData;
      terminalDebugMetricsRef.current.currentTerminalWritePendingChars =
        terminalWritePendingRef.current.length;
      if (callback) {
        terminalWritePendingCallbacksRef.current.push(callback);
      }
      terminalDebugMetricsRef.current.maxTerminalWritePendingChars = Math.max(
        terminalDebugMetricsRef.current.maxTerminalWritePendingChars,
        terminalWritePendingRef.current.length,
      );
      if (terminalWritePendingRef.current.length > terminalWritePendingMaxChars) {
        terminalDebugMetricsRef.current.terminalWriteOverflows += 1;
        terminalWritePendingRef.current = '';
        terminalWritePendingCallbacksRef.current = [];
        terminalDebugMetricsRef.current.currentTerminalWritePendingChars = 0;
        resetBeforeReplayRef.current = true;
        requestReconnectRef.current();
      }
      return;
    }

    const generation = terminalWriteGenerationRef.current;
    terminalWriteInFlightRef.current = true;
    writeTerminalData(terminal, outputData, () => {
      if (terminalWriteGenerationRef.current !== generation) {
        callback?.();
        return;
      }
      terminalWriteInFlightRef.current = false;
      if (needsPrivacyRefresh) {
        scheduleTerminalPrivacyRefresh();
      }
      callback?.();
      const pending = terminalWritePendingRef.current;
      const pendingCallbacks = terminalWritePendingCallbacksRef.current;
      terminalWritePendingRef.current = '';
      terminalWritePendingCallbacksRef.current = [];
      terminalDebugMetricsRef.current.currentTerminalWritePendingChars = 0;
      if (pending) {
        window.setTimeout(() => {
          writeTerminalOutputRef.current(pending, () => {
            for (const pendingCallback of pendingCallbacks) {
              pendingCallback();
            }
          });
        }, 0);
      }
    });
  }, [scheduleTerminalPrivacyRefresh]);

  writeTerminalOutputRef.current = writeTerminalOutput;

  const flushQueuedTerminalOutput = useCallback((afterFlush?: () => void) => {
    cancelQueuedTerminalOutput();
    const data = terminalOutputBufferRef.current;
    const ackBytes = terminalOutputAckBytesRef.current;
    const outputSeq = terminalOutputSeqRef.current;
    const needsPrivacyRefresh = terminalOutputPrivacyRefreshRef.current;
    terminalOutputBufferRef.current = '';
    terminalOutputAckBytesRef.current = 0;
    terminalOutputSeqRef.current = 0;
    terminalOutputPrivacyRefreshRef.current = false;
    if (!data) {
      afterFlush?.();
      return;
    }
    writeTerminalOutputRef.current(data, () => {
      if (needsPrivacyRefresh) {
        scheduleTerminalPrivacyRefresh();
      }
      markOutputApplied(outputSeq);
      sendOutputAckRef.current(ackBytes || getTerminalOutputBytes(data));
      afterFlush?.();
    });
  }, [cancelQueuedTerminalOutput, markOutputApplied, scheduleTerminalPrivacyRefresh]);

  const scheduleQueuedTerminalOutput = useCallback(() => {
    if (terminalOutputFrameRef.current || terminalOutputTimerRef.current) {
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      return;
    }
    terminalOutputFrameRef.current = window.requestAnimationFrame(() => {
      terminalOutputFrameRef.current = 0;
      flushQueuedTerminalOutput();
    });
  }, [flushQueuedTerminalOutput]);

  const queueTerminalOutput = useCallback(
    (data: string, seq?: number) => {
      if (!data) {
        return;
      }
      const outputSeq = typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : 0;
      const isCodexRoute = terminalModeRef.current === 'codex';
      const cwd = terminalCwdRef.current;
      const statusTail = terminalCodexStatusTailRef.current;
      const statusPathPrefix = terminalCodexStatusPathPrefixRef.current;
      const codexStatusPaths = extractTerminalCodexStatusPrivatePathCandidates(data, cwd);
      const codexStatusPathFragment = extractTerminalCodexStatusTrailingPathFragment(data);
      const splitCodexStatusPaths = endsWithTerminalCodexStatusPathLead(statusTail)
        ? extractTerminalLeadingPrivatePathCandidates(data, cwd)
        : [];
      const splitCodexStatusPathFragments = endsWithTerminalCodexStatusPathLead(statusTail)
        ? extractTerminalLeadingPathFragmentCandidates(data, cwd)
        : [];
      const statusContinuationPaths = statusPathPrefix
        ? extractTerminalPathContinuationCandidates(data, cwd, statusPathPrefix)
        : [];
      const hasSplitCodexStatusPath =
        splitCodexStatusPaths.length > 0 || splitCodexStatusPathFragments.length > 0;
      const hasStatusContinuationPath = statusContinuationPaths.length > 0;
      const hasCodexStatusPath =
        codexStatusPaths.length > 0 ||
        !!codexStatusPathFragment ||
        hasSplitCodexStatusPath ||
        hasStatusContinuationPath;
      const shouldHideOutput =
        hasCodexStatusPath || isCodexRoute || terminalCwdPrivacyActiveRef.current;
      if (shouldHideOutput) {
        rememberTerminalOutputPaths(data, [
          ...codexStatusPaths,
          ...splitCodexStatusPaths,
          ...statusContinuationPaths,
        ]);
      }
      let maskedData = shouldHideOutput ? maskTerminalPrivatePaths(data, cwd) : data;
      if (shouldHideOutput && hasStatusContinuationPath) {
        maskedData = maskTerminalLeadingPathContinuation(maskedData);
      } else if (shouldHideOutput && splitCodexStatusPathFragments.length > 0) {
        maskedData = maskTerminalLeadingPathFragment(maskedData);
      } else if (shouldHideOutput && splitCodexStatusPaths.length > 0) {
        maskedData = maskTerminalLeadingPrivatePath(maskedData);
      } else if (shouldHideOutput && !isCodexRoute && !terminalCwdPrivacyActiveRef.current) {
        maskedData = maskTerminalCodexStatusPrivatePaths(maskedData);
      }
      const nextStatusTail = appendTerminalCodexStatusTail(statusTail, data);
      terminalCodexStatusTailRef.current = nextStatusTail;
      terminalCodexStatusPathPrefixRef.current =
        extractTerminalCodexStatusTrailingPathFragment(nextStatusTail);
      const needsPrivacyRefresh = shouldHideOutput && maskedData !== data;
      if (typeof document !== 'undefined' && document.hidden) {
        terminalOutputBufferRef.current += maskedData;
        terminalOutputAckBytesRef.current += getTerminalOutputBytes(data);
        terminalOutputSeqRef.current = Math.max(terminalOutputSeqRef.current, outputSeq);
        terminalOutputPrivacyRefreshRef.current =
          terminalOutputPrivacyRefreshRef.current || needsPrivacyRefresh;
        if (terminalOutputBufferRef.current.length > terminalHiddenBacklogMaxChars) {
          terminalOutputBufferRef.current = '';
          terminalOutputAckBytesRef.current = 0;
          terminalOutputSeqRef.current = 0;
          terminalOutputPrivacyRefreshRef.current = false;
          terminalCodexStatusTailRef.current = '';
          terminalCodexStatusPathPrefixRef.current = '';
          resetBeforeReplayRef.current = true;
          reconnectOnVisibleRef.current = true;
          pendingOutputAckBytesRef.current = 0;
          eventClientIdRef.current = null;
          connectedRef.current = false;
          if (transportRef.current === 'sse') {
            transportRef.current = null;
          }
          eventSourceRef.current?.close();
          eventSourceRef.current = null;
          closeInputStream();
        }
        scheduleQueuedTerminalOutput();
        return;
      }
      if (
        !terminalOutputBufferRef.current &&
        maskedData.length <= terminalLiveDirectWriteChars &&
        Date.now() - lastDirectTerminalWriteAtRef.current >= terminalLiveDirectWriteMinIntervalMs
      ) {
        const terminal = terminalRef.current;
        if (terminal) {
          lastDirectTerminalWriteAtRef.current = Date.now();
          writeTerminalOutputRef.current(maskedData, () => {
            if (needsPrivacyRefresh) {
              scheduleTerminalPrivacyRefresh();
            }
            markOutputApplied(outputSeq);
            sendOutputAckRef.current(getTerminalOutputBytes(data));
          });
          return;
        }
      }
      terminalOutputBufferRef.current += maskedData;
      terminalOutputAckBytesRef.current += getTerminalOutputBytes(data);
      terminalOutputSeqRef.current = Math.max(terminalOutputSeqRef.current, outputSeq);
      terminalOutputPrivacyRefreshRef.current =
        terminalOutputPrivacyRefreshRef.current || needsPrivacyRefresh;
      if (terminalOutputBufferRef.current.length >= terminalLiveWriteFlushChars) {
        scheduleQueuedTerminalOutput();
        return;
      }
      scheduleQueuedTerminalOutput();
    },
    [
      closeInputStream,
      flushQueuedTerminalOutput,
      markOutputApplied,
      rememberTerminalOutputPaths,
      scheduleQueuedTerminalOutput,
      scheduleTerminalPrivacyRefresh,
    ],
  );

  const clearQueuedTerminalOutput = useCallback(() => {
    cancelQueuedTerminalOutput();
    terminalOutputBufferRef.current = '';
    terminalOutputAckBytesRef.current = 0;
    terminalOutputSeqRef.current = 0;
    terminalOutputPrivacyRefreshRef.current = false;
  }, [cancelQueuedTerminalOutput]);

  const getTerminalSnapshotKey = useCallback(() => {
    const session = activeSessionIdRef.current;
    if (!session) {
      return null;
    }
    return `${terminalMode}:${session}`;
  }, [terminalMode]);

  const snapshotTerminalState = useCallback(() => {
    if (typeof document !== 'undefined' && !document.hidden) {
      return;
    }
    const terminal = terminalRef.current;
    const serializeAddon = serializeAddonRef.current;
    const key = getTerminalSnapshotKey();
    if (!terminal || !serializeAddon || !key) {
      return;
    }
    const now = Date.now();
    if (
      now - lastSnapshotAtRef.current < terminalSnapshotMinIntervalMs ||
      now < skipSnapshotsUntilRef.current
    ) {
      return;
    }
    lastSnapshotAtRef.current = now;

    try {
      const start = performance.now();
      let data = serializeAddon.serialize({ scrollback: terminalSnapshotScrollbackRows });
      if (data.length > terminalSnapshotMaxBytes) {
        data = serializeAddon.serialize({ scrollback: 0 });
      }
      data = maskTerminalRestoredPrivatePaths(
        data,
        terminalCwdRef.current,
        terminalModeRef.current === 'codex',
        terminalCwdPrivacyActiveRef.current,
      );
      if (!data) {
        return;
      }
      if (data.length > terminalSnapshotMaxBytes) {
        return;
      }
      terminalSnapshotRef.current = {
        key,
        data,
      };
      if (snapshotClearTimerRef.current) {
        clearTimeout(snapshotClearTimerRef.current);
      }
      snapshotClearTimerRef.current = setTimeout(() => {
        const snapshot = terminalSnapshotRef.current;
        if (snapshot?.key === key && snapshot.data === data) {
          terminalSnapshotRef.current = null;
        }
        snapshotClearTimerRef.current = null;
      }, terminalSnapshotTtlMs);
      if (performance.now() - start > terminalSnapshotSlowMs) {
        skipSnapshotsUntilRef.current = Date.now() + terminalSnapshotSlowBackoffMs;
      }
    } catch {
      // Snapshotting is a recovery aid; live PTY streaming remains authoritative.
    }
  }, [getTerminalSnapshotKey]);

  const cancelPendingSnapshot = useCallback(() => {
    pendingSnapshotCancelRef.current?.();
    pendingSnapshotCancelRef.current = null;
  }, []);

  const scheduleTerminalSnapshot = useCallback(() => {
    if (pendingSnapshotCancelRef.current) {
      return;
    }
    pendingSnapshotCancelRef.current = scheduleIdleTask(() => {
      pendingSnapshotCancelRef.current = null;
      snapshotTerminalState();
    }, 2000);
  }, [snapshotTerminalState]);

  const restoreTerminalSnapshotIfBlank = useCallback(() => {
    const terminal = terminalRef.current;
    const snapshot = terminalSnapshotRef.current;
    const key = getTerminalSnapshotKey();
    if (
      !terminal ||
      !snapshot ||
      !key ||
      snapshot.key !== key ||
      !isTerminalViewportBlank(terminal)
    ) {
      return false;
    }
    try {
      const viewportSnapshot = captureTerminalViewport(terminal);
      resetTerminalWriteQueue();
      terminalCodexStatusTailRef.current = '';
      terminalCodexStatusPathPrefixRef.current = '';
      terminal.reset();
      const maskedSnapshotData = maskTerminalRestoredPrivatePaths(
        snapshot.data,
        terminalCwdRef.current,
        terminalModeRef.current === 'codex',
        terminalCwdPrivacyActiveRef.current,
      );
      writeTerminalOutputRef.current(maskedSnapshotData, () => {
        if (maskedSnapshotData !== snapshot.data) {
          scheduleTerminalPrivacyRefresh();
        }
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        restoreTerminalViewport(terminal, viewportSnapshot);
      });
      return true;
    } catch {
      return false;
    }
  }, [getTerminalSnapshotKey, resetTerminalWriteQueue, scheduleTerminalPrivacyRefresh]);

  const recoverBlankTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    if (
      !terminal ||
      !activeSessionIdRef.current ||
      hasExitedRef.current ||
      !terminalReplayEnabledRef.current ||
      !isTerminalViewportBlank(terminal)
    ) {
      return false;
    }

    if (restoreTerminalSnapshotIfBlank()) {
      return false;
    }

    const now = Date.now();
    if (now - lastBlankRecoveryAtRef.current < terminalBlankRecoveryMinIntervalMs) {
      return false;
    }
    lastBlankRecoveryAtRef.current = now;
    terminalDebugMetricsRef.current.blankRecoveries += 1;
    resetBeforeReplayRef.current = true;
    reconnectOnVisibleRef.current = false;
    requestReconnectRef.current();
    return true;
  }, [restoreTerminalSnapshotIfBlank]);

  const setTerminalRendererMode = useCallback((terminal: Terminal, enableWebgl: boolean) => {
    const currentRenderAddon = renderAddonRef.current;
    if (currentRenderAddon) {
      renderAddonRef.current = null;
      try {
        currentRenderAddon.dispose();
      } catch {
        // Best-effort renderer recovery; xterm falls back to its default renderer.
      }
    }

    if (!enableWebgl) {
      renderAddonRef.current = null;
      return;
    }

    try {
      const renderAddon = new WebglAddon();
      renderAddon.onContextLoss(() => {
        if (renderAddonRef.current === renderAddon) {
          renderAddonRef.current = null;
        }
        renderAddon.dispose();
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      });
      terminal.loadAddon(renderAddon);
      renderAddonRef.current = renderAddon;
    } catch {
      renderAddonRef.current = null;
    }
  }, []);

  const resetTerminalRenderer = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const viewportSnapshot = captureTerminalViewport(terminal);
    setTerminalRendererMode(terminal, terminalWebglEnabled);
    refreshTerminalGlyphs(terminal);
    restoreTerminalViewport(terminal, viewportSnapshot);
  }, [setTerminalRendererMode, terminalWebglEnabled]);

  const startHttpInputStream = useCallback(() => {
    const session = activeSessionIdRef.current;
    if (
      !session ||
      !token ||
      hasExitedRef.current ||
      !terminalInputStreamEnabledRef.current ||
      inputStreamRef.current ||
      inputStreamDisabledRef.current ||
      typeof ReadableStream === 'undefined' ||
      typeof TextEncoder === 'undefined'
    ) {
      return;
    }

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    if (!controller) {
      scheduleHttpInputStreamRetry();
      return;
    }

    const inputStream: HttpInputStream = {
      controller,
      encoder: new TextEncoder(),
      closed: false,
    };
    const inputClientId = inputClientIdRef.current;
    inputStreamRef.current = inputStream;

    const requestInit: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-ndjson',
        'X-Codex-Input-Protocol': 'jsonl-v1',
        'X-Codex-Input-Client': inputClientId,
      },
      body,
      duplex: 'half',
      keepalive: false,
    };

    let inputRequest: Promise<Response>;
    try {
      inputRequest = fetch(
        `${apiBaseUrl()}/api/codex-cli/sessions/${encodeURIComponent(session)}/input-stream`,
        requestInit,
      );
    } catch {
      inputStream.closed = true;
      if (inputStreamRef.current === inputStream) {
        inputStreamRef.current = null;
      }
      if (activeSessionIdRef.current === session && inputClientIdRef.current === inputClientId) {
        queueInputPostChunks(pendingInputChunksRef.current);
        scheduleHttpInputStreamRetry();
      }
      return;
    }

    const openedAt = Date.now();
    void inputRequest
      .then(async (response) => {
        const isCurrentInputStream =
          activeSessionIdRef.current === session && inputClientIdRef.current === inputClientId;
        if (!response.ok) {
          if (isCurrentInputStream) {
            queueInputPostChunks(pendingInputChunksRef.current);
            scheduleHttpInputStreamRetry();
          }
          return;
        }
        try {
          const result = (await response.json()) as { inputAckSeq?: unknown };
          if (isCurrentInputStream) {
            ackInputChunks(Number(result?.inputAckSeq));
          }
        } catch {
          // 204 responses from the legacy raw endpoint have no body.
        }
      })
      .catch(() => {
        if (activeSessionIdRef.current === session && inputClientIdRef.current === inputClientId) {
          queueInputPostChunks(pendingInputChunksRef.current);
          scheduleHttpInputStreamRetry();
        }
      })
      .finally(() => {
        if (inputStreamRef.current === inputStream) {
          inputStream.closed = true;
          inputStreamRef.current = null;
        }
        if (Date.now() - openedAt >= 5000) {
          inputStreamRetryAttemptRef.current = 0;
        }
      });
  }, [ackInputChunks, queueInputPostChunks, scheduleHttpInputStreamRetry, token]);

  const isTransportUsable = useCallback(() => {
    if (transportRef.current === 'websocket') {
      const socket = socketRef.current;
      return connectedRef.current && !!socket && socket.readyState === WebSocket.OPEN;
    }
    if (transportRef.current === 'sse') {
      const eventSource = eventSourceRef.current;
      return connectedRef.current && !!eventSource && eventSource.readyState === 1;
    }
    return false;
  }, []);

  const writeReconnectNotice = useCallback((message: string) => {
    const now = Date.now();
    if (now - lastReconnectNoticeAtRef.current < reconnectNoticeMinIntervalMs) {
      return;
    }
    lastReconnectNoticeAtRef.current = now;
    writeTerminalOutputRef.current(message);
  }, []);

  const requestReconnect = useCallback(() => {
    if (hasExitedRef.current || reconnectTimerRef.current) {
      return;
    }
    const attempt = reconnectAttemptRef.current;
    reconnectAttemptRef.current = Math.min(attempt + 1, 8);
    terminalDebugMetricsRef.current.reconnects += 1;
    terminalDebugMetricsRef.current.lastReconnectAt = performance.now();
    const delay = Math.min(reconnectMaxDelayMs, reconnectMinDelayMs * 2 ** Math.min(attempt, 5));
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      setReconnectNonce((value) => value + 1);
    }, delay);
  }, []);
  requestReconnectRef.current = requestReconnect;

  const queueReconnectInput = useCallback((data: string) => {
    if (!data) {
      return;
    }
    pendingReconnectInputRef.current += data;
    if (pendingReconnectInputRef.current.length > pendingReconnectInputLimit) {
      pendingReconnectInputRef.current = pendingReconnectInputRef.current.slice(
        -pendingReconnectInputLimit,
      );
    }
  }, []);

  const markInputTransportStale = useCallback(() => {
    if (inputFlushTimerRef.current) {
      clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }
    queueInputPostChunks(pendingInputChunksRef.current);

    closeInputStream();
    clearHttpInputStreamRetry();
    inputStreamDisabledRef.current = false;
    inputStreamRetryAttemptRef.current = 0;
    eventClientIdRef.current = null;
    if (outputAckTimerRef.current) {
      clearTimeout(outputAckTimerRef.current);
      outputAckTimerRef.current = null;
    }
    pendingOutputAckBytesRef.current = 0;

    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore close races while replacing stale transport state.
      }
    }

    const eventSource = eventSourceRef.current;
    eventSourceRef.current = null;
    if (eventSource) {
      eventSource.close();
    }

    transportRef.current = null;
    connectedRef.current = false;
    reconnectOnVisibleRef.current = false;
    resetBeforeReplayRef.current = true;
    requestReconnect();
  }, [
    clearHttpInputStreamRetry,
    closeInputStream,
    queueInputPostChunks,
    requestReconnect,
  ]);

  const postTerminalJson = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      if (!token) {
        throw new Error('missing_auth_token');
      }
      const response = await fetch(`${apiBaseUrl()}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        keepalive: false,
      });
      if (!response.ok) {
        throw new Error(`terminal_request_failed_${response.status}`);
      }
      const text = await response.text();
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    [token],
  );

  const flushOutputAck = useCallback(() => {
    outputAckTimerRef.current = null;
    const bytes = pendingOutputAckBytesRef.current;
    pendingOutputAckBytesRef.current = 0;
    const session = activeSessionIdRef.current;
    const clientId = eventClientIdRef.current;
    if (!bytes || !session || !clientId || hasExitedRef.current) {
      return;
    }
    postTerminalJson(`/api/codex-cli/sessions/${encodeURIComponent(session)}/ack`, {
      clientId,
      bytes,
    }).catch(() => {
      terminalDebugMetricsRef.current.sseErrors += 1;
      if (transportRef.current !== 'sse') {
        return;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      eventClientIdRef.current = null;
      transportRef.current = null;
      connectedRef.current = false;
      pendingOutputAckBytesRef.current = 0;
      closeInputStream();
      resetBeforeReplayRef.current = resetBeforeReplayRef.current || hasPendingTerminalOutput();
      if (typeof document !== 'undefined' && document.hidden) {
        reconnectOnVisibleRef.current = true;
        return;
      }
      requestReconnect();
    });
  }, [closeInputStream, hasPendingTerminalOutput, postTerminalJson, requestReconnect]);

  const queueOutputAck = useCallback(
    (bytes: number) => {
      if (!Number.isFinite(bytes) || bytes <= 0 || transportRef.current !== 'sse') {
        return;
      }
      pendingOutputAckBytesRef.current += bytes;
      if (pendingOutputAckBytesRef.current >= httpOutputAckFlushBytes) {
        if (outputAckTimerRef.current) {
          clearTimeout(outputAckTimerRef.current);
          outputAckTimerRef.current = null;
        }
        flushOutputAck();
        return;
      }
      if (!outputAckTimerRef.current) {
        outputAckTimerRef.current = setTimeout(flushOutputAck, httpOutputAckFlushMs);
      }
    },
    [flushOutputAck],
  );
  sendOutputAckRef.current = queueOutputAck;

  const flushQueuedInput = useCallback(() => {
    inputFlushTimerRef.current = null;
    const session = activeSessionIdRef.current;
    if (inputPostInFlightRef.current) {
      return;
    }
    if (!session || hasExitedRef.current) {
      return;
    }
    const chunks: PendingInputChunk[] = [];
    let bytes = 0;
    while (queuedInputChunksRef.current.length > 0) {
      const nextChunk = queuedInputChunksRef.current[0];
      const nextBytes = getTerminalOutputBytes(nextChunk.data);
      if (chunks.length > 0 && bytes + nextBytes > httpInputPostMaxBytes) {
        break;
      }
      queuedInputChunksRef.current.shift();
      chunks.push(nextChunk);
      bytes += nextBytes;
    }
    if (!chunks.length) {
      return;
    }

    const inputClientId = inputClientIdRef.current;
    inputPostInFlightRef.current = true;
    terminalDebugMetricsRef.current.httpPostChars += chunks.reduce(
      (total, chunk) => total + chunk.data.length,
      0,
    );
    postTerminalJson(`/api/codex-cli/sessions/${encodeURIComponent(session)}/input`, {
      inputClientId,
      chunks,
    })
      .then((result) => {
        if (activeSessionIdRef.current !== session || inputClientIdRef.current !== inputClientId) {
          return;
        }
        const inputAckSeq =
          result && typeof result === 'object' ? Number((result as { inputAckSeq?: unknown }).inputAckSeq) : 0;
        ackInputChunks(inputAckSeq);
      })
      .catch(() => {
        if (activeSessionIdRef.current !== session || inputClientIdRef.current !== inputClientId) {
          return;
        }
        queuedInputChunksRef.current = [
          ...chunks.filter((chunk) =>
            pendingInputChunksRef.current.some((pending) => pending.seq === chunk.seq),
          ),
          ...queuedInputChunksRef.current,
        ];
        markInputTransportStale();
      })
      .finally(() => {
        if (activeSessionIdRef.current !== session || inputClientIdRef.current !== inputClientId) {
          return;
        }
        inputPostInFlightRef.current = false;
        if (queuedInputChunksRef.current.length > 0 && !inputFlushTimerRef.current) {
          inputFlushTimerRef.current = setTimeout(
            () => flushQueuedInputRef.current(),
            httpInputFlushMs,
          );
        }
      });
  }, [ackInputChunks, markInputTransportStale, postTerminalJson]);
  flushQueuedInputRef.current = flushQueuedInput;

  const queueHttpInput = useCallback(
    (data: string) => {
      const chunk = createInputChunk(data);
      if (
        terminalInputStreamEnabledRef.current &&
        !inputStreamRef.current &&
        !inputStreamDisabledRef.current
      ) {
        startHttpInputStream();
      }

      const inputStream = inputStreamRef.current;
      if (terminalInputStreamEnabledRef.current && inputStream && !inputStream.closed) {
        try {
          inputStream.controller.enqueue(inputStream.encoder.encode(encodeInputChunk(chunk)));
          terminalDebugMetricsRef.current.httpStreamChars += data.length;
          return;
        } catch {
          inputStream.closed = true;
          inputStreamRef.current = null;
          scheduleHttpInputStreamRetry();
          queueInputPostChunks(pendingInputChunksRef.current);
        }
      }

      queueInputPostChunks([chunk]);
    },
    [
      createInputChunk,
      queueInputPostChunks,
      scheduleHttpInputStreamRetry,
      startHttpInputStream,
    ],
  );

  const flushPendingReconnectInput = useCallback(() => {
    const data = pendingReconnectInputRef.current;
    const session = activeSessionIdRef.current;
    if (!data || !session || hasExitedRef.current || !connectedRef.current) {
      return;
    }

    const socket = socketRef.current;
    if (transportRef.current === 'websocket' && socket?.readyState === WebSocket.OPEN) {
      pendingReconnectInputRef.current = '';
      try {
        socket.send(JSON.stringify({ type: 'input', data }));
      } catch {
        queueReconnectInput(data);
        markInputTransportStale();
      }
      return;
    }

    if (transportRef.current === 'sse') {
      pendingReconnectInputRef.current = '';
      queueHttpInput(data);
    }
  }, [markInputTransportStale, queueHttpInput, queueReconnectInput]);

  const sendHttpResize = useCallback((cols: number, rows: number) => {
    const session = activeSessionIdRef.current;
    if (!session || hasExitedRef.current) {
      return;
    }
    postTerminalJson(`/api/codex-cli/sessions/${encodeURIComponent(session)}/resize`, {
      cols,
      rows,
    }).catch(() => undefined);
  }, [postTerminalJson]);

  const closeTransports = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    eventClientIdRef.current = null;
    closeInputStream();
    clearHttpInputStreamRetry();
    transportRef.current = null;
    connectedRef.current = false;
    reconnectOnVisibleRef.current = false;
    inputStreamDisabledRef.current = false;
    inputStreamRetryAttemptRef.current = 0;
    if (inputFlushTimerRef.current) {
      clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pendingInputFlushTimerRef.current) {
      clearTimeout(pendingInputFlushTimerRef.current);
      pendingInputFlushTimerRef.current = null;
    }
    if (outputAckTimerRef.current) {
      clearTimeout(outputAckTimerRef.current);
      outputAckTimerRef.current = null;
    }
    pendingOutputAckBytesRef.current = 0;
    clearQueuedTerminalOutput();
    resetTerminalWriteQueue();
  }, [clearHttpInputStreamRetry, clearQueuedTerminalOutput, closeInputStream, resetTerminalWriteQueue]);

  useEffect(() => {
    if (activeSessionId) {
      pendingSessionCreateRef.current = null;
      return;
    }
    if (!isAuthenticated || !token || pendingSessionCreateRef.current === terminalMode) {
      return;
    }

    let cancelled = false;
    pendingSessionCreateRef.current = terminalMode;
    reconnectCounter.current += 1;
    closeTransports();
    hasExitedRef.current = false;
    terminalCodexStatusTailRef.current = '';
    terminalCodexStatusPathPrefixRef.current = '';
    setExitInfo(null);

    const createSession = async () => {
      try {
        const session = (await request.post(
          `${apiBaseUrl()}/api/codex-cli/sessions`,
          { mode: terminalMode },
        )) as TerminalSessionResponse;
        if (cancelled) {
          return;
        }
        if (session.mode === 'codex') {
          enableTerminalCwdPrivacy();
        }
        rememberTerminalCwd(session.cwd);
        navigate(`/${routePrefix}/${session.sessionId}`, { replace: true });
      } catch {
        if (!cancelled) {
          pendingSessionCreateRef.current = null;
          writeTerminalOutputRef.current('\r\n[web terminal] failed to create terminal session\r\n');
        }
      }
    };

    void createSession();

    return () => {
      cancelled = true;
    };
  }, [
    activeSessionId,
    closeTransports,
    enableTerminalCwdPrivacy,
    isAuthenticated,
    navigate,
    routePrefix,
    rememberTerminalCwd,
    terminalMode,
    token,
  ]);

  useEffect(() => {
    if (!activeSessionId) {
      lastSessionIdRef.current = null;
    }
  }, [activeSessionId]);

  useEffect(() => {
    const terminalKey = activeSessionId ? `${terminalMode}:${activeSessionId}` : null;
    if (!activeSessionId || lastSessionIdRef.current === terminalKey) {
      return;
    }
    reconnectCounter.current += 1;
    reconnectAttemptRef.current = 0;
    closeTransports();
    lastSessionIdRef.current = terminalKey;
    appliedOutputSeqRef.current = 0;
    terminalOutputSeqRef.current = 0;
    terminalCodexStatusTailRef.current = '';
    terminalCodexStatusPathPrefixRef.current = '';
    inputClientIdRef.current = createInputClientId();
    nextInputSeqRef.current = 1;
    pendingInputChunksRef.current = [];
    queuedInputChunksRef.current = [];
    inputPostInFlightRef.current = false;
    pendingReconnectInputRef.current = '';
    hasExitedRef.current = false;
    terminalCwdRef.current = '';
    terminalCwdFromOutputRef.current = false;
    setTerminalCwd('');
    setCwdReveal(false);
    setExitInfo(null);
    terminalRef.current?.reset();
  }, [activeSessionId, closeTransports, terminalMode]);

  const fitAndNotify = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!fitAddon || !terminal) {
      return;
    }
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    const socket = socketRef.current;
    if (transportRef.current === 'websocket' && socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'resize',
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
      return;
    }
    if (transportRef.current === 'sse') {
      sendHttpResize(terminal.cols, terminal.rows);
    }
  }, [sendHttpResize]);

  const connect = useCallback(async () => {
    if (!activeSessionId || !isAuthenticated || !token || !terminalRef.current) {
      return;
    }

    const terminal = terminalRef.current;
    reconnectCounter.current += 1;
    const connectionId = reconnectCounter.current;
    const shouldResetBeforeReplay = resetBeforeReplayRef.current;
    const resumeAfterSeq =
      !shouldResetBeforeReplay && !hasPendingTerminalOutput() ? appliedOutputSeqRef.current : 0;
    hasExitedRef.current = false;
    setExitInfo(null);

    closeTransports();
    resetBeforeReplayRef.current = shouldResetBeforeReplay;

    const handleTerminalMessage = (
      message: TerminalServerMessage,
      closeCurrentTransport: () => void,
    ) => {
      if (connectionId !== reconnectCounter.current) {
        return;
      }
      if (message.mode === 'codex') {
        enableTerminalCwdPrivacy();
      }
      rememberTerminalCwd(message.cwd);

      if (message.type === 'replay') {
        const replayData = message.data ?? '';
        const viewportSnapshot = captureTerminalViewport(terminal);
        if (pendingInputFlushTimerRef.current) {
          clearTimeout(pendingInputFlushTimerRef.current);
          pendingInputFlushTimerRef.current = null;
        }
        flushPendingReconnectInput();
        clearQueuedTerminalOutput();
        resetTerminalWriteQueue();
        terminalCodexStatusTailRef.current = '';
        terminalCodexStatusPathPrefixRef.current = '';
        terminal.reset();
        resetBeforeReplayRef.current = false;
        if (!terminalReplayEnabledRef.current) {
          markOutputApplied(message.seq);
          sendOutputAckRef.current(getTerminalOutputBytes(replayData));
          writeTerminalOutputRef.current('[terminal replay skipped]\r\n', () => {
            fitAndNotify();
            terminal.refresh(0, Math.max(0, terminal.rows - 1));
            terminalSnapshotRef.current = null;
            if (snapshotClearTimerRef.current) {
              clearTimeout(snapshotClearTimerRef.current);
              snapshotClearTimerRef.current = null;
            }
          });
          return;
        }
        const isCodexRoute = terminalModeRef.current === 'codex';
        const cwd = terminalCwdRef.current;
        const replayHasCodexStatusPath = hasTerminalCodexStatusPrivatePath(replayData, cwd);
        const shouldHideReplay =
          replayHasCodexStatusPath || isCodexRoute || terminalCwdPrivacyActiveRef.current;
        if (shouldHideReplay) {
          rememberTerminalOutputPaths(replayData);
        }
        const maskedReplayData = maskTerminalRestoredPrivatePaths(
          replayData,
          cwd,
          isCodexRoute,
          terminalCwdPrivacyActiveRef.current,
        );
        const replayNeedsPrivacyRefresh = shouldHideReplay && maskedReplayData !== replayData;
        writeTerminalOutputRef.current(maskedReplayData, () => {
          if (replayNeedsPrivacyRefresh) {
            scheduleTerminalPrivacyRefresh();
          }
          markOutputApplied(message.seq);
          sendOutputAckRef.current(getTerminalOutputBytes(replayData));
          fitAndNotify();
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
          restoreTerminalViewport(terminal, viewportSnapshot);
          terminalSnapshotRef.current = null;
          if (snapshotClearTimerRef.current) {
            clearTimeout(snapshotClearTimerRef.current);
            snapshotClearTimerRef.current = null;
          }
        });
        return;
      }
      if (message.type === 'data') {
        const now = performance.now();
        const data = message.data ?? '';
        const metrics = terminalDebugMetricsRef.current;
        metrics.outputMessages += 1;
        metrics.outputChars += data.length;
        if (metrics.lastInputAt && now - metrics.lastInputAt < 5000) {
          metrics.lastEchoMs = now - metrics.lastInputAt;
          metrics.lastInputAt = 0;
        }
        if (resetBeforeReplayRef.current) {
          const viewportSnapshot = captureTerminalViewport(terminal);
          clearQueuedTerminalOutput();
          resetTerminalWriteQueue();
          terminalCodexStatusTailRef.current = '';
          terminalCodexStatusPathPrefixRef.current = '';
          terminal.reset();
          resetBeforeReplayRef.current = false;
          restoreTerminalViewport(terminal, viewportSnapshot);
        }
        queueTerminalOutput(data, message.seq);
        return;
      }
      if (message.type === 'inputAck') {
        if (message.inputClientId === inputClientIdRef.current) {
          ackInputChunks(message.inputSeq);
        }
        return;
      }
      if (message.type === 'ready') {
        const gotDifferentSession = !!message.sessionId && message.sessionId !== activeSessionId;
        const gotDifferentMode = !!message.mode && message.mode !== terminalMode;
        if (gotDifferentSession || gotDifferentMode) {
          hasExitedRef.current = true;
          connectedRef.current = false;
          writeTerminalOutputRef.current(
            [
              '\r\n[web terminal] session identity mismatch; connection closed',
              `expected ${terminalMode}:${activeSessionId}`,
              `got ${message.mode ?? 'unknown'}:${message.sessionId ?? 'unknown'}`,
              message.serverPid ? `server pid ${message.serverPid}` : null,
              '\r\n',
            ]
              .filter(Boolean)
              .join(' · '),
          );
          closeCurrentTransport();
          return;
        }
        connectedRef.current = true;
        if (message.clientId && transportRef.current === 'sse') {
          eventClientIdRef.current = message.clientId;
        }
        reconnectAttemptRef.current = 0;
        reconnectOnVisibleRef.current = false;
        if (pendingReconnectInputRef.current) {
          if (pendingInputFlushTimerRef.current) {
            clearTimeout(pendingInputFlushTimerRef.current);
          }
          pendingInputFlushTimerRef.current = setTimeout(() => {
            pendingInputFlushTimerRef.current = null;
            flushPendingReconnectInput();
          }, pendingReconnectInputFlushMs);
        }
        return;
      }
      if (message.type === 'exit') {
        hasExitedRef.current = true;
        connectedRef.current = false;
        setExitInfo({
          exitCode: message.exitCode,
          signal: message.signal,
        });
        flushQueuedTerminalOutput(() => {
          writeTerminalOutputRef.current('\r\n[terminal exited]\r\n');
        });
        closeCurrentTransport();
      }
    };

    const requestTicket = async () =>
      (await request.post(`${apiBaseUrl()}/api/codex-cli/ticket`, {
        sessionId: activeSessionId,
        mode: terminalMode,
      })) as TicketResponse;

    const connectWithEventSource = async () => {
      let sseTicketResponse: TicketResponse;
      try {
        sseTicketResponse = await requestTicket();
      } catch {
        if (connectionId === reconnectCounter.current && !hasExitedRef.current) {
          writeReconnectNotice('\r\n[web terminal] reconnecting...\r\n');
          requestReconnect();
        }
        return;
      }

      if (connectionId !== reconnectCounter.current) {
        return;
      }

      const url = buildEventSourceUrl({
        ticket: sseTicketResponse.ticket,
        sessionId: activeSessionId,
        mode: terminalMode,
        afterSeq: terminalReplayEnabledRef.current ? resumeAfterSeq : 0,
        replay: terminalReplayEnabledRef.current ? undefined : 'none',
      });
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;
      transportRef.current = 'sse';
      connectedRef.current = false;
      let sseSawReady = false;

      eventSource.addEventListener('open', () => {
        if (connectionId !== reconnectCounter.current) {
          eventSource.close();
          return;
        }
        startHttpInputStream();
        fitAndNotify();
        terminal.focus();
      });

      eventSource.addEventListener('message', (event) => {
        const now = performance.now();
        const metrics = terminalDebugMetricsRef.current;
        metrics.sseMessages += 1;
        if (metrics.lastSseMessageAt) {
          metrics.lastSseGapMs = now - metrics.lastSseMessageAt;
          metrics.maxSseGapMs = Math.max(metrics.maxSseGapMs, metrics.lastSseGapMs);
        }
        metrics.lastSseMessageAt = now;
        let message: TerminalServerMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (eventSourceRef.current !== eventSource) {
          return;
        }
        if (message.type === 'ready') {
          sseSawReady = true;
        }
        handleTerminalMessage(message, () => {
          eventSource.close();
          closeInputStream();
        });
      });

      eventSource.addEventListener('error', () => {
        terminalDebugMetricsRef.current.sseErrors += 1;
        if (
          connectionId === reconnectCounter.current &&
          eventSourceRef.current === eventSource &&
          terminalRef.current &&
          !hasExitedRef.current
        ) {
          writeReconnectNotice('\r\n[web terminal disconnected, reconnecting]\r\n');
        }
        if (connectionId === reconnectCounter.current && eventSourceRef.current === eventSource) {
          eventSourceRef.current = null;
          transportRef.current = null;
          connectedRef.current = false;
          if (!hasExitedRef.current) {
            resetBeforeReplayRef.current =
              resetBeforeReplayRef.current || (sseSawReady && hasPendingTerminalOutput());
            if (typeof document !== 'undefined' && document.hidden) {
              reconnectOnVisibleRef.current = true;
            } else {
              requestReconnect();
            }
          }
        }
        eventSource.close();
        closeInputStream();
      });
    };

    if (shouldStartTerminalWithHttpFallback(transportPreference)) {
      void connectWithEventSource();
      return;
    }

    let ticketResponse: TicketResponse;
    try {
      ticketResponse = await requestTicket();
    } catch {
      if (connectionId === reconnectCounter.current && !hasExitedRef.current) {
        writeReconnectNotice('\r\n[web terminal] reconnecting...\r\n');
        requestReconnect();
      }
      return;
    }

    if (connectionId !== reconnectCounter.current) {
      return;
    }

    fitAndNotify();
    const url = buildWebSocketUrl({
      ticket: ticketResponse.ticket,
      sessionId: activeSessionId,
      mode: terminalMode,
      cols: terminal.cols,
      rows: terminal.rows,
    });
    const socket = new WebSocket(url);
    socketRef.current = socket;
    transportRef.current = 'websocket';
    connectedRef.current = false;
    let sawReady = false;
    let fallbackStarted = false;
    let websocketReadyAt = 0;
    let fallbackTimer: number | null = null;
    const clearFallbackTimer = () => {
      if (fallbackTimer) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };
    const startFallback = () => {
      if (fallbackStarted || sawReady || hasExitedRef.current || connectionId !== reconnectCounter.current) {
        return;
      }
      clearFallbackTimer();
      fallbackStarted = true;
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      transportRef.current = null;
      try {
        socket.close();
      } catch {
        // Ignore close races.
      }
      rememberHttpTerminalFallback();
      void connectWithEventSource();
    };
    fallbackTimer = window.setTimeout(() => {
      if (!sawReady) {
        startFallback();
      }
    }, websocketFallbackMs);

    socket.addEventListener('open', () => {
      if (connectionId !== reconnectCounter.current) {
        clearFallbackTimer();
        socket.close();
        return;
      }
      fitAndNotify();
      terminal.focus();
    });

    socket.addEventListener('message', (event) => {
      terminalDebugMetricsRef.current.wsMessages += 1;
      let message: {
        type?: string;
        data?: string;
        pid?: number;
        cwd?: string;
        sessionId?: string;
        mode?: TerminalMode;
        serverPid?: number;
        serverInstanceId?: string;
        exitCode?: number;
        signal?: number;
      };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (connectionId !== reconnectCounter.current || socketRef.current !== socket) {
        return;
      }

      if (message.type === 'ready') {
        sawReady = true;
        websocketReadyAt = Date.now();
        reconnectAttemptRef.current = 0;
        clearFallbackTimer();
        clearHttpTerminalFallback();
      }
      handleTerminalMessage(message, () => socket.close());
    });

    socket.addEventListener('close', () => {
      clearFallbackTimer();
      if (!sawReady) {
        startFallback();
        return;
      }
      const closedCurrentSocket = connectionId === reconnectCounter.current && socketRef.current === socket;
      if (closedCurrentSocket) {
        socketRef.current = null;
        transportRef.current = null;
        connectedRef.current = false;
        if (!hasExitedRef.current) {
          if (websocketReadyAt && Date.now() - websocketReadyAt < websocketUnstableCloseMs) {
            rememberHttpTerminalFallback();
          }
          resetBeforeReplayRef.current = true;
          if (typeof document !== 'undefined' && document.hidden) {
            reconnectOnVisibleRef.current = true;
          } else {
            requestReconnect();
          }
        }
      }
      if (
        closedCurrentSocket &&
        terminalRef.current &&
        !hasExitedRef.current
      ) {
        writeReconnectNotice('\r\n[web terminal disconnected, reconnecting]\r\n');
      }
    });

    socket.addEventListener('error', () => {
      startFallback();
    });
  }, [
    ackInputChunks,
    activeSessionId,
    clearQueuedTerminalOutput,
    closeInputStream,
    closeTransports,
    fitAndNotify,
    flushPendingReconnectInput,
    flushQueuedTerminalOutput,
    hasPendingTerminalOutput,
    isAuthenticated,
    markOutputApplied,
    queueTerminalOutput,
    enableTerminalCwdPrivacy,
    rememberTerminalCwd,
    rememberTerminalOutputPaths,
    requestReconnect,
    resetTerminalWriteQueue,
    scheduleTerminalPrivacyRefresh,
    startHttpInputStream,
    terminalMode,
    token,
    transportPreference,
    writeReconnectNotice,
  ]);

  const openFreshTerminal = useCallback(() => {
    navigate(createTerminalSessionPath(terminalMode, transportPreference));
  }, [navigate, terminalMode, transportPreference]);

  useEffect(() => {
    if (!shouldHideTerminalCwd) {
      setCwdReveal(false);
      return;
    }
    const revealCwd = (event: KeyboardEvent) => {
      if (event.key !== terminalCwdRevealKey || !terminalCwdRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setCwdReveal(true);
    };
    const concealCwd = (event?: KeyboardEvent) => {
      if (event && event.key !== terminalCwdRevealKey) {
        return;
      }
      event?.preventDefault();
      event?.stopPropagation();
      setCwdReveal(false);
    };
    const concealCwdOnBlur = () => setCwdReveal(false);

    window.addEventListener('keydown', revealCwd, true);
    window.addEventListener('keyup', concealCwd, true);
    window.addEventListener('blur', concealCwdOnBlur);
    return () => {
      window.removeEventListener('keydown', revealCwd, true);
      window.removeEventListener('keyup', concealCwd, true);
      window.removeEventListener('blur', concealCwdOnBlur);
    };
  }, [shouldHideTerminalCwd]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: terminalFont,
      fontSize: terminalFontSize,
      fontWeight: 400,
      fontWeightBold: 700,
      lineHeight: 1.18,
      minimumContrastRatio: 4.5,
      scrollback: terminalScrollbackRows,
      theme: atomOneLightTheme,
    });
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);
    terminal.open(container);
    setTerminalRendererMode(terminal, terminalWebglEnabledRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;
    fitAndNotify();
    terminal.focus();

    let disposed = false;
    const writeInput = (data: string) => {
      if (hasExitedRef.current) {
        return;
      }
      const socket = socketRef.current;
      if (transportRef.current === 'websocket' && socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'input', data }));
          terminalDebugMetricsRef.current.wsInputChars += data.length;
        } catch {
          queueReconnectInput(data);
          markInputTransportStale();
        }
        return;
      }
      if (transportRef.current === 'sse') {
        queueHttpInput(data);
        return;
      }
      if (activeSessionIdRef.current) {
        queueReconnectInput(data);
        resetBeforeReplayRef.current = true;
        requestReconnect();
      }
    };

    const disposeClipboardHandlers = installClipboardHandlers(terminal, container, writeInput);
    const disposeFileLineSelectionHandler = installFileLineSelectionHandler(terminal, container);
    void loadTerminalFonts(terminalFontSize).then(() => {
      if (disposed) {
        return;
      }
      fitAndNotify();
      refreshTerminalGlyphs(terminal);
    });

    const dataDisposable = terminal.onData((data) => {
      if (hasExitedRef.current) {
        return;
      }
      const metrics = terminalDebugMetricsRef.current;
      metrics.inputEvents += 1;
      metrics.inputChars += data.length;
      metrics.lastInputAt = performance.now();
      if (data === '\x03') {
        suppressTerminalResponsesUntilRef.current = Date.now() + terminalResponseSuppressMs;
      } else if (
        Date.now() < suppressTerminalResponsesUntilRef.current &&
        isTerminalQueryResponse(data)
      ) {
        return;
      }
      writeInput(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAndNotify();
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      reconnectCounter.current += 1;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      disposeClipboardHandlers();
      disposeFileLineSelectionHandler();
      clearQueuedTerminalOutput();
      resetTerminalWriteQueue();
      closeTransports();
      cancelPendingSnapshot();
      if (snapshotClearTimerRef.current) {
        clearTimeout(snapshotClearTimerRef.current);
        snapshotClearTimerRef.current = null;
      }
      if (terminalPrivacyRefreshFrameRef.current) {
        window.cancelAnimationFrame(terminalPrivacyRefreshFrameRef.current);
        terminalPrivacyRefreshFrameRef.current = 0;
      }
      terminalSnapshotRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
      renderAddonRef.current = null;
    };
  }, [
    cancelPendingSnapshot,
    clearQueuedTerminalOutput,
    closeTransports,
    fitAndNotify,
    markInputTransportStale,
    queueHttpInput,
    queueReconnectInput,
    queueTerminalOutput,
    requestReconnect,
    resetTerminalWriteQueue,
    setTerminalRendererMode,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (terminalWebglEnabled === !!renderAddonRef.current) {
      return;
    }

    const viewportSnapshot = captureTerminalViewport(terminal);
    setTerminalRendererMode(terminal, terminalWebglEnabled);
    refreshTerminalGlyphs(terminal);
    restoreTerminalViewport(terminal, viewportSnapshot);
  }, [setTerminalRendererMode, terminalWebglEnabled]);

  useEffect(() => {
    connect();
  }, [connect, reconnectNonce]);

  useEffect(() => {
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    let restoreFrame = 0;
    let restoreInnerFrame = 0;
    let lastRestoreAt = 0;

    const runRestoreTerminal = () => {
      restoreFrame = 0;
      restoreInnerFrame = window.requestAnimationFrame(() => {
        restoreInnerFrame = 0;
        const terminal = terminalRef.current;
        if (!terminal || (typeof document !== 'undefined' && document.hidden)) {
          return;
        }

        const viewportSnapshot = captureTerminalViewport(terminal);
        flushQueuedTerminalOutput(() => {
          if (terminalRef.current !== terminal || (typeof document !== 'undefined' && document.hidden)) {
            return;
          }

          fitAndNotify();
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
          restoreTerminalViewport(terminal, viewportSnapshot);
          const needsReconnect =
            activeSessionIdRef.current &&
            !hasExitedRef.current &&
            (reconnectOnVisibleRef.current || !isTransportUsable());
          const recoveredBlankTerminal = recoverBlankTerminal();
          terminal.focus();

          if (transportRef.current === 'sse') {
            startHttpInputStream();
          }

          if (needsReconnect && !recoveredBlankTerminal) {
            reconnectOnVisibleRef.current = false;
            requestReconnect();
          }
        });
      });
    };

    const restoreTerminal = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      cancelPendingSnapshot();

      if (!terminalRef.current || restoreTimer || restoreFrame || restoreInnerFrame) {
        return;
      }

      const delay = Math.max(0, terminalRestoreThrottleMs - (Date.now() - lastRestoreAt));
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        lastRestoreAt = Date.now();
        restoreFrame = window.requestAnimationFrame(runRestoreTerminal);
      }, delay);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
        scheduleTerminalSnapshot();
        closeInputStream();
        return;
      }
      const hiddenForMs = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0;
      hiddenAtRef.current = 0;
      if (
        hiddenForMs >= terminalHiddenForceReplayMs &&
        activeSessionIdRef.current &&
        !hasExitedRef.current
      ) {
        resetTerminalRenderer();
      }
      cancelPendingSnapshot();
      restoreTerminal();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', restoreTerminal);
    window.addEventListener('pageshow', restoreTerminal);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', restoreTerminal);
      window.removeEventListener('pageshow', restoreTerminal);
      if (restoreTimer) {
        clearTimeout(restoreTimer);
      }
      if (restoreFrame) {
        window.cancelAnimationFrame(restoreFrame);
      }
      if (restoreInnerFrame) {
        window.cancelAnimationFrame(restoreInnerFrame);
      }
      cancelPendingSnapshot();
    };
  }, [
    cancelPendingSnapshot,
    closeInputStream,
    fitAndNotify,
    flushQueuedTerminalOutput,
    isTransportUsable,
    recoverBlankTerminal,
    requestReconnect,
    resetTerminalRenderer,
    scheduleTerminalSnapshot,
    startHttpInputStream,
  ]);

  return (
    <main className="codex-cli-page flex h-full min-h-0 flex-col">
      <section className="min-h-0 flex-1 overflow-hidden" onClick={() => terminalRef.current?.focus()}>
        <div ref={containerRef} className="codex-cli-terminal h-full w-full" />
      </section>
      {shouldHideTerminalCwd && terminalCwd && (
        <div className="pointer-events-none fixed right-3 top-3 z-40 flex max-w-[calc(100vw-24px)] flex-col items-end gap-2">
          <button
            type="button"
            aria-label={`Hold ${terminalCwdRevealKey} to show current directory`}
            aria-pressed={cwdReveal}
            title={`Hold ${terminalCwdRevealKey} to show current directory`}
            onMouseDown={(event) => {
              event.preventDefault();
              setCwdReveal(true);
            }}
            onMouseUp={() => setCwdReveal(false)}
            onMouseLeave={() => setCwdReveal(false)}
            onTouchStart={(event) => {
              event.preventDefault();
              setCwdReveal(true);
            }}
            onTouchEnd={() => setCwdReveal(false)}
            onTouchCancel={() => setCwdReveal(false)}
            onClick={(event) => event.preventDefault()}
            className="pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-[#d9d9dc] bg-[rgba(250,250,250,0.82)] px-2 text-[11px] font-medium leading-none text-[#4b4f58] shadow-sm backdrop-blur-sm transition-colors hover:border-[#b8bbc3] hover:bg-[rgba(250,250,250,0.95)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2]"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-mono">{terminalCwdRevealKey}</span>
          </button>
          {cwdReveal && (
            <div className="pointer-events-auto max-w-[min(720px,calc(100vw-24px))] overflow-x-auto rounded-md border border-[#d9d9dc] bg-[rgba(250,250,250,0.96)] px-3 py-2 font-mono text-[12px] leading-5 text-[#202227] shadow-lg">
              {terminalCwd}
            </div>
          )}
        </div>
      )}
      {terminalDebugEnabled && terminalDebugSnapshot && (
        <pre className="pointer-events-none fixed right-3 top-3 z-50 max-w-[min(420px,calc(100vw-24px))] whitespace-pre-wrap rounded-md border border-[#d9d9dc] bg-[rgba(250,250,250,0.92)] px-3 py-2 font-mono text-[11px] leading-4 text-[#202227] shadow-lg">
          {terminalDebugSnapshot}
        </pre>
      )}
      {exitInfo && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
          <div className="pointer-events-auto flex w-full max-w-lg flex-col gap-3 rounded-lg border border-[#d9d9dc] bg-white p-4 text-[#383a42] shadow-lg sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-[#202227]">Terminal exited</p>
              <p className="mt-1 text-xs text-[#696c77]">
                exit {exitInfo.exitCode ?? 'unknown'}
                {exitInfo.signal ? ` · signal ${exitInfo.signal}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to="/"
                className="inline-flex h-9 items-center justify-center rounded-md border border-[#d9d9dc] bg-white px-3 text-sm font-medium text-[#383a42] transition-colors hover:border-[#b8bbc3] hover:bg-[#fafafa] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2]"
              >
                Home
              </Link>
              <button
                type="button"
                onClick={openFreshTerminal}
                className="inline-flex h-9 items-center justify-center rounded-md bg-[#4078f2] px-3 text-sm font-medium text-white transition-colors hover:bg-[#2f5fbe] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4078f2] focus-visible:ring-offset-2"
              >
                New terminal
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
