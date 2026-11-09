import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { zipSync } from 'fflate';

const origin = 'http://manuscript-pdf.invalid';
const assets = new Map([
  ['/manuscript', 'index.html'],
  ['/editor.js', 'editor.js'],
  ['/layout.js', 'layout.js'],
  ['/style.css', 'style.css'],
]);

async function renderDraftPdfs(editors) {
  const browser = await chromium.launch({ channel: 'chrome', timeout: 15000 });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    let editor;
    await page.route('**/*', async route => {
      const { origin: requestOrigin, pathname } = new URL(route.request().url());
      if (requestOrigin !== origin) return route.abort();
      if (pathname === '/api/draft') return route.fulfill({ json: editor });
      const asset = assets.get(pathname);
      if (!asset) return route.abort();
      return route.fulfill({ path: fileURLToPath(new URL('./dist/' + asset, import.meta.url)) });
    });
    const pdfs = [];
    for (editor of editors) {
      await page.goto(origin + '/manuscript?question=' + editor.question);
      await page.waitForSelector('#download-button:enabled', { state: 'attached' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        window.dispatchEvent(new Event('beforeprint'));
      });
      pdfs.push(await page.pdf({ format: 'A3', preferCSSPageSize: true, printBackground: true }));
    }
    return pdfs;
  } finally {
    await browser.close();
  }
}

function safeFileStem(value) {
  return value.normalize('NFC').replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').trim().replace(/[. ]+$/, '');
}

function questionFilenames(editor) {
  const used = new Set();
  return editor.questionTitles.map((title, index) => {
    const stem = safeFileStem(editor.candidate.number) + '_' + (safeFileStem(title) || '문제 ' + (index + 1));
    const characters = [...stem];
    while (Buffer.byteLength(characters.join('')) > 240) characters.pop();
    const base = characters.join('').replace(/[. ]+$/, '');
    let filename = base + '.pdf';
    for (let suffix = 2; used.has(filename.toLowerCase()); suffix++) {
      filename = base + ' (' + suffix + ').pdf';
    }
    used.add(filename.toLowerCase());
    return filename;
  });
}

export async function createPdfDownload(editors, mode) {
  const [first] = editors;
  const pdfs = await renderDraftPdfs(editors);
  if (mode === 'current') {
    return { bytes: pdfs[0], filename: questionFilenames(first)[first.question - 1], contentType: 'application/pdf' };
  }
  let base = safeFileStem(first.candidate.number);
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(base)) base = '_' + base;
  if (mode === 'individual') {
    const filenames = questionFilenames(first);
    const entries = Object.fromEntries(editors.map(({ question }, index) => [filenames[question - 1], pdfs[index]]));
    return { bytes: zipSync(entries, { level: 0 }), filename: base + '.zip', contentType: 'application/zip' };
  }
  const merged = await PDFDocument.create();
  for (const pdf of pdfs) {
    const document = await PDFDocument.load(pdf);
    for (const page of await merged.copyPages(document, document.getPageIndices())) merged.addPage(page);
  }
  return { bytes: await merged.save(), filename: base + '.pdf', contentType: 'application/pdf' };
}
