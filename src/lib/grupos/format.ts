/** Formatação compartilhada das telas de Grupo de Cliente 360. */

/** Formata documento (só-dígitos) como CNPJ ou CPF; devolve cru se não for 11/14. */
export function formatDoc(d: string): string {
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return d;
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Formata em Real. Aceita number ou string (a view numérica do Supabase vem como string). */
export function formatBRL(v: number | string | null | undefined): string {
  return BRL.format(Number(v ?? 0));
}
