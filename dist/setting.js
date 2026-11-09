const form = document.getElementById('settings-form');
const fields = form.querySelector('fieldset');
const title = form.elements.title;
const columns = form.elements.columns;
const maxCharacters = form.elements.maxCharacters;
const candidateNumberDigits = form.elements.candidateNumberDigits;
const questionCount = form.elements.questionCount;
const questionTitles = document.querySelector('#question-titles');
const status = document.querySelector('#save-status');
if (new URLSearchParams(location.search).get('from') === 'login') {
  const back = document.querySelector('#settings-return');
  back.href = '/login';
  back.textContent = '로그인 화면으로';
}

function showQuestionInputs(count) {
  if (!Number.isInteger(count) || count < 1 || count > 20) return;
  while (questionTitles.children.length < count) {
    const index = questionTitles.children.length + 1;
    const row = document.createElement('div');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.id = `question-title-${index}`;
    input.type = 'text';
    input.maxLength = 100;
    input.placeholder = `문제 ${index}`;
    label.htmlFor = input.id;
    label.textContent = `문제 ${index} 이름`;
    row.append(label, input);
    questionTitles.append(row);
  }
  Array.from(questionTitles.children).forEach((row, index) => {
    row.hidden = index >= count;
  });
}

questionCount.addEventListener('input', () => showQuestionInputs(questionCount.valueAsNumber));

try {
  const response = await fetch('/api/settings');
  if (!response.ok) throw new Error();
  const settings = await response.json();
  title.value = settings.title;
  columns.value = settings.columns;
  maxCharacters.value = settings.maxCharacters ?? '';
  candidateNumberDigits.value = settings.candidateNumberDigits ?? '';
  questionCount.value = settings.questionTitles.length;
  showQuestionInputs(settings.questionTitles.length);
  settings.questionTitles.forEach((title, index) => {
    questionTitles.children[index].querySelector('input').value = title;
  });
  fields.disabled = settings.canEditSettings === false;
  if (fields.disabled) status.textContent = '설정은 서버 PC에서 변경할 수 있습니다.';
} catch {
  status.textContent = '설정을 불러오지 못했습니다. 페이지를 새로고침해 주세요.';
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const settings = {
    title: title.value.trim(),
    columns: columns.valueAsNumber,
    maxCharacters: maxCharacters.value === '' ? null : maxCharacters.valueAsNumber,
    candidateNumberDigits: candidateNumberDigits.value === '' ? null : candidateNumberDigits.valueAsNumber,
    questionTitles: [...questionTitles.querySelectorAll('input')]
      .slice(0, questionCount.valueAsNumber).map(input => input.value.trim()),
  };
  if (!settings.title) {
    status.textContent = '원고지 제목을 입력해 주세요.';
    title.focus();
    return;
  }
  fields.disabled = true;
  status.textContent = '저장 중…';
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    title.value = result.title;
    result.questionTitles.forEach((title, index) => {
      questionTitles.children[index].querySelector('input').value = title;
    });
    status.textContent = '저장했습니다. 새로 여는 원고지에 적용됩니다.';
  } catch (error) {
    status.textContent = error instanceof TypeError ? '설정을 저장하지 못했습니다. 다시 시도해 주세요.' : error.message;
  } finally {
    fields.disabled = false;
  }
});
