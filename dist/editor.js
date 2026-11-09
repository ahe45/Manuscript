import { layout, COLUMNS, ROWS, CELL_BREAK } from './layout.js';

const source = document.querySelector('#source');
const area = document.querySelector('#writing-area');
const viewport = document.querySelector('#workspace-viewport');
const workspace = viewport.closest('.workspace');
const toolbar = workspace.querySelector('.toolbar');
const sheets = document.querySelector('#sheets');
const status = document.querySelector('#status');
const editorTitle = document.querySelector('#editor-title');
const questionTitle = document.querySelector('#question-title');
const questionNavigation = document.querySelector('#question-navigation');
const previousQuestion = document.querySelector('#previous-question');
const nextQuestion = document.querySelector('#next-question');
const questionPosition = document.querySelector('#question-position');
const draftUrl = '/api/draft' + location.search;
const candidateDetails = document.querySelector('#candidate-details');
const downloadButton = document.querySelector('#download-button');
const downloadOptions = document.querySelector('#download-options');
const downloadStatus = document.querySelector('#download-status');
let downloadStatusTimer;
const printSheet = document.querySelector('#print-sheet');
const loadMessage = document.querySelector('#load-message');
const limitDialog = document.querySelector('#limit-dialog');
const limitDescription = document.querySelector('#limit-description');
const zoomControls = document.querySelector('#zoom-controls');
const zoomOut = document.querySelector('#zoom-out');
const zoomIn = document.querySelector('#zoom-in');
const zoomPreset = document.querySelector('#zoom-preset');
const zoomReset = document.querySelector('#zoom-reset');
const draftStatus = document.querySelector('#draft-status');
const lastSaved = document.querySelector('#last-saved');
const saveTimeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const saveDelay = 1000;
const minimumZoom = 50;
const maximumZoom = 300;
const zoomStep = 25;
let zoom = 100;
const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
let columns = COLUMNS;
let maxCells = null;
let separateAt = null;
let acceptedText = '';
let acceptedLayout;
let savedText = '';
let editorToken;
let revision = 0;
let saving = false;
let saveTimer;
let saveAfter = null;
let saveConflict = false;
let saveTask;
let changingQuestion = false;
let question = 1;
let editSelection = [0, 0, 'none'];
let compositionSelection = editSelection;
let limitSelection;

let model;
let renderedCells = [];
let offsetsByRow = [];
let painted = new Set();
const glyphsToFit = new Set();
let glyphFitFrame = null;
let composingFrom = null;
let composingText = '';
let dragAnchor = null;
let preferredColumn = null;
let lastPointerType = 'mouse';

function addPrintPage() {
  const page = document.createElement('div');
  page.className = 'print-page';
  const content = document.createElement('div');
  content.className = 'print-content';
  page.append(content);
  printSheet.append(page);
  return content;
}

function preparePrint() {
  if (!renderedCells.length) return;
  printSheet.replaceChildren();
  printSheet.style.setProperty('--columns', columns);
  const firstPage = addPrintPage();
  const heading = document.createElement('header');
  heading.className = 'print-heading';
  const headingTitle = document.createElement('div');
  headingTitle.className = 'print-heading-title';
  const title = document.createElement('h1');
  title.textContent = editorTitle.textContent;
  const subtitle = document.createElement('p');
  subtitle.className = 'print-question';
  subtitle.textContent = questionTitle.textContent;
  headingTitle.append(title, subtitle);
  const candidate = candidateDetails.cloneNode(true);
  candidate.removeAttribute('id');
  heading.append(headingTitle, candidate);
  const rows = [];
  for (let start = 0; start < renderedCells.length; start += columns) {
    const row = document.createElement('div');
    row.className = 'grid print-row';
    for (const cell of renderedCells.slice(start, start + columns)) {
      const copy = cell.cloneNode(true);
      copy.classList.remove('caret', 'selected', 'composing');
      row.append(copy);
    }
    rows.push(row);
  }
  firstPage.append(heading, ...rows);

  printSheet.classList.add('print-measuring');
  try {
    const pageHeight = firstPage.clientHeight;
    const headingHeight = heading.getBoundingClientRect().height + parseFloat(getComputedStyle(heading).marginBottom);
    const rowHeight = rows[0].getBoundingClientRect().height + parseFloat(getComputedStyle(rows[0]).marginBottom);
    let page = firstPage;
    let remaining = pageHeight - headingHeight;
    for (const row of rows) {
      if (rowHeight > remaining) {
        page = addPrintPage();
        remaining = pageHeight;
      }
      if (page !== firstPage) page.append(row);
      remaining -= rowHeight;
    }
    fitGlyphs(printSheet.querySelectorAll('.fit-glyphs'));
  } finally {
    printSheet.classList.remove('print-measuring');
  }
}

