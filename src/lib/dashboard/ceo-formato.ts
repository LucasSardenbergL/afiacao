/** Formatação do placar da "Visão do CEO". Ausente ≠ zero: `null`/`undefined` → "—", nunca "R$ 0". */
const BRL_COMPACTO = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** "R$ 1,2 mi" — o CEO lê ordem de grandeza; o valor exato vai no `title` do tile. */
export function formatarBRLCompacto(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return BRL_COMPACTO.format(v);
}
