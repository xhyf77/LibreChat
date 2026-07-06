const {
  __terminalPrivacyTestUtils,
} = require('./CodexCliTerminal');

const { createTerminalOutputRedactor } = __terminalPrivacyTestUtils;

describe('CodexCliTerminal terminal output privacy', () => {
  const cwd = '/home/xieminhui/fjj/hm_os/hongmeng';
  const codexCwd = '/home/xieminhui/fjj/hm_os/hongmeng/hm-verif-kernel';
  const codexHomeCwd = '~/fjj/hm_os/hongmeng/hm-verif-kernel';

  test('redacts Codex status cwd even when the terminal session is shell mode', () => {
    const redactor = createTerminalOutputRedactor({ cwd, mode: 'shell' });
    const output = redactor.redact(`gpt-5.5 xhigh fast · ${codexHomeCwd}`);

    expect(output).toContain('[cwd hidden]');
    expect(output).not.toContain(codexHomeCwd);
    expect(output).not.toContain('hm-verif-kernel');
    expect(redactor.privacyActive).toBe(true);
  });

  test('keeps redacting later home paths after a Codex status line activates privacy', () => {
    const redactor = createTerminalOutputRedactor({ cwd, mode: 'shell' });

    redactor.redact(`gpt-5.5 xhigh fast · ${codexHomeCwd}`);
    const output = redactor.redact(`opened ${codexCwd}/kernel/tailcall.c:12`);

    expect(output).toContain('[cwd hidden]');
    expect(output).not.toContain(codexCwd);
    expect(output).not.toContain('tailcall.c');
  });

  test('redacts a Codex status path split across output chunks', () => {
    const redactor = createTerminalOutputRedactor({ cwd, mode: 'shell' });

    const first = redactor.redact('gpt-5.5 xhigh fast · ~');
    const second = redactor.redact('/fjj/hm_os/hongmeng/hm-verif-kernel');

    expect(`${first}${second}`).toContain('[cwd hidden]');
    expect(`${first}${second}`).not.toContain('/fjj/hm_os/hongmeng/hm-verif-kernel');
  });
});
