import { cellGlyphs, createGridCell, fitGlyphs } from './glyphs.js';
import { fitTitle } from './fit-title.js';
import { renderPrintSheet } from './print.js';
import { bindDownloadMenus } from './download-menu.js';
import { layout, COLUMNS, CELL_BREAK, withinCellLimit, visibleCellCount } from './layout.js';

const source = document.querySelector('#source');
const area = document.querySelector('#writing-area');
const viewport = document.querySelector('#workspace-viewport');
const workspace = viewport.closest('.workspace');
const toolbar = workspace.querySelector('.toolbar');
const sheets = document.querySelector('#sheets');
const status = document.querySelector('#status');
const editorTitle = document.querySelector('#editor-title');
const resizeEditorTitle = () => fitTitle(editorTitle);
new ResizeObserver(() => requestAnimationFrame(resizeEditorTitle)).observe(editorTitle.parentElement);
const questionTitle = document.querySelector('#question-title');
const questionNavigation = document.querySelector('#question-navigation');
const previousQuestion = document.querySelector('#previous-question');
const nextQuestion = document.querySelector('#next-question');
const questionPosition = document.querySelector('#question-position');
const logoutForm = document.querySelector('#logout-form');
const logoutButton = logoutForm.querySelector('button');
const draftUrl = '/api/draft' + location.search;
const candidateDetails = document.querySelector('#candidate-details');
const downloadButton = document.querySelector('#download-button');
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
let checkingDraft = false;
let question = 1;
let editSelection = [0, 0, 'none'];
let compositionSelection = editSelection;
let limitSelection;

let model;
let printSettings;
let renderedCells = [];
let offsetsByRow = [];
let painted = new Set();
const glyphsToFit = new Set();
let glyphFitFrame = null;
let composingFrom = null;
let composingText = '';
let composingDraft = null;
let dragAnchor = null;
let preferredColumn = null;
let lastPointerType = 'mouse';

function preparePrint() {
  if (model && printSettings) renderPrintSheet(printSheet, printSettings, model);
}

bindDownloadMenus(downloadButton.parentElement, downloadPdf, () => !checkingDraft);

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
  if (checkingDraft || downloadButton.disabled) return;
  if (!withinCellLimit(model, maxCells)) {
    showDownloadStatus('최대 사용 칸 수를 초과했습니다. 원고를 줄인 뒤 다운로드해 주세요.', 'error');
    return;
  }
  downloadButton.disabled = true;
  const fileType = mode === 'individual' ? 'ZIP' : 'PDF';
  showDownloadStatus('원고 저장 확인 중…', 'pending');
  try {
    if (!await confirmDraftSaved()) {
      showDownloadStatus('원고를 저장하지 못해 다운로드를 시작할 수 없습니다. 저장 상태를 확인해 주세요.', 'error');
      return;
    }
    showDownloadStatus(fileType + ' 생성 중…', 'pending');
    const response = await fetch('/api/pdf' + location.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Editor-Session': editorToken },
      body: JSON.stringify({ body: savedText, mode }),
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
  if (!withinCellLimit(candidate, Math.max(maxCells, acceptedLayout.usedCells))) return false;
  const addedLength = text.length - acceptedText.length;
  if (addedLength <= 0 || !isFinalCellInsertion(previousSelection)) return true;
  const [start] = previousSelection;
  return acceptedLayout.usedCells === maxCells && !/[\r\n]/.test(text.slice(start, start + addedLength));
}

function warnUnsaved(event) {
  event.preventDefault();
  event.returnValue = true;
}

function draftBody() {
  return composingDraft ?? acceptedText;
}

function updateUnloadWarning() {
  if (draftBody() !== savedText || saving) window.addEventListener('beforeunload', warnUnsaved);
  else window.removeEventListener('beforeunload', warnUnsaved);
}

function queueDraftSave() {
  clearTimeout(saveTimer);
  if (saving || saveConflict || checkingDraft || saveAfter === null) return;
  saveTimer = setTimeout(saveDraft, Math.max(0, Math.ceil(saveAfter - performance.now())));
}

function updateDraftStatus() {
  const saved = revision > 0 && draftBody() === savedText;
  setDraftStatus(saved ? 'saved' : 'writing', saved ? '저장됨' : '작성중');
}

function setDraftStatus(state, message) {
  draftStatus.dataset.state = state;
  draftStatus.textContent = message;
}

function displaySaveTime(time) {
  lastSaved.textContent = '최종 저장 ' + (Number.isFinite(time) && time > 0 ? saveTimeFormat.format(time) : '—');
  lastSaved.hidden = false;
}

function scheduleDraftSave() {
  if (!saving && !saveConflict) updateDraftStatus();
  saveAfter = performance.now() + saveDelay;
  updateUnloadWarning();
  queueDraftSave();
}

function separatorForEdit(text, previousSelection) {
  const [start] = previousSelection;
  const addedLength = text.length - acceptedText.length;
  return addedLength > 0 ? separatorFor(text.slice(start, start + addedLength), previousSelection) : '';
}

function acceptInput(previousSelection, previousBody = acceptedText) {
  const [start] = previousSelection;
  const separator = separatorForEdit(source.value, previousSelection);
  if (separator) source.setRangeText(separator, start, start, 'preserve');
  const candidate = layoutDraft(source.value);
  if (!acceptsEdit(source.value, candidate, previousSelection)) {
    source.value = acceptedText;
    source.setSelectionRange(...previousSelection);
    showLimit();
  } else {
    if (acceptedText !== source.value) separateAt = null;
    acceptedText = source.value;
    acceptedLayout = candidate;
  }
  if (acceptedText !== previousBody) scheduleDraftSave();
  return acceptedLayout;
}

function saveDraft() {
  saveTask = persistDraft();
  return saveTask;
}

async function confirmDraftSaved(leaving = false) {
  if (checkingDraft) return false;
  checkingDraft = true;
  questionNavigation.disabled = true;
  logoutButton.disabled = true;
  source.blur();
  source.disabled = true;
  clearTimeout(saveTimer);
  await saveTask;
  if (acceptedText !== savedText && !saveConflict) await saveDraft();
  const ready = acceptedText === savedText && !saveConflict;
  if (!leaving || !ready) {
    checkingDraft = false;
    questionNavigation.disabled = false;
    logoutButton.disabled = false;
    source.disabled = false;
    if (!ready) source.focus({ preventScroll: true });
  }
  return ready;
}

async function leaveAfterSave(leave) {
  if (await confirmDraftSaved(true)) leave();
}

previousQuestion.addEventListener('click', () => leaveAfterSave(() => location.assign(`/manuscript?question=${question - 1}`)));
nextQuestion.addEventListener('click', () => leaveAfterSave(() => location.assign(`/manuscript?question=${question + 1}`)));
logoutForm.addEventListener('submit', event => {
  event.preventDefault();
  void leaveAfterSave(() => logoutForm.submit());
});
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});

