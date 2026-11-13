import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { Zip, ZipPassThrough, zipSync } from 'fflate';
import { koreanFontAsset } from './fonts.mjs';
import { PdfQueueError } from './pdf-queue.mjs';

const origin = 'http://manuscript-pdf.invalid';
const assets = new Map([
  ['/print', 'print.html'],
  ['/print-preview.js', 'print-preview.js'],
  ['/print.js', 'print.js'],
  ['/glyphs.js', 'glyphs.js'],
  ['/fit-title.js', 'fit-title.js'],
  ['/layout.js', 'layout.js'],
  ['/style.css', 'style.css'],
]);

async function withPdfRenderer(signal, task) {
  signal?.throwIfAborted();
  const browser = await chromium.launch({ channel: 'chrome', timeout: 15000 });
  const abort = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    let editor;
    await page.route('**/*', async route => {
      const { origin: requestOrigin, pathname } = new URL(route.request().url());
      if (requestOrigin !== origin) return route.abort();
      if (pathname === '/print-data') return route.fulfill({ json: editor });
      const font = koreanFontAsset(pathname);
      if (font) return route.fulfill({ path: fileURLToPath(font[0]), contentType: font[1] });
      const asset = assets.get(pathname);
      if (!asset) return route.abort();
      return route.fulfill({ path: fileURLToPath(new URL('./dist/' + asset, import.meta.url)) });
    });
    return await task(async nextEditor => {
      signal?.throwIfAborted();
      editor = nextEditor;
      await page.goto(origin + '/print?question=' + editor.question);
      const ready = await page.waitForSelector('[data-print-ready]', { state: 'attached' });
      if (await ready.getAttribute('data-print-ready') !== 'true') throw new Error('Print layout failed');
      return page.pdf({ format: 'A3', preferCSSPageSize: true, printBackground: true });
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close();
  }
}

async function renderDraftPdfs(editors, render) {
  const pdfs = [];
  for (const editor of editors) pdfs.push(await render(editor));
  return pdfs;
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

function candidateFileStem(candidate) {
  const base = safeFileStem(candidate.number);
  return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(base) ? '_' + base : base;
}

async function mergePdfs(pdfs, signal) {
  const merged = await PDFDocument.create();
  for (const pdf of pdfs) {
    signal?.throwIfAborted();
    const document = await PDFDocument.load(pdf);
    for (const page of await merged.copyPages(document, document.getPageIndices())) merged.addPage(page);
  }
  return merged.save();
}

export async function createPdfDownload(editors, mode, signal) {
  const [first] = editors;
  const pdfs = await withPdfRenderer(signal, render => renderDraftPdfs(editors, render));
  signal?.throwIfAborted();
  if (mode === 'current') {
    return { bytes: pdfs[0], filename: questionFilenames(first)[first.question - 1], contentType: 'application/pdf' };
  }
  const base = candidateFileStem(first.candidate);
  if (mode === 'individual') {
    const filenames = questionFilenames(first);
    const entries = Object.fromEntries(editors.map(({ question }, index) => [filenames[question - 1], pdfs[index]]));
    return { bytes: zipSync(entries, { level: 0 }), filename: base + '.zip', contentType: 'application/zip' };
  }
  return { bytes: await mergePdfs(pdfs, signal), filename: base + '.pdf', contentType: 'application/pdf' };
}

export async function writeCandidatePdfArchive(groups, path, mode, signal) {
  await withPdfRenderer(signal, async render => {
    async function* archiveChunks() {
      const usedNames = new Set();
      let chunks = [];
      let size = 0;
      const archive = new Zip((error, chunk) => {
        if (error) throw error;
        size += chunk.byteLength;
        if (size >= 0xffffffff) throw new PdfQueueError(413, '전체 답안지 ZIP이 4GB 한도를 초과했습니다.');
        chunks.push(chunk);
      });
      try {
        for await (const editors of groups) {
          signal.throwIfAborted();
          const [first] = editors;
          const pdfs = await renderDraftPdfs(editors, render);
          const filenames = questionFilenames(first);
          const files = mode === 'individual'
            ? editors.map(({ question }, index) => [filenames[question - 1], pdfs[index]])
            : [[candidateFileStem(first.candidate) + '.pdf', await mergePdfs(pdfs, signal)]];
          for (const [name, bytes] of files) {
            if (usedNames.size >= 65534) throw new PdfQueueError(413, '전체 답안지 ZIP의 파일 개수 한도를 초과했습니다.');
            const stem = name.slice(0, -4);
            let filename = name;
            for (let index = 2; usedNames.has(filename.toLowerCase()); index++) filename = `${stem} (${index}).pdf`;
            usedNames.add(filename.toLowerCase());
            const entry = new ZipPassThrough(filename);
            archive.add(entry);
            entry.push(bytes, true);
            yield* chunks;
            chunks = [];
          }
        }
        archive.end();
        yield* chunks;
      } finally {
        archive.terminate();
      }
    }
    await pipeline(archiveChunks(), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
  });
}
