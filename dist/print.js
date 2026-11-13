import { layout, visibleCellCount } from './layout.js';
import { createGridCell, cellGlyphs, fitGlyphs } from './glyphs.js';
import { fitTitle } from './fit-title.js';

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
  const title = document.createElement('h1');
  title.textContent = settings.title;
  const questionTitle = document.createElement('p');
  questionTitle.className = 'print-question';
  questionTitle.textContent = settings.questionTitles[settings.question - 1];

  const candidate = document.createElement('table');
  candidate.className = 'candidate-details';
  candidate.setAttribute('aria-label', '수험생 정보');
  const candidateRows = candidate.createTBody();
  for (const [field, label] of [
    ['number', '수험번호'],
    ['birthDate', '생년월일'],
    ['name', '성명'],
  ]) {
    const row = candidateRows.insertRow();
    const term = document.createElement('th');
    term.scope = 'row';
    if (field === 'name') term.className = 'candidate-name-label';
    term.textContent = label;
    const detail = document.createElement('td');
    if (field === 'name') {
      const name = document.createElement('div');
      name.className = 'print-candidate-name';
      name.textContent = settings.candidate.name ?? '';
      detail.append(name);
    } else {
      detail.textContent = settings.candidate[field] ?? '';
    }
    row.append(term, detail);
  }
  const signature = document.createElement('div');
  signature.className = 'proctor-signature';
  const signatureLabel = document.createElement('div');
  signatureLabel.className = 'proctor-signature-label';
  signatureLabel.textContent = '※ 감독관 확인';
  signature.append(signatureLabel);

  const candidateHeader = document.createElement('div');
  candidateHeader.className = 'candidate-header';
  candidateHeader.append(candidate, signature);
  const headingDetails = document.createElement('div');
  headingDetails.className = 'print-heading-details';
  headingDetails.append(candidateHeader);
  heading.append(title, headingDetails, questionTitle);
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
  const firstFooter = document.createElement('div');
  firstFooter.className = 'print-page-number';
  const pageFooters = [firstFooter];
  firstPage.append(heading, ...rows, firstFooter);

  sheet.classList.add('print-measuring');
  try {
    fitTitle(heading.querySelector('h1'));
    const name = heading.querySelector('.print-candidate-name');
    if (fitTitle(name, 0.75) === false) name.classList.add('wrap-name');
    const footerHeight = firstFooter.getBoundingClientRect().height;
    const pageHeight = firstPage.clientHeight - footerHeight;
    const headingHeight = rows[0].getBoundingClientRect().top - firstPage.getBoundingClientRect().top;
    const rowHeight = rows[0].getBoundingClientRect().height + parseFloat(getComputedStyle(rows[0]).marginBottom);
    let page = firstPage;
    let remaining = pageHeight - headingHeight;
    for (const row of rows) {
      if (rowHeight > remaining) {
        page = addPage(sheet);
        const footer = firstFooter.cloneNode();
        page.append(footer);
        pageFooters.push(footer);
        remaining = pageHeight;
      }
      if (page !== firstPage) page.lastElementChild.before(row);
      remaining -= rowHeight;
    }
    const questionTitle = settings.questionTitles[settings.question - 1];
    for (const [index, footer] of pageFooters.entries()) {
      footer.textContent = `${questionTitle} Page ${index + 1}/${pageFooters.length}`;
      fitTitle(footer);
    }
    fitGlyphs(sheet.querySelectorAll('.fit-glyphs'));
  } finally {
    sheet.classList.remove('print-measuring');
  }
}
