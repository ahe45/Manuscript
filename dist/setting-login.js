const form = document.querySelector('#login-form');
const fields = document.querySelector('#login-fields');
const status = document.querySelector('#login-status');

form.addEventListener('submit', async event => {
  event.preventDefault();
  fields.disabled = true;
  status.textContent = '로그인 중…';
  try {
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.elements.password.value }),
    });
    if (response.ok) {
      location.replace('/admin-home');
      return;
    }
    status.textContent = (await response.json()).error;
  } catch {
    status.textContent = '관리자 로그인을 완료하지 못했습니다. 다시 시도해 주세요.';
  }
  fields.disabled = false;
});
