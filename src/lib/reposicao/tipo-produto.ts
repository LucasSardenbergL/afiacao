/**
 * Normaliza o tipo fiscal do item do Omie (tipoItem/SPED) ao código canônico de
 * 2 dígitos ('04' = Produto Acabado/fabricado, '00' = Mercadoria p/ Revenda, etc.)
 * ou `null`.
 *
 * Aceita só 1-2 dígitos numéricos → `padStart(2,'0')`. Rejeita não-numérico
 * (ex.: 'K', que o Omie usa noutro campo como discriminador de Kit) e >2 dígitos
 * → `null`. `null` = "sinal ausente" → o writer autoritativo NÃO escreve a coluna
 * (e o trigger anti-null-clobber preserva o valor anterior se houver).
 *
 * money-path: espelhado VERBATIM no edge `omie-sync-metadados` (Deno não importa
 * de `src/`). Se mudar aqui, mudar lá. Ver
 * docs/superpowers/specs/2026-06-04-tipo-produto-coluna-dedicada-design.md
 */
export function normalizeTipoProduto(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  return s.padStart(2, "0");
}
