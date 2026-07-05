// MIRROR-START omie account-coherence — espelhado verbatim em supabase/functions/omie-vendas-sync/index.ts
// Coerência conta×código por PROVA POSITIVA (money-path): true só quando `code` é o código de OUTRA
// conta Omie do MESMO cliente (linhas de omie_clientes filtradas por user_id). NÃO acusa por
// AUSÊNCIA — oben/colacor_sc resolvem o código via API do Omie e podem não estar no espelho local;
// acusar ausência rejeitaria pedido legítimo. Só barra quando o código bate uma empresa_omie
// DIFERENTE e NÃO bate a conta alvo. Espelhado no edge (Deno não importa de src/); paridade textual
// no CI em src/__tests__/edge-money-path-invariants.test.ts.
export function codeBelongsToWrongAccount(
  rows: ReadonlyArray<{ omie_codigo_cliente: number; empresa_omie: string }>,
  code: number,
  account: string,
): boolean {
  if (!Number.isFinite(code) || code <= 0) return false;
  const matchesTarget = rows.some((r) => Number(r.omie_codigo_cliente) === code && r.empresa_omie === account);
  if (matchesTarget) return false;
  return rows.some((r) => Number(r.omie_codigo_cliente) === code && r.empresa_omie !== account);
}
// MIRROR-END