function toggleDownloadOptions(open) {
  downloadOptions.hidden = !open;
  downloadButton.setAttribute('aria-expanded', String(open));
}

downloadButton.addEventListener('click', () => toggleDownloadOptions(downloadOptions.hidden));
document.addEventListener('click', event => {
  if (!downloadOptions.hidden && !downloadButton.parentElement.contains(event.target)) toggleDownloadOptions(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !downloadOptions.hidden) {
    toggleDownloadOptions(false);
    downloadButton.focus();
  }
});
downloadOptions.addEventListener('click', event => {
  const option = event.target.closest('button[data-mode]');
  if (!option) return;
  toggleDownloadOptions(false);
  void downloadPdf(option.dataset.mode);
});

function showDownloadStatus(message, state) {
  clearTimeout(downloadStatusTimer);
  downloadStatus.dataset.state = state;
  downloadStatus.textContent = message;
  if (state !== 'pending') {
    downloadStatusTimer = setTimeout(() => {
      downloadStatus.textContent = '';
    }, state === 'error' ? 6500 : 4000);
  }
}

async function downloadPdf(mode) {
  if (maxCells !== null && model.usedCells > maxCells) {
    showDownloadStatus('최대 사용 칸 수를 초과했습니다. 원고를 줄인 뒤 다운로드해 주세요.', 'error');
    return;
  }
  downloadButton.disabled = true;
  const fileType = mode === 'individual' ? 'ZIP' : 'PDF';
  showDownloadStatus(fileType + ' 생성 중…', 'pending');
  try {
    const response = await fetch('/api/pdf' + location.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Editor-Session': editorToken },
      body: JSON.stringify({ body: acceptedText, mode }),
    });
    if (!response.ok) {
      const error = await response.json();
      showDownloadStatus(error.error, 'error');
      return;
    }
    const encodedName = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const filename = encodedName ? decodeURIComponent(encodedName) : (mode === 'individual' ? '원고지.zip' : '원고지.pdf');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    showDownloadStatus(fileType + ' 다운로드를 시작했습니다.', 'success');
  } catch {
    showDownloadStatus('파일을 다운로드하지 못했습니다. 다시 시도해 주세요.', 'error');
  } finally {
    downloadButton.disabled = false;
  }
}
window.addEventListener('beforeprint', preparePrint);
window.addEventListener('afterprint', () => printSheet.replaceChildren());

function selection() {
  return [source.selectionStart, source.selectionEnd, source.selectionDirection];
}

new ResizeObserver(() => {
  viewport.style.setProperty('--toolbar-height', `${toolbar.offsetHeight}px`);
}).observe(toolbar);

function setZoom(next) {
  const scale = Math.max(minimumZoom, Math.min(maximumZoom, next));
  const left = viewport.scrollLeft * scale / zoom;
  zoom = scale;
  workspace.style.setProperty('--workspace-width', zoom + '%');
  viewport.scrollLeft = left;
  zoomPreset.value = String(zoom);
  zoomOut.disabled = zoom === minimumZoom;
  zoomIn.disabled = zoom === maximumZoom;
  paintSelection();
}

zoomOut.addEventListener('click', () => setZoom(zoom - zoomStep));
zoomIn.addEventListener('click', () => setZoom(zoom + zoomStep));
zoomPreset.addEventListener('change', () => setZoom(Number(zoomPreset.value)));
zoomReset.addEventListener('click', () => setZoom(100));

