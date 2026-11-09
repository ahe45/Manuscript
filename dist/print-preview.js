import { renderPrintSheet } from './print.js';

try {
  const response = await fetch('/print-data');
  if (!response.ok) throw new Error('Print data unavailable');
  const settings = await response.json();
  document.title = settings.title;
  const sheet = document.querySelector('#print-sheet');
  renderPrintSheet(sheet, settings);
  await document.fonts.ready;
  renderPrintSheet(sheet, settings);
  sheet.dataset.printReady = 'true';
} catch {
  document.querySelector('#print-sheet').dataset.printReady = 'error';
}