async function persistDraft() {
  saveAfter = null;
  const body = draftBody();
  if (body === savedText) return;
  saving = true;
  updateUnloadWarning();
  setDraftStatus('writing', '작성중');
  try {
    const response = await fetch(draftUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Editor-Session': editorToken },
      body: JSON.stringify({ body, revision }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) {
      saveConflict = response.status === 409 || response.status === 401;
      setDraftStatus('error', result.error);
      return;
    }
    revision = result.revision;
    savedText = body;
    displaySaveTime(result.savedAt);
    updateDraftStatus();
  } catch {
    setDraftStatus('error', '자동 저장에 실패했습니다. 연결을 확인한 뒤 내용을 수정하면 다시 저장합니다.');
  } finally {
    saving = false;
    updateUnloadWarning();
    queueDraftSave();
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
document.fonts.addEventListener('loadingdone', () => queueGlyphFits(sheets.querySelectorAll('.fit-glyphs')));
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width === gridWidth) return;
  gridWidth = entry.contentRect.width;
  queueGlyphFits(sheets.querySelectorAll('.fit-glyphs'));
}).observe(sheets);

function render(next = layoutDraft(source.value)) {
  const previousCells = model?.cells ?? [];
  model = next;
  offsetsByRow = [];
  model.positions.forEach((position, offset) => {
    const row = Math.floor(position.cell / columns);
    (offsetsByRow[row] ??= []).push(offset);
  });

  const needed = visibleCellCount(model, columns, maxCells);
  if (renderedCells.length < needed) {
    const fragment = document.createDocumentFragment();
    for (let index = renderedCells.length; index < needed; index++) {
      const cell = createGridCell(index, columns, maxCells);
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
    queueGlyphFits(element.querySelectorAll('.fit-glyphs'));
  }

  const count = model.usedCells.toLocaleString('ko-KR');
  const total = maxCells === null ? '' : ' / ' + maxCells.toLocaleString('ko-KR');
  const overLimit = withinCellLimit(model, maxCells) ? '' : ' · 한도 초과';
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
  preferredColumn = null;
  if (composingFrom === null && !event.isComposing) {
    render(acceptInput(editSelection));
    return;
  }
  const text = source.value;
  const preview = layoutDraft(text);
  const separator = separatorForEdit(text, compositionSelection);
  const [start] = compositionSelection;
  const body = separator ? text.slice(0, start) + separator + text.slice(start) : text;
  const candidate = separator ? layoutDraft(body) : preview;
  // Save the visible IME text after a pause without committing the native composition.
  composingDraft = acceptsEdit(body, candidate, compositionSelection) ? body : null;
  scheduleDraftSave();
  render(isFinalCellInsertion(compositionSelection) ? acceptedLayout : preview);
});

source.addEventListener('compositionstart', () => {
  compositionSelection = selection();
  composingFrom = source.selectionStart;
  composingText = '';
});

source.addEventListener('compositionupdate', event => {
  composingText = event.data;
});

function finishComposition() {
  if (composingFrom === null) return;
  const previousBody = draftBody();
  composingFrom = null;
  composingText = '';
  composingDraft = null;
  editSelection = compositionSelection;
  render(acceptInput(compositionSelection, previousBody));
}

source.addEventListener('compositionend', finishComposition);
source.addEventListener('focus', () => paintSelection());
source.addEventListener('blur', () => {
  finishComposition();
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
  resizeEditorTitle();
  void document.fonts.ready.then(resizeEditorTitle);
  editorToken = settings.editorToken;
  columns = settings.columns;
  maxCells = settings.maxCharacters;
  revision = settings.revision;
  printSettings = settings;
  source.value = settings.body;
  savedText = acceptedText = source.value;
  document.querySelector('.editor').style.setProperty('--columns', columns);
  displaySaveTime(settings.savedAt);
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
