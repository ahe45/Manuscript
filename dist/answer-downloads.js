import { bindDownloadMenus } from './download-menu.js';

const status = document.querySelector('#answer-status');
const allAnswers = document.querySelector('#all-answers');
const rows = document.querySelector('#answer-rows');
const menuTemplate = document.querySelector('#answer-download-menu');
const candidatesByButton = new WeakMap();

function returnToLogin(response) {
  if (response.status !== 403) return false;
  location.replace('/setting-login');
  return true;
}

async function download(button, path, candidate) {
  button.disabled = true;
  status.textContent = '파일을 준비하는 중…';
  try {
    const response = await fetch(path, candidate && {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(candidate),
    });
    if (returnToLogin(response)) return;
    if (!response.ok) throw new Error((await response.json()).error);
    const name = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name ? decodeURIComponent(name) : '답안';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = '다운로드를 시작했습니다.';
  } catch (error) {
    status.textContent = error instanceof TypeError ? '다운로드하지 못했습니다. 다시 시도해 주세요.' : error.message;
  } finally {
    button.disabled = false;
  }
}

bindDownloadMenus(allAnswers.closest('.answer-panel'), (mode, button) => {
  if (button === allAnswers) {
    void download(button, '/api/admin/answers/export?mode=' + mode);
  } else {
    void download(button, '/api/admin/answers/pdf', { ...candidatesByButton.get(button), mode });
  }
});

async function loadCandidates() {
  const response = await fetch('/api/admin/answers');
  if (returnToLogin(response)) return;
  if (!response.ok) throw new Error();
  const candidates = await response.json();
  for (const candidate of candidates) {
    const row = rows.insertRow();
    for (const value of [candidate.number, candidate.name, candidate.birthDate]) row.insertCell().textContent = value;
    const menu = menuTemplate.content.firstElementChild.cloneNode(true);
    const button = menu.querySelector('.download-button');
    const options = menu.querySelector('.download-options');
    options.id = 'answer-download-options-' + row.rowIndex;
    button.setAttribute('aria-controls', options.id);
    button.setAttribute('aria-label', candidate.number + ' ' + candidate.name + ' 다운로드');
    candidatesByButton.set(button, candidate);
    row.insertCell().append(menu);
  }
  status.textContent = candidates.length ? '수험생 ' + candidates.length + '명' : '저장된 수험생이 없습니다.';
  allAnswers.disabled = !candidates.length;
  rows.closest('.answer-table-wrapper').hidden = !candidates.length;
}

loadCandidates().catch(() => {
  status.textContent = '수험생 목록을 불러오지 못했습니다. 새로고침해 주세요.';
});
