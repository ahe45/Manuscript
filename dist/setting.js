const form = document.getElementById('settings-form');
const fields = form.querySelector('fieldset');
const title = form.elements.title;
const columns = form.elements.columns;
const candidateNumberDigits = form.elements.candidateNumberDigits;
const questionCount = form.elements.questionCount;
const questionFields = document.querySelector('#question-fields');
const questionTemplate = document.querySelector('#question-fields-template');
const helpTemplate = document.querySelector('#field-help-template');
const status = document.querySelector('#save-status');

function addFieldHelp(input) {
  const help = helpTemplate.content.firstElementChild.cloneNode(true);
  const icon = help.querySelector('button');
  const tooltip = help.querySelector('[role="tooltip"]');
  tooltip.id = input.id + '-hint';
  tooltip.textContent = input.dataset.help;
  icon.setAttribute('aria-label', input.labels[0].textContent + ' 설명');
  icon.setAttribute('aria-describedby', tooltip.id);
  input.setAttribute('aria-describedby', tooltip.id);
  help.addEventListener('pointerenter', () => delete help.dataset.dismissed);
  help.addEventListener('focusin', () => delete help.dataset.dismissed);

  const controls = document.createElement('div');
  controls.className = 'settings-input';
  input.replaceWith(controls);
  controls.append(input, help);
}

form.querySelectorAll('input[data-help]').forEach(addFieldHelp);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  form.querySelectorAll('.settings-help:hover, .settings-help:focus-within').forEach(help => {
    help.dataset.dismissed = '';
  });
});

function showQuestionInputs(count) {
  if (!Number.isInteger(count) || count < 1 || count > 20) return;
  while (questionFields.children.length < count) {
    const index = questionFields.children.length + 1;
    const row = questionTemplate.content.firstElementChild.cloneNode(true);
    const [name, limit] = row.querySelectorAll('input');
    const [nameLabel, limitLabel] = row.querySelectorAll('label');
    nameLabel.htmlFor = name.id = `question-title-${index}`;
    nameLabel.textContent = `문제 ${index} 이름`;
    name.placeholder = `문제 ${index}`;
    limitLabel.htmlFor = limit.id = `question-limit-${index}`;
    limitLabel.textContent = `문제 ${index} 글자 수`;
    questionFields.append(row);
  }
  Array.from(questionFields.children).forEach((row, index) => {
    row.hidden = index >= count;
    row.disabled = row.hidden;
  });
}

function populateQuestionInputs(settings) {
  questionCount.value = settings.questionTitles.length;
  showQuestionInputs(settings.questionTitles.length);
  settings.questionTitles.forEach((name, index) => {
    const [nameField, limitField] = questionFields.children[index].querySelectorAll('input');
    nameField.value = name;
    limitField.value = settings.questionMaxCharacters[index] ?? '';
  });
}

questionCount.addEventListener('input', () => showQuestionInputs(questionCount.valueAsNumber));

try {
  const response = await fetch('/api/settings');
  if (!response.ok) throw new Error();
  const settings = await response.json();
  if (!settings.canEditSettings) {
    location.replace('/setting-login');
    throw new Error();
  }
  title.value = settings.title;
  columns.value = settings.columns;
  candidateNumberDigits.value = settings.candidateNumberDigits ?? '';
  populateQuestionInputs(settings);
  fields.disabled = false;
} catch {
  status.textContent = '설정을 불러오지 못했습니다. 페이지를 새로고침해 주세요.';
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const rows = [...questionFields.children].slice(0, questionCount.valueAsNumber);
  const settings = {
    title: title.value.trim(),
    columns: columns.valueAsNumber,
    candidateNumberDigits: candidateNumberDigits.value === '' ? null : candidateNumberDigits.valueAsNumber,
    questionTitles: rows.map(row => row.querySelector('input[type="text"]').value.trim()),
    questionMaxCharacters: rows.map(row => {
      const input = row.querySelector('input[type="number"]');
      return input.value === '' ? null : input.valueAsNumber;
    }),
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
    populateQuestionInputs(result);
    status.textContent = '저장했습니다. 새로 여는 원고지에 적용됩니다.';
  } catch (error) {
    status.textContent = error instanceof TypeError ? '설정을 저장하지 못했습니다. 다시 시도해 주세요.' : error.message;
  } finally {
    fields.disabled = false;
  }
});