function showLimit() {
  if (limitDialog.open) return;
  limitSelection = selection();
  limitDescription.textContent = '원고지는 최대 ' + maxCells.toLocaleString('ko-KR') + '칸까지 사용할 수 있습니다.';
  limitDialog.showModal();
}

limitDialog.addEventListener('close', () => {
  source.focus({ preventScroll: true });
  source.setSelectionRange(...limitSelection);
});

function isFinalCellInsertion([start, end]) {
  return maxCells !== null && acceptedLayout.usedCells >= maxCells && start === end &&
    positionAt(start, acceptedLayout).cell >= maxCells - 1;
}

function layoutDraft(text) {
  return layout(text, columns, maxCells);
}

function separatorFor(text, [start, end]) {
  if (separateAt !== start || start !== end) return '';
  const canPair = acceptedLayout.pendingPair === 'digit'
    ? /^[0-9０-９]/.test(text)
    : /^[a-zａ-ｚ]/.test(text);
  return canPair ? CELL_BREAK : '';
}

function canInsert(text) {
  if (maxCells === null) return true;
  const currentSelection = selection();
  const [start, end] = currentSelection;
  const candidate = source.value.slice(0, start) + separatorFor(text, currentSelection) + text + source.value.slice(end);
  return acceptsEdit(candidate, layoutDraft(candidate), currentSelection);
}

function acceptsEdit(text, candidate, previousSelection) {
  if (maxCells === null) return true;
  // A stored draft can already exceed the limit. Let the user edit it without growing it.
  if (candidate.usedCells > Math.max(maxCells, acceptedLayout.usedCells)) return false;
  const addedLength = text.length - acceptedText.length;
  if (addedLength <= 0 || !isFinalCellInsertion(previousSelection)) return true;
  const [start] = previousSelection;
  return acceptedLayout.usedCells === maxCells && !/[\r\n]/.test(text.slice(start, start + addedLength));
}

function warnUnsaved(event) {
  event.preventDefault();
  event.returnValue = true;
}

function updateUnloadWarning() {
  if (acceptedText !== savedText || saving) window.addEventListener('beforeunload', warnUnsaved);
  else window.removeEventListener('beforeunload', warnUnsaved);
}

function queueDraftSave() {
  clearTimeout(saveTimer);
  if (saving || composingFrom !== null || saveConflict || changingQuestion || saveAfter === null) return;
  saveTimer = setTimeout(saveDraft, Math.max(0, Math.ceil(saveAfter - performance.now())));
}

function updateDraftStatus() {
  const saved = revision > 0 && acceptedText === savedText;
  setDraftStatus(saved ? 'saved' : 'writing', saved ? '저장됨' : '작성중');
}

function setDraftStatus(state, message) {
  draftStatus.dataset.state = state;
  draftStatus.textContent = message;
}

function saveTimeKey() {
  // Scope the tab's time to the login without storing the editor token.
  let scope = 0;
  for (const character of editorToken ?? '') {
    scope = (Math.imul(scope, 31) + character.charCodeAt(0)) >>> 0;
  }
  return `manuscript.saved-time.${scope}.${question}`;
}

function displaySaveTime(time) {
  lastSaved.textContent = '최종 저장 ' + (Number.isFinite(time) && time > 0 ? saveTimeFormat.format(time) : '—');
  lastSaved.hidden = false;
}

function acceptInput(previousSelection) {
  const [start] = previousSelection;
  const addedLength = source.value.length - acceptedText.length;
  if (addedLength > 0 && separatorFor(source.value.slice(start, start + addedLength), previousSelection)) {
    source.setRangeText(CELL_BREAK, start, start, 'preserve');
  }
  const candidate = layoutDraft(source.value);
  if (!acceptsEdit(source.value, candidate, previousSelection)) {
    source.value = acceptedText;
    source.setSelectionRange(...previousSelection);
    showLimit();
    return acceptedLayout;
  }
  const changed = acceptedText !== source.value;
  if (changed) separateAt = null;
  acceptedText = source.value;
  acceptedLayout = candidate;
  if (changed) {
    if (!saving && !saveConflict) updateDraftStatus();
    saveAfter = performance.now() + saveDelay;
    updateUnloadWarning();
    queueDraftSave();
  }
  return acceptedLayout;
}

