const fontRoot = new URL('./node_modules/@fontsource/noto-sans-kr/', import.meta.url);

export function koreanFontAsset(path) {
  const css = path.match(/^\/fonts\/(400|700)\.css$/);
  if (css) return [new URL(css[1] + '.css', fontRoot), 'text/css; charset=utf-8'];
  const match = path.match(/^\/fonts\/files\/(noto-sans-kr-[a-z0-9-]+-(?:400|700)-normal\.(woff2?))$/);
  if (match) return [new URL('files/' + match[1], fontRoot), 'font/' + match[2]];
}
