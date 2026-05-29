export function waPhoneCandidates(input: string | null | undefined): string[] {
  if (!input) return [];
  let d = String(input).replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (d.length < 10) return [];
  const out = new Set<string>([d]);
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length === 9 && rest.startsWith('9')) {
    out.add(ddd + rest.slice(1));
  } else if (rest.length === 8 && /^[6-9]/.test(rest)) {
    out.add(ddd + '9' + rest);
  }
  return [...out];
}