function saveDraft() {
  saveTask = persistDraft();
  return saveTask;
}

async function changeQuestion(offset) {
  if (changingQuestion) return;
  changingQuestion = true;
  questionNavigation.disabled = true;
  source.disabled = true;
  clearTimeout(saveTimer);
  await saveTask;
  if (acceptedText !== savedText && !saveConflict) await saveDraft();
  if (acceptedText === savedText) {
    location.assign(`/manuscript?question=${question + offset}`);
    return;
  }
  changingQuestion = false;
  questionNavigation.disabled = false;
  source.disabled = false;
}

previousQuestion.addEventListener('click', () => changeQuestion(-1));
nextQuestion.addEventListener('click', () => changeQuestion(1));
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});

async function persistDraft() {
  saveAfter = null;
  const body = acceptedText;
  if (body === savedText) return;
  saving = true;
  updateUnloadWarning();
  setDraftStatus('writing', '작성중');
  try {
    const response = await fetch(draftUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Editor-Session': editorToken },
      body: JSON.stringify({ body, revision }),
    });
    const result = await response.json();
    if (!response.ok) {
      saveConflict = response.status === 409 || response.status === 401;
      setDraftStatus('error', result.error);
      return;
    }
    revision = result.revision;
    savedText = body;
    const time = Date.now();
    displaySaveTime(time);
    try {
      sessionStorage.setItem(saveTimeKey(), JSON.stringify({ revision, time }));
    } catch {
      // The time can still be displayed in the current page.
    }
    updateDraftStatus();
  } catch {
    setDraftStatus('error', '자동 저장에 실패했습니다. 연결을 확인한 뒤 내용을 수정하면 다시 저장합니다.');
  } finally {
    saving = false;
    updateUnloadWarning();
    queueDraftSave();
  }
}

const lowMark = /^[.,。，．，、]$/;
const sharedQuoteWidth = 0.34;

function fitGlyphs(groups) {
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
    fits.push({ group, scale: Math.min(1, availableWidth / group.offsetWidth), quoteSpace });
  }
  for (const { group, scale, quoteSpace } of fits) {
    group.style.setProperty('--glyph-scale', scale);
    if (quoteSpace) group.parentElement.style.setProperty('--quote-space', `${quoteSpace}px`);
  }
}

function queueGlyphFits(groups) {
  for (const group of groups) glyphsToFit.add(group);
  if (!glyphsToFit.size || glyphFitFrame !== null) return;
  glyphFitFrame = requestAnimationFrame(() => {
    glyphFitFrame = null;
    fitGlyphs(glyphsToFit);
    glyphsToFit.clear();
  });
}

let gridWidth;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width === gridWidth) return;
  gridWidth = entry.contentRect.width;
  queueGlyphFits(sheets.querySelectorAll('.fit-glyphs'));
}).observe(sheets);

