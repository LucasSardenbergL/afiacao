// Formatadores do módulo Prime — locais para não criar aresta cross-module
// (o gate de fronteiras barra prime→reposicao; grupos/financeiro têm os seus).

/** R$ pt-BR; null/undefined → "—" (ausente ≠ zero — nunca exibir R$ 0,00 fabricado). */
export const formatBRL = (v: number | null | undefined): string =>
  v === null || v === undefined
    ? '—'
    : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

/** "YYYY-MM-DD" → "DD/MM/YYYY" (posicional, sem Date/TZ); vazio/null → "—". */
export const formatData = (d: string | null | undefined): string => {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
};
