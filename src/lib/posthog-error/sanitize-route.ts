/** Remove query string e fragmento de uma rota — eles podem conter PII (cpf, nome, etc.). */
export function stripQueryString(url: string): string {
  if (!url) return '';
  const qIdx = url.indexOf('?');
  const hIdx = url.indexOf('#');
  let end = url.length;
  if (qIdx >= 0) end = Math.min(end, qIdx);
  if (hIdx >= 0) end = Math.min(end, hIdx);
  return url.slice(0, end);
}