function quoteGlyph(display, quote) {
  const single = /^['＇‘’]$/.test(display);
  return quote === 'open' ? (single ? '‘' : '“') : (single ? '’' : '”');
}

function cellGlyphs(data) {
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
  queueGlyphFits(glyphs.querySelectorAll('.fit-glyphs'));
  return glyphs;
}

function render(next = layoutDraft(source.value)) {
  const previousCells = model?.cells ?? [];
  model = next;
  offsetsByRow = [];
  model.positions.forEach((position, offset) => {
    const row = Math.floor(position.cell / columns);
    (offsetsByRow[row] ??= []).push(offset);
  });

  const needed = maxCells ?? Math.max(ROWS, Math.ceil((model.positions.at(-1).cell + 1) / columns)) * columns;
  if (renderedCells.length < needed) {
    const fragment = document.createDocumentFragment();
    for (let index = renderedCells.length; index < needed; index++) {
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
      renderedCells.push(cell);
      fragment.append(cell);
    }
    sheets.append(fragment);
  }
  while (renderedCells.length > needed) {
    renderedCells.pop().remove();
  }

  const cellsToUpdate = Math.min(needed, Math.max(previousCells.length, model.cells.length));
  for (let index = 0; index < cellsToUpdate; index++) {
    const element = renderedCells[index];
    const data = model.cells[index];
    const previous = previousCells[index];
    if (!data?.parts && !previous?.parts && data?.display === previous?.display &&
        data?.quote === previous?.quote) continue;
    element.firstChild.replaceWith(data ? cellGlyphs(data) : document.createTextNode(''));
  }

  const count = model.usedCells.toLocaleString('ko-KR');
  const total = maxCells === null ? '' : ' / ' + maxCells.toLocaleString('ko-KR');
  const overLimit = maxCells !== null && model.usedCells > maxCells ? ' · 한도 초과' : '';
  status.textContent = count + total + '칸' + overLimit;
  paintSelection(true);
}

function positionAt(offset, currentLayout = model) {
  while (!currentLayout.positions[offset] && offset > 0) offset--;
  return currentLayout.positions[offset];
}

function paintSelection(reveal = false) {
  for (const cell of painted) cell.classList.remove('selected', 'caret', 'composing');
  painted.clear();
  if (document.activeElement !== source) return;

  const start = source.selectionStart;
  const end = source.selectionEnd;
  const activeOffset = source.selectionDirection === 'backward' ? start : end;
  const position = start === end && activeOffset === source.value.length &&
      model.pendingPair && separateAt !== activeOffset && composingFrom === null
    ? { cell: model.usedCells - 1, fraction: 0.7 }
    : positionAt(activeOffset);
  const lastVisible = renderedCells.length - 1;
  const activeCell = renderedCells[Math.min(position.cell, lastVisible)];
  const fraction = position.cell > lastVisible ? 0.92 : position.fraction;

  if (composingFrom !== null) {
    const composingEnd = Math.max(end, composingFrom + composingText.length);
    const first = positionAt(Math.min(composingFrom, source.value.length)).cell;
    const last = Math.min(lastVisible, positionAt(Math.min(Math.max(composingFrom, composingEnd - 1), source.value.length)).cell);
    for (let index = first; index <= last; index++) {
      renderedCells[index].classList.add('composing');
      painted.add(renderedCells[index]);
    }
  } else if (start !== end) {
    const first = positionAt(start).cell;
    const last = Math.min(lastVisible, positionAt(end - 1).cell);
    for (let index = first; index <= last; index++) {
      renderedCells[index].classList.add('selected');
      painted.add(renderedCells[index]);
    }
  }

  if (start === end) {
    activeCell.style.setProperty('--caret', `${fraction * 100}%`);
    activeCell.classList.add('caret');
    painted.add(activeCell);
  }

  if (composingFrom === null) placeSource(activeCell, fraction);
  if (reveal) activeCell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function placeSource(cell, fraction) {
  const bounds = cell.getBoundingClientRect();
  const origin = area.getBoundingClientRect();
  const left = bounds.left - origin.left + bounds.width * fraction;
  source.style.left = Math.min(left, area.clientWidth - 17) + 'px';
  source.style.top = `${bounds.top - origin.top}px`;
}

function offsetFromPointer(cell, x) {
  const data = model.cells[Number(cell.dataset.cell)];
  if (!data) return source.value.length;
  const bounds = cell.getBoundingClientRect();
  const ratio = (x - bounds.left) / bounds.width;
  const stops = [];
  for (let offset = data.start; offset < data.end; offset++) {
    if (model.positions[offset]?.cell === Number(cell.dataset.cell)) stops.push(offset);
  }
  stops.push(data.end);
  return stops[Math.round(Math.max(0, Math.min(1, ratio)) * (stops.length - 1))];
}

function selectTo(anchor, offset) {
  source.setSelectionRange(Math.min(anchor, offset), Math.max(anchor, offset),
    offset < anchor ? 'backward' : 'forward');
  paintSelection();
}

function selectCell(cell, x, extend) {
  separateAt = null;
  const offset = offsetFromPointer(cell, x);
  const anchor = extend && document.activeElement === source
    ? (source.selectionDirection === 'backward' ? source.selectionEnd : source.selectionStart)
    : offset;
  source.setSelectionRange(Math.min(anchor, offset), Math.max(anchor, offset),
    offset < anchor ? 'backward' : 'forward');
  source.focus({ preventScroll: true });
  preferredColumn = null;
  paintSelection();
  return anchor;
}

sheets.addEventListener('pointerdown', event => {
  const cell = event.target.closest('.cell');
  if (!cell || event.button !== 0) return;
  lastPointerType = event.pointerType;
  if (lastPointerType !== 'mouse') return;
  event.preventDefault();
  if (composingFrom !== null) {
    source.blur();
  }
  dragAnchor = selectCell(cell, event.clientX, event.shiftKey);
  sheets.setPointerCapture(event.pointerId);
});

sheets.addEventListener('pointermove', event => {
  if (dragAnchor === null) return;
  const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('.cell');
  if (cell && sheets.contains(cell)) selectTo(dragAnchor, offsetFromPointer(cell, event.clientX));
});

sheets.addEventListener('pointerup', () => {
  dragAnchor = null;
});

sheets.addEventListener('click', event => {
  if (lastPointerType === 'mouse') return;
  const cell = event.target.closest('.cell');
  if (!cell) return;
  event.preventDefault();
  if (composingFrom !== null) source.blur();
  selectCell(cell, event.clientX, false);
});

sheets.addEventListener('pointercancel', () => {
  dragAnchor = null;
});

source.addEventListener('beforeinput', event => {
  if (composingFrom !== null || event.isComposing) return;
  editSelection = selection();
  if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') separateAt = null;
  if (!event.cancelable || !event.inputType.startsWith('insert')) return;
  const insertedText = event.inputType === 'insertText' ? event.data : null;
  if (insertedText ? !canInsert(insertedText) : isFinalCellInsertion(editSelection)) {
    event.preventDefault();
    showLimit();
    return;
  }
  if (insertedText) insertSeparatedText(event, insertedText);
});

function insertSeparatedText(event, text) {
  const separator = separatorFor(text, selection());
  // Insert the separator and the text in one native undo step.
  if (separator && document.execCommand('insertText', false, separator + text)) event.preventDefault();
}

source.addEventListener('paste', event => {
  if (composingFrom !== null || !event.clipboardData) return;
  const text = event.clipboardData.getData('text/plain');
  if (!canInsert(text)) {
    event.preventDefault();
    showLimit();
    return;
  }
  editSelection = selection();
  insertSeparatedText(event, text);
});

function copyWithoutCellBreaks(event) {
  const [start, end] = selection();
  const text = source.value.slice(start, end);
  if (!event.clipboardData || !text.includes(CELL_BREAK)) return;
  event.clipboardData.setData('text/plain', text.replaceAll(CELL_BREAK, ''));
  event.preventDefault();
  if (event.type === 'cut') {
    editSelection = selection();
    if (!document.execCommand('delete')) {
      source.setRangeText('', start, end, 'start');
      render(acceptInput(editSelection));
    }
  }
}

source.addEventListener('copy', copyWithoutCellBreaks);
source.addEventListener('cut', copyWithoutCellBreaks);

source.addEventListener('input', event => {
  const composing = composingFrom !== null || event.isComposing;
  const next = composing ? undefined : acceptInput(editSelection);
  preferredColumn = null;
  render(composing && isFinalCellInsertion(compositionSelection) ? acceptedLayout : next);
});

source.addEventListener('compositionstart', () => {
  compositionSelection = selection();
  composingFrom = source.selectionStart;
  composingText = '';
  clearTimeout(saveTimer);
});

source.addEventListener('compositionupdate', event => {
  composingText = event.data;
});

source.addEventListener('compositionend', () => {
  composingFrom = null;
  composingText = '';
  editSelection = compositionSelection;
  const next = acceptInput(compositionSelection);
  queueDraftSave();
  render(next);
});

source.addEventListener('focus', () => paintSelection());
source.addEventListener('blur', () => {
  const wasComposing = composingFrom !== null;
  composingFrom = null;
  composingText = '';
  if (wasComposing) queueDraftSave();
  paintSelection();
});
source.addEventListener('select', () => paintSelection());
document.addEventListener('selectionchange', () => paintSelection());
window.addEventListener('resize', () => paintSelection());

source.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || composingFrom !== null) return;
  const { key } = event;
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
      key === 'ArrowRight' && source.selectionStart === source.value.length &&
      source.selectionEnd === source.value.length && model.pendingPair) {
    event.preventDefault();
    separateAt = source.value.length;
    paintSelection(true);
    return;
  }
  if (key === 'ArrowLeft' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
      separateAt === source.selectionStart && separateAt === source.selectionEnd) {
    event.preventDefault();
    separateAt = null;
    paintSelection(true);
    return;
  }
  if (key.startsWith('Arrow') || key === 'Home' || key === 'End') separateAt = null;
  const isVertical = key === 'ArrowUp' || key === 'ArrowDown';
  if (event.ctrlKey || event.metaKey || event.altKey ||
      (!isVertical && key !== 'Home' && key !== 'End')) {
    preferredColumn = null;
    return;
  }

  event.preventDefault();
  const backward = source.selectionDirection === 'backward';
  const active = backward ? source.selectionStart : source.selectionEnd;
  const anchor = backward ? source.selectionEnd : source.selectionStart;
  const current = positionAt(active);
  const row = Math.floor(current.cell / columns);
  const column = current.cell % columns + current.fraction;
  let offset;

  if (isVertical) {
    preferredColumn ??= column;
    const targetRow = row + (key === 'ArrowUp' ? -1 : 1);
    const candidates = offsetsByRow[targetRow];
    if (!candidates) {
      offset = key === 'ArrowUp' ? 0 : source.value.length;
    } else {
      const distance = offset => {
        const position = model.positions[offset];
        return Math.abs(position.cell % columns + position.fraction - preferredColumn);
      };
      offset = candidates.reduce((best, candidate) => distance(candidate) < distance(best) ? candidate : best);
    }
  } else {
    preferredColumn = null;
    const candidates = offsetsByRow[row];
    offset = key === 'Home' ? candidates[0] : candidates.at(-1);
  }
  selectTo(event.shiftKey ? anchor : offset, offset);
  paintSelection(true);
});

