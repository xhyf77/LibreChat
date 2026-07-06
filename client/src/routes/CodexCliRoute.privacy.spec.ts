import { __terminalPrivacyTestUtils } from './CodexCliRoute';

const { getTerminalOutputPathPrivacyUpdate, maskTerminalRestoredPrivatePaths } =
  __terminalPrivacyTestUtils;

describe('CodexCliRoute terminal cwd privacy', () => {
  const cwd = '/home/xieminhui/fjj/hm_os/hongmeng/hm-verif-kernel';

  test('masks the Codex status line cwd by default', () => {
    const raw = 'gpt-5.5 xhigh fast · ~/fjj/hm_os/hongmeng/hm-verif-kernel';
    const masked = maskTerminalRestoredPrivatePaths(raw, cwd, true, true);

    expect(masked).toContain('[cwd hidden]');
    expect(masked).not.toContain('~/fjj/hm_os/hongmeng/hm-verif-kernel');
    expect(masked).not.toContain('hm-verif-kernel');
  });

  test('uses Codex status paths as the F2 reveal cwd', () => {
    const update = getTerminalOutputPathPrivacyUpdate(
      'gpt-5.5 xhigh fast · ~/fjj/hm_os/hongmeng/hm-verif-kernel',
      cwd,
    );

    expect(update.displayCwd).toBe(cwd);
    expect(update.aliasPaths).toContain(cwd);
  });

  test('does not let ordinary output paths replace the F2 reveal cwd', () => {
    const update = getTerminalOutputPathPrivacyUpdate(
      'updated /home/xieminhui/fjj/hm_os/hongmeng/hm-verif-kernel/kernel/tailcall.c:42',
      cwd,
    );

    expect(update.displayCwd).toBeNull();
    expect(update.aliasPaths).toContain(
      '/home/xieminhui/fjj/hm_os/hongmeng/hm-verif-kernel/kernel/tailcall.c:42',
    );
  });

  test('masks restored terminal snapshots before writing them back', () => {
    const raw = `cwd ${cwd}\nfile ${cwd}/kernel/tailcall.c`;
    const masked = maskTerminalRestoredPrivatePaths(raw, cwd, true, true);

    expect(masked).toContain('[cwd hidden]');
    expect(masked).not.toContain(cwd);
    expect(masked).not.toContain('tailcall.c');
  });
});
