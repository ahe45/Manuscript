const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const lowMark = /^[.,。，．，、]$/;
const standaloneSymbol = /^[\p{P}\p{S}]+$/u;
const sharedQuoteWidth = 0.34;
const glyphMetrics = document.createElement('canvas').getContext('2d');

export function fitGlyphs(groups) {
  const fits = [];
  for (const group of groups) {
    if (!group.isConnected || !group.offsetWidth) continue;
    const cellWidth = group.closest('.cell').clientWidth;
    const glyphs = group.parentElement;
    const closeMark = group.classList.contains('cell-line') ? glyphs.querySelector('.mark-close') : null;
    const quoteSpace = closeMark ? cellWidth * 0.16 + Math.min(closeMark.offsetWidth, cellWidth * sharedQuoteWidth) : 0;
    let availableWidth = cellWidth * 0.94;
    if (closeMark) {
      availableWidth = cellWidth * 0.96 - quoteSpace;
    } else if (group.classList.contains('cell-mark')) {
      const sharesWithText = group.classList.contains('mark-close') && glyphs.querySelector('.cell-line');
      availableWidth = cellWidth * (sharesWithText ? sharedQuoteWidth : 0.76);
    }
    let verticalOffset = 0;
    if (group.classList.contains('center-symbol')) {
      const { fontSize, fontFamily, fontWeight } = getComputedStyle(group);
      glyphMetrics.font = `${fontWeight} ${fontSize} ${fontFamily}`;
      const metrics = glyphMetrics.measureText(group.textContent);
      // Align the center of the visible glyph with the center of the font box.
      verticalOffset = (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent -
        metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) / 2;
    }
    fits.push({ group, scale: Math.min(1, availableWidth / group.offsetWidth), quoteSpace, verticalOffset });
  }
  for (const { group, scale, quoteSpace, verticalOffset } of fits) {
    group.style.setProperty('--glyph-scale', scale);
    if (group.classList.contains('center-symbol')) group.style.setProperty('--glyph-offset-y', `${verticalOffset}px`);
    if (quoteSpace) group.parentElement.style.setProperty('--quote-space', `${quoteSpace}px`);
  }
}

function quoteGlyph(display, quote) {
  const single = /^['＇‘’]$/.test(display);
  return quote === 'open' ? (single ? '‘' : '“') : (single ? '’' : '”');
}

export function cellGlyphs(data) {
  const glyphs = document.createElement('span');
  glyphs.className = 'cell-glyphs';
  const line = document.createElement('span');
  line.className = 'cell-line';
  const corners = { open: '', close: '', low: '' };
  const parts = (data.parts ?? [data]).filter(({ display }) => display);
  const hasMain = parts.some(({ display, quote }) => !quote && !lowMark.test(display));
  for (const { display, quote } of parts) {
    if (quote) {
      corners[quote] += quoteGlyph(display, quote);
    } else if (!hasMain && lowMark.test(display)) {
      corners.low += display;
    } else {
      line.append(display.replace(/[ａ-ｚ０-９]/g, character => character.normalize('NFKC')));
      if ([...segmenter.segment(display)].length > 1) line.classList.add('fit-glyphs');
    }
  }
  if (line.hasChildNodes()) {
    if (data.parts) line.classList.add('fit-glyphs');
    if (standaloneSymbol.test(line.textContent)) line.classList.add('fit-glyphs', 'center-symbol');
    glyphs.append(line);
  }
  for (const [corner, display] of Object.entries(corners)) {
    if (!display) continue;
    const mark = document.createElement('span');
    mark.className = `cell-mark mark-${corner}`;
    if (display.length > 1 || (corner === 'close' && hasMain)) mark.classList.add('fit-glyphs');
    mark.textContent = display;
    glyphs.append(mark);
  }
  return glyphs;
}

export function createGridCell(index, columns, maxCells) {
  const cell = document.createElement('span');
  const cellNumber = index + 1;
  cell.className = 'cell';
  cell.dataset.cell = index;
  cell.append(document.createTextNode(''));
  if (cellNumber % (columns * 2) === 0 || cellNumber === maxCells) {
    const count = document.createElement('span');
    count.className = 'row-count';
    count.textContent = cellNumber;
    cell.append(count);
  }
  return cell;
}
