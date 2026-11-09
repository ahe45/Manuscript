import { stdin, stdout } from 'node:process';
import { clearLine, cursorTo, moveCursor } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function createSetupPrompt() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('설정 입력이 필요합니다. 명령 프롬프트에서 start.bat을 직접 실행하세요.');

  let masked = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      stdout.write(chunk, encoding, done);
    },
  });
  const write = output.write.bind(output);
  // Discard secret keystrokes before they can enter the output buffer.
  output.write = (...args) => masked || write(...args);
  output.columns = stdout.columns;
  const input = createInterface({ input: stdin, output, terminal: true, historySize: 0 });
  const cancel = new AbortController();
  input.once('close', () => cancel.abort());
  input.on('SIGINT', () => input.close());

  return {
    async ask(label, secret = false) {
      if (!secret) return (await input.question(label, { signal: cancel.signal })).trim();
      stdout.write(label);
      masked = true;
      function showMask(_character, key) {
        if (input.closed || key?.name === 'return' || key?.name === 'enter') return;
        const count = [...input.line].length;
        const columns = Math.max(1, (stdout.columns ?? 80) - Buffer.byteLength(label) - 1);
        const visible = Math.min(count, columns);
        const caret = Math.min(visible, [...input.line.slice(0, input.cursor)].length);
        cursorTo(stdout, 0);
        clearLine(stdout, 0);
        stdout.write(label + '*'.repeat(visible));
        if (caret < visible) moveCursor(stdout, caret - visible, 0);
      }
      stdin.on('keypress', showMask);
      try {
        return await input.question('', { signal: cancel.signal });
      } finally {
        stdin.off('keypress', showMask);
        masked = false;
        stdout.write('\n');
      }
    },
    close() {
      input.close();
      stdin.pause();
      stdin.unref?.();
    },
  };
}
