export function fitTitle(title, minimumScale = 0) {
  title.style.removeProperty('font-size');
  const availableWidth = title.getBoundingClientRect().width;
  if (!availableWidth) return;

  const text = document.createRange();
  text.selectNodeContents(title);
  if (text.getBoundingClientRect().width <= availableWidth) return true;

  let overflows = parseFloat(getComputedStyle(title).fontSize);
  let fits = overflows * minimumScale;
  while (overflows - fits > 0.1) {
    const size = (fits + overflows) / 2;
    title.style.fontSize = `${size}px`;
    if (text.getBoundingClientRect().width <= availableWidth) {
      fits = size;
    } else {
      overflows = size;
    }
  }
  title.style.fontSize = `${fits}px`;
  return text.getBoundingClientRect().width <= availableWidth;
}
