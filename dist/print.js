import { layout, visibleCellCount } from './layout.js';
import { createGridCell, cellGlyphs, fitGlyphs } from './glyphs.js';

function addPage(sheet) {
  const page = document.createElement('div');
  page.className = 'print-page';
  const content = document.createElement('div');
  content.className = 'print-content';
  page.append(content);
  sheet.append(page);
  return content;
}

function createHeading(settings) {
  const heading = document.createElement('header');
  heading.className = 'print-heading';
  const headingTitle = document.createElement('div');
  headingTitle.className = 'print-heading-title';
  const title = document.createElement('h1');
  title.textContent = settings.title;
  const subtitle = document.createElement('p');
  subtitle.className = 'print-question';
  subtitle.textContent = settings.questionTitles[settings.question - 1];
  headingTitle.append(title, subtitle);

  const candidate = document.createElement('dl');
  candidate.className = 'candidate-details';
  for (const [label, value] of [
    ['수험번호', settings.candidate.number],
    ['이름', settings.candidate.name],
    ['생년월일', settings.candidate.birthDate],
  ]) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value ?? '';
    candidate.append(term, detail);
  }
  heading.append(headingTitle, candidate);
  return heading;
}

export function renderPrintSheet(sheet, settings, model = layout(settings.body, settings.columns, settings.maxCharacters)) {
  const { columns, maxCharacters } = settings;
  const count = visibleCellCount(model, columns, maxCharacters);
  sheet.replaceChildren();
  sheet.style.setProperty('--columns', columns);
  const firstPage = addPage(sheet);
  const heading = createHeading(settings);
  const rows = [];
  for (let start = 0; start < count; start += columns) {
    const row = document.createElement('div');
    row.className = 'grid print-row';
    for (let index = start; index < Math.min(start + columns, count); index++) {
      const cell = createGridCell(index, columns, maxCharacters);
      if (model.cells[index]) cell.firstChild.replaceWith(cellGlyphs(model.cells[index]));
      row.append(cell);
    }
    rows.push(row);
  }
  firstPage.append(heading, ...rows);

  sheet.classList.add('print-measuring');
  try {
    const pageHeight = firstPage.clientHeight;
    const headingHeight = heading.getBoundingClientRect().height + parseFloat(getComputedStyle(heading).marginBottom);
    const rowHeight = rows[0].getBoundingClientRect().height + parseFloat(getComputedStyle(rows[0]).marginBottom);
    let page = firstPage;
    let remaining = pageHeight - headingHeight;
    for (const row of rows) {
      if (rowHeight > remaining) {
        page = addPage(sheet);
        remaining = pageHeight;
      }
      if (page !== firstPage) page.append(row);
      remaining -= rowHeight;
    }
    fitGlyphs(sheet.querySelectorAll('.fit-glyphs'));
  } finally {
    sheet.classList.remove('print-measuring');
  }
}
