export const COLUMNS = 20;
export const ROWS = 10;
export const PAGE_SIZE = COLUMNS * ROWS;
export const CELL_BREAK = '\u2063';

export function withinCellLimit(model, maxCells) {
  return maxCells === null || model.usedCells <= maxCells;
}

export function visibleCellCount(model, columns, maxCells) {
  return maxCells ?? Math.max(ROWS, Math.ceil((model.positions.at(-1).cell + 1) / columns)) * columns;
}

const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const digit = /^[0-9０-９]$/;
const lowercase = /^[a-zａ-ｚ]$/;
const openingMark = /^[\p{Ps}\p{Pi}<＜≪]$/u;
const closingMark = /^[\p{Pe}\p{Pf}>＞≫]$/u;
const straightQuote = /^["'＂＇]$/;
const quoteMark = /^[“”‘’"'＂＇]$/;
const period = /^[.。．]$/;
const numericSeparator = /^[.,．，]$/;
const lineEndMarks = /^[.,!?;:·ㆍ・･%‰‱~^。，．，！？、：；％～＾]$/;
const space = /^[ \t\u3000]$/;
const latinOrDigit = /^[a-z0-9]$/i;

export function layout(text, columns = COLUMNS, maxCells = null) {
  const cells = [];
  const positions = [];
  let column = 0;
  let usedCells = 0;
  let indent = true;
  let pendingPair = null;
  let lastCellSize = 0;
  const openQuotes = new Set();
  const segments = [...graphemes.segment(text)];

  function addCell(display, start, end) {
    cells.push({ display, start, end });
    lastCellSize = display ? 1 : 0;
    column = (column + 1) % columns;
    return cells.length - 1;
  }

  function appendToLast(segment, index, end, quote, packsTogether, previousIndex) {
    const cell = cells.length - 1;
    const previous = cells[cell];
    if (!packsTogether) {
      previous.parts ??= [{ display: previous.display, quote: previous.quote }];
      previous.parts.push({ display: segment, quote });
    }
    previous.display += segment;
    lastCellSize++;
    previous.end = end;
    const previousPosition = positions[previousIndex];
    positions[index] = { cell, fraction: (previousPosition.fraction + 0.92) / 2 };
  }

  for (let cursor = 0; cursor < segments.length; cursor++) {
    const { segment, index } = segments[cursor];
    const previous = segments[cursor - 1];
    const previousSegment = previous?.segment ?? '';
    const next = segments[cursor + 1]?.segment ?? '';
    const end = index + segment.length;
    if (segment === CELL_BREAK) {
      positions[index] = { cell: cells.length, fraction: 0.11 };
      pendingPair = null;
      continue;
    }
    if (indent) {
      addCell('', index, index);
      indent = false;
    }

    if (segment === '\n' || segment === '\r\n' || segment === '\r') {
      positions[index] ??= { cell: cells.length, fraction: 0 };
      if (column === 0 || cells.length === maxCells) {
        const last = cells.length - 1;
        positions[index] = { cell: last, fraction: 0.92 };
      }
      while (column !== 0) addCell('', index, index);
      indent = true;
      pendingPair = null;
      continue;
    }

    const atRowEnd = (column === 0 || cells.length === maxCells) &&
      Boolean(cells.at(-1)?.display) && !space.test(previousSegment);
    if (atRowEnd && space.test(segment)) {
      const cell = cells.length - 1;
      cells[cell].end = end;
      positions[index] = { cell, fraction: 0.92 };
      pendingPair = null;
      continue;
    }

    const isStraightQuote = straightQuote.test(segment);
    const isApostrophe = (segment === "'" || segment === '’') &&
      latinOrDigit.test(previousSegment) && latinOrDigit.test(next);
    const closesStraightQuote = isStraightQuote && openQuotes.has(segment);
    const isOpening = !isApostrophe && (openingMark.test(segment) ||
      (isStraightQuote && !closesStraightQuote));
    const isClosing = !isApostrophe && (closingMark.test(segment) || closesStraightQuote);
    if (isStraightQuote && !isApostrophe) {
      if (closesStraightQuote) openQuotes.delete(segment);
      else openQuotes.add(segment);
    }

    const quote = !isApostrophe && quoteMark.test(segment) ? (isOpening ? 'open' : 'close') : undefined;
    const followsPrevious = isClosing || isApostrophe || lineEndMarks.test(segment);
    // This also keeps a closing quote with a period already attached at the row end.
    const joinsPeriod = quote === 'close' && period.test(previousSegment);
    const endsQuotedSentence = period.test(segment) &&
      (next === '”' || next === '’' || openQuotes.has(next));
    const separatesDigits = numericSeparator.test(segment) && digit.test(previousSegment) &&
      !endsQuotedSentence;
    const pair = digit.test(segment) ? 'digit' : lowercase.test(segment) ? 'lowercase' : null;
    const packsTogether = (pair !== null && pair === pendingPair) ||
      (separatesDigits && pendingPair === 'digit');
    const fitsAtRowEnd = atRowEnd && followsPrevious && lastCellSize < 2;
    if (fitsAtRowEnd || joinsPeriod || packsTogether) {
      appendToLast(segment, index, end, quote, packsTogether, previous.index);
      pendingPair = null;
      continue;
    }

    if (isOpening) {
      let requiredCells = 2;
      // Consecutive opening marks need room for the first character they enclose.
      while (requiredCells < columns && openingMark.test(segments[cursor + requiredCells - 1]?.segment ?? '')) {
        requiredCells++;
      }
      const rowEnd = cells.length + columns - column;
      const visibleEnd = maxCells > cells.length ? Math.min(rowEnd, maxCells) : rowEnd;
      if (requiredCells > visibleEnd - cells.length) {
        while (cells.length < visibleEnd) addCell('', index, index);
      }
    }

    const cell = addCell(segment, index, end);
    if (quote) cells[cell].quote = quote;
    positions[index] = { cell, fraction: 0.11 };
    usedCells = cells.length;
    // A separator that could not share the preceding cell can share with the next digit.
    pendingPair = separatesDigits ? 'digit' : pair;
  }

  if (indent) addCell('', text.length, text.length);
  positions[text.length] = { cell: cells.length, fraction: 0.11 };
  return { cells, positions, usedCells, pendingPair };
}
