const form = document.querySelector('#login-form');
const fields = document.querySelector('#login-fields');
const { number, name, year, month, day, accessCode } = form.elements;
const accessCodeFields = document.querySelector('#access-code-fields');
const status = document.querySelector('#login-status');
const numberHint = document.querySelector('#candidate-number-hint');
let requiredDigits = null;

function moveToName() {
  if (document.activeElement === number && number.value.length === requiredDigits && /^[0-9]+$/.test(number.value)) {
    name.focus();
  }
}

async function loadNumberRule() {
  try {
    const response = await fetch('/api/settings');
    if (!response.ok) return;
    const { candidateNumberDigits, requiresAccessCode } = await response.json();
    accessCodeFields.hidden = accessCodeFields.disabled = !requiresAccessCode;
    const hasRule = Number.isInteger(candidateNumberDigits);
    requiredDigits = hasRule ? candidateNumberDigits : null;
    number.inputMode = hasRule ? 'numeric' : 'text';
    numberHint.hidden = !hasRule;
    numberHint.textContent = hasRule ? `숫자 ${candidateNumberDigits}자리로 입력해 주세요.` : '';
    moveToName();
  } catch {
    // The server checks the current rule when the form is submitted.
  }
}

function addOptions(select, first, last, step, unit) {
  for (let value = first; step > 0 ? value <= last : value >= last; value += step) {
    select.add(new Option(`${value}${unit}`, String(value)));
  }
}

addOptions(year, new Date().getFullYear(), 1900, -1, '년');
addOptions(month, 1, 12, 1, '월');
fields.disabled = false;
if (document.activeElement === document.body) number.focus();

function updateDays() {
  const selected = day.value;
  day.length = 1;
  day.disabled = !year.value || !month.value;
  if (day.disabled) return;
  const last = new Date(Number(year.value), Number(month.value), 0).getDate();
  addOptions(day, 1, last, 1, '일');
  if (Number(selected) <= last) day.value = selected;
}

year.addEventListener('change', updateDays);
month.addEventListener('change', updateDays);
number.addEventListener('input', event => {
  if (!event.isComposing) moveToName();
});
number.addEventListener('compositionend', moveToName);
void loadNumberRule();
window.addEventListener('pageshow', event => {
  if (event.persisted) void loadNumberRule();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const birthDate = [year.value, month.value.padStart(2, '0'), day.value.padStart(2, '0')].join('-');
  fields.disabled = true;
  status.textContent = '로그인 중…';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: number.value, name: name.value, birthDate, accessCode: accessCode.value }),
    });
    if (response.ok) {
      window.location.replace('/manuscript');
      return;
    }
    const result = await response.json();
    status.textContent = result.error;
  } catch {
    status.textContent = '로그인하지 못했습니다. 다시 시도해 주세요.';
  }
  fields.disabled = false;
});
