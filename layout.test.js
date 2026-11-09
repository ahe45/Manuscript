import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layout, PAGE_SIZE, CELL_BREAK } from './dist/layout.js';

test('조합 자모와 완성 음절을 각각 한 칸에 표시한다', () => {
  const jamo = '\u1112\u1161\u11ab';
  for (const first of ['ㅎ', '하', '한', jamo]) {
    const { cells, positions } = layout(first + '글');
    assert.deepEqual(cells.map(cell => cell.display), ['', first, '글']);
    assert.equal(positions[first.length].cell, 2);
  }
});

test('숫자와 소문자를 두 자씩 배치해도 각 문자 위치를 보존한다', () => {
  const { cells, positions } = layout('값 123 ab');
  assert.deepEqual(cells.map(cell => cell.display), ['', '값', ' ', '12', '3', ' ', 'ab']);
  assert.equal(positions[2].cell, 3);
  assert.equal(positions[3].cell, 3);
  assert.ok(positions[3].fraction > positions[2].fraction);
});

test('대문자는 한 칸씩 쓰고 숫자와 소문자는 같은 종류끼리 묶는다', () => {
  const { cells, positions } = layout('ABab12c3ｄｅ４５');
  assert.deepEqual(cells.map(cell => cell.display), ['', 'A', 'B', 'ab', '12', 'c', '3', 'ｄｅ', '４５']);
  assert.equal(positions[5].cell, positions[4].cell);
  assert.notEqual(positions[6].cell, positions[7].cell);
});

test('칸 구분은 한 칸을 차지하지 않고 지정한 소문자와 숫자만 나눈다', () => {
  const text = ['a', 'bcd1', '234'].join(CELL_BREAK);
  const { cells, positions, usedCells } = layout(text);
  assert.deepEqual(cells.map(cell => cell.display), ['', 'a', 'bc', 'd', '1', '23', '4']);
  assert.equal(usedCells, cells.length);
  assert.equal(positions[1].cell, 2);
  assert.equal(positions[2].cell, 2);
  assert.equal(layout('a' + CELL_BREAK).usedCells, 2);
});

test('숫자 사이의 마침표와 쉼표는 앞이나 뒤 숫자와 한 칸을 공유한다', () => {
  for (const [text, expected] of [
    ['3.14', ['', '3.', '14']],
    ['12,000', ['', '12', ',0', '00']],
    ['１２，０００', ['', '１２', '，０', '００']],
    ['값,12', ['', '값', ',', '12']],
  ]) {
    const { cells, positions, usedCells } = layout(text);
    assert.deepEqual(cells.map(cell => cell.display), expected);
    assert.equal(usedCells, expected.length);
    for (let index = 1; index < text.length; index++) {
      if (positions[index].cell === positions[index - 1].cell) {
        assert.ok(positions[index].fraction > positions[index - 1].fraction);
      }
    }
  }
});

test('줄 끝의 문장부호를 마지막 칸에 붙이고 새 문단을 들여쓴다', () => {
  const { cells, positions } = layout('가'.repeat(19) + '.\n다');
  assert.equal(cells[19].display, '가.');
  assert.equal(cells[20].display, '');
  assert.equal(cells[21].display, '다');
  assert.equal(positions[19].cell, 19);
  assert.equal(positions[21].cell, 21);
});

test('첫 장이 가득 차면 다음 장에서 이어 쓴다', () => {
  const { cells, positions } = layout('가'.repeat(199) + '끝');
  assert.equal(cells[PAGE_SIZE - 1].display, '가');
  assert.equal(cells[PAGE_SIZE].display, '끝');
  assert.equal(positions[199].cell, PAGE_SIZE);
});

test('설정된 행 폭을 들여쓰기와 문장부호 배치에도 적용한다', () => {
  const { cells, positions } = layout('가나다라.\n한글', 5);
  assert.deepEqual(cells.map(cell => cell.display), ['', '가', '나', '다', '라.', '', '한', '글']);
  assert.equal(positions[6].cell, 6);
});

test('사용한 칸 수는 들여쓰기, 묶어 쓴 문자, 부호를 실제 배치대로 센다', () => {
  assert.equal(layout('').usedCells, 0);
  assert.equal(layout('가1234나.', 5).usedCells, 5);
  assert.equal(layout('“네.”').usedCells, 4);
  assert.equal(layout('한……―').usedCells, 5);
  assert.equal(layout('가?나').usedCells, 4);
  assert.equal(layout('가 ').usedCells, 3);
});

test('사용한 칸 수는 문단 사이 빈칸을 포함하고 마지막 빈 줄은 제외한다', () => {
  assert.equal(layout('\n\n', 5).usedCells, 0);
  assert.equal(layout('가\n\n', 5).usedCells, 2);
  assert.equal(layout('가\n나\n', 5).usedCells, 7);
  assert.equal(layout('가\n\n나', 5).usedCells, 12);
});

