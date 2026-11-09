export function bindDownloadMenus(container, onSelect, canOpen = () => true) {
  let active;

  function close() {
    if (!active) return;
    active.options.hidden = true;
    active.button.setAttribute('aria-expanded', 'false');
    active = undefined;
  }

  container.addEventListener('click', event => {
    const button = event.target.closest('.download-button');
    if (button) {
      const wasOpen = active?.button === button;
      close();
      if (wasOpen || !canOpen()) return;
      const options = button.parentElement.querySelector('.download-options');
      options.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      active = { button, options };
      return;
    }
    const option = event.target.closest('button[data-mode]');
    if (!option || !active?.options.contains(option)) return;
    const trigger = active.button;
    close();
    onSelect(option.dataset.mode, trigger);
  });

  document.addEventListener('click', event => {
    if (active && !active.button.parentElement.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !active) return;
    const { button } = active;
    close();
    button.focus();
  });
}