try {
  const response = await fetch(draftUrl);
  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error();
  }
  if (response.status === 404 && location.search) {
    window.location.replace('/manuscript');
    throw new Error();
  }
  if (!response.ok) throw new Error();
  const settings = await response.json();
  document.title = settings.title;
  editorTitle.textContent = settings.title;
  question = settings.question;
  questionTitle.textContent = settings.questionTitles[question - 1];
  questionPosition.textContent = `${question} / ${settings.questionTitles.length}`;
  previousQuestion.disabled = question === 1;
  nextQuestion.disabled = question === settings.questionTitles.length;
  questionNavigation.hidden = settings.questionTitles.length === 1;
  for (const field of candidateDetails.querySelectorAll('[data-field]')) {
    field.textContent = settings.candidate[field.dataset.field];
  }
  candidateDetails.hidden = false;
  editorToken = settings.editorToken;
  columns = settings.columns;
  maxCells = settings.maxCharacters;
  revision = settings.revision;
  source.value = settings.body;
  savedText = acceptedText = source.value;
  document.querySelector('.editor').style.setProperty('--columns', columns);
  let previousSaveTime;
  try {
    const previousSave = JSON.parse(sessionStorage.getItem(saveTimeKey()));
    if (previousSave?.revision === revision) previousSaveTime = previousSave.time;
  } catch {
    // No stored timestamp is available in this tab.
  }
  displaySaveTime(previousSaveTime);
  updateDraftStatus();
  acceptedLayout = layoutDraft(acceptedText);
  render(acceptedLayout);
  source.disabled = false;
  downloadButton.disabled = false;
  zoomControls.hidden = false;
  if (document.activeElement === document.body) {
    source.setSelectionRange(source.value.length, source.value.length);
    source.focus({ preventScroll: true });
    paintSelection(true);
  }
} catch {
  status.textContent = '원고를 불러오지 못했습니다.';
  loadMessage.textContent = '페이지를 새로고침해 주세요.';
}