test('마침표와 닫는 따옴표가 마지막 칸에 함께 들어가지 않으면 다음 행 첫 칸을 쓴다', () => {
  for (const [open, close] of [['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]) {
    const { cells, positions, usedCells } = layout(open + '가나다.' + close + '끝', 5);
    assert.equal(cells[4].display, '다');
    assert.equal(cells[5].display, '.' + close);
    assert.equal(cells[6].display, '끝');
    assert.equal(positions[4].cell, 5);
    assert.equal(positions[5].cell, 5);
    assert.equal(usedCells, 7);
  }
  const { cells, usedCells } = layout('가나다라마바.”', 5, 7);
  assert.equal(usedCells, 8);
  assert.equal(cells[6].display, '바');
  assert.equal(cells[7].display, '.”');
});

test('줄 끝 띄어쓰기는 다음 행 첫 칸을 차지하지 않고 문단은 들여쓴다', () => {
  for (const lineBreak of ['\n', '\r\n', '\r']) {
    const { cells, positions } = layout('가나다라 마' + lineBreak + '바', 5);
    assert.deepEqual(cells.map(cell => cell.display), ['', '가', '나', '다', '라', '마', '', '', '', '', '', '바']);
    assert.equal(positions[4].cell, 4);
    assert.equal(positions[6 + lineBreak.length].cell, 11);
  }
  const { cells, positions } = layout('가나다라  마', 5);
  assert.deepEqual(cells.map(cell => cell.display), ['', '가', '나', '다', '라', ' ', '마']);
  assert.equal(cells[4].end, 5);
  assert.equal(positions[5].cell, 5);
  assert.equal(layout('가나다라마바 ', 5, 7).usedCells, 7);
  assert.equal(layout('가나다라마바  ', 5, 7).usedCells, 8);
});

test('여는 부호는 다음 줄로 보내고 줄 끝 예외에 해당하는 부호는 앞줄 끝에 붙인다', () => {
  for (const [open, close] of [
    ['(', ')'], ['{', '}'], ['[', ']'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"],
    ['〈', '〉'], ['<', '>'], ['＜', '＞'], ['≪', '≫'],
  ]) {
    const opening = layout('가'.repeat(18) + open + '한' + close);
    assert.deepEqual(opening.cells.slice(19).map(cell => cell.display), ['', open, '한', close]);
    const closing = layout(open + '가'.repeat(18) + close);
    assert.equal(closing.cells[19].display, '가' + close);
    assert.equal(closing.positions[19].cell, 19);
  }
  for (const mark of '.,!?:;~%^～％＾') {
    const { cells, usedCells } = layout('가나다라' + mark + '끝', 5);
    assert.equal(cells[4].display, '라' + mark);
    assert.equal(cells[5].display, '끝');
    assert.equal(usedCells, 6);
  }
  assert.equal(layout('가나다라@끝', 5).cells[5].display, '@');
  const numberAtEnd = layout('가'.repeat(18) + '50％').cells;
  assert.equal(numberAtEnd[19].display, '50');
  assert.equal(numberAtEnd[20].display, '％');
  assert.equal(layout('가'.repeat(19) + 'ㆍ나').cells[19].display, '가ㆍ');
  const nested = layout('가나≪“한”≫', 5);
  assert.deepEqual(nested.cells.map(cell => cell.display), ['', '가', '나', '', '', '≪', '“', '한', '”', '≫']);
});

test('마침표와 닫는 큰따옴표 또는 작은따옴표를 같은 칸에 배치한다', () => {
  const displays = text => layout(text).cells.map(cell => cell.display);
  assert.deepEqual(displays('"한."'), ['', '"', '한', '."']);
  const { cells } = layout('"한."');
  assert.equal(cells[1].quote, 'open');
  assert.deepEqual(cells[3].parts.map(({ display, quote }) => [display, quote]), [['.', undefined], ['"', 'close']]);
  assert.deepEqual(displays('가."한"'), ['', '가', '.', '"', '한', '"']);
  assert.deepEqual(displays('가.“한”'), ['', '가', '.', '“', '한', '”']);
  assert.deepEqual(displays('"한\n글."').slice(-3), ['', '글', '."']);
  for (const [open, close] of [['‘', '’'], ["'", "'"], ['＇', '＇']]) {
    assert.deepEqual(displays(open + '한.' + close), ['', open, '한', '.' + close]);
    assert.deepEqual(displays('가.' + open + '한' + close), ['', '가', '.', open, '한', close]);
    assert.deepEqual(displays(open + '3.' + close), ['', open, '3', '.' + close]);
  }
  assert.deepEqual(displays('“3.”'), ['', '“', '3', '.”']);
  assert.equal(layout("don't").cells.find(cell => cell.display === "'").quote, undefined);
  assert.deepEqual(displays('“한?”'), ['', '“', '한', '?', '”']);
});

test('물음표와 느낌표 뒤의 공백은 입력한 경우에만 배치한다', () => {
  for (const mark of '?!？！') {
    assert.deepEqual(layout('한' + mark + '글').cells.map(cell => cell.display), ['', '한', mark, '글']);
    assert.deepEqual(layout('한' + mark + ' 글').cells.map(cell => cell.display), ['', '한', mark, ' ', '글']);
    assert.equal(layout('가'.repeat(19) + mark + '나').cells[20].display, '나');
  }
});

test('그 밖의 문장부호와 특수문자는 한 칸에 한 자씩 배치한다', () => {
  const marks = '~@#*^%&/\\|_-+=<>$₩,;:...……―—';
  assert.deepEqual(layout(marks, 40).cells.map(cell => cell.display), ['', ...marks]);
});
