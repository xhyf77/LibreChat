const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const {
  __terminalPrivacyTestUtils,
} = require('./CodexCliTerminal');

const { createTerminalOutputRedactor } = __terminalPrivacyTestUtils;
const ansiPattern = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|.)/g;

describe('CodexCliTerminal terminal output privacy', () => {
  const cwd = '/home/xieminhui/fjj/hm_os/hongmeng';
  const codexCwd = '/home/xieminhui/fjj/hm_os/hongmeng/hm-verif-kernel';
  const codexHomeCwd = '~/fjj/hm_os/hongmeng/hm-verif-kernel';

  function serializeTerminalOutput(data) {
    return new Promise((resolve) => {
      const terminal = new HeadlessTerminal({
        allowProposedApi: true,
        cols: 120,
        rows: 24,
        scrollback: 100,
      });
      const serializeAddon = new SerializeAddon();
      terminal.loadAddon(serializeAddon);
      terminal.write(data, () => {
        resolve(serializeAddon.serialize({ scrollback: 100 }));
      });
    });
  }

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

  test('detects a Codex status cwd after terminal line controls in replay data', () => {
    const redactor = createTerminalOutputRedactor({ cwd, mode: 'shell' });
    const output = redactor.redact(`$ codex\r\ngpt-5.5 xhigh fast · ${codexHomeCwd}`, {
      stateless: true,
    });

    expect(output).toContain('[cwd hidden]');
    expect(output).not.toContain(codexHomeCwd);
    expect(output).not.toContain('hm-verif-kernel');
  });

  test('redacts xterm serialized replay data', async () => {
    const replayData = await serializeTerminalOutput(
      `$ codex\r\n\x1b[2mgpt-5.5 xhigh fast · ${codexHomeCwd}\x1b[22m\r\n`,
    );
    const redactor = createTerminalOutputRedactor({ cwd, mode: 'shell' });
    const output = redactor.redact(replayData, { stateless: true });

    expect(replayData).toContain(codexHomeCwd);
    expect(output).toContain('[cwd hidden]');
    expect(output).not.toContain(codexHomeCwd);
    expect(output).not.toContain('hm-verif-kernel');
  });

  test('redacts paths interrupted by terminal escape sequences', () => {
    const redactor = createTerminalOutputRedactor({ cwd, mode: 'shell' });
    const output = redactor.redact(
      `gpt-5.5 xhigh fast · ~/fjj/\x1b[32mhm_os/hongmeng/hm-verif-kernel\x1b[39m`,
      { stateless: true },
    );
    const visible = output.replace(ansiPattern, '');

    expect(visible).toContain('[cwd hidden]');
    expect(output).not.toContain('fjj');
    expect(output).not.toContain('hm_os');
    expect(output).not.toContain('hm-verif-kernel');
  });

  test('redacts Codex status paths split across history resume records', () => {
    const redactor = createTerminalOutputRedactor({ cwd, mode: 'shell' });
    const records = redactor.redactRecords([
      { seq: 1, data: 'gpt-5.5 xhigh fast · ' },
      { seq: 2, data: codexHomeCwd },
    ]);
    const output = records.map((record) => record.data).join('');

    expect(output).toContain('[cwd hidden]');
    expect(output).not.toContain(codexHomeCwd);
    expect(output).not.toContain('hm-verif-kernel');
  });
});
