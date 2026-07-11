// MIRROR-START omie-codigo-vendedor — espelhado verbatim em supabase/functions/omie-analytics-sync/index.ts
// Extrai o vendedor do cadastro Omie (ListarClientes) — money-path P0-B-bis (vendedor → carteira → comissão).
// O vendedor mora em recomendacoes.codigo_vendedor (o codigo_vendedor RAIZ vem vazio no ListarClientes);
// recomendacoes é a fonte PRIMÁRIA (padrão de omie-cliente/omie-sync), o raiz é fallback. Só inteiro
// POSITIVO conta como vendedor — 0/negativo/não-inteiro = não-atribuído (resolve o ??/|| ambíguo, Codex P2).
// PURA: sem I/O. Espelhado no edge (Deno não importa de src/); paridade textual no CI.
export function extrairCodigoVendedor(c: {
  codigo_vendedor?: number | null;
  recomendacoes?: { codigo_vendedor?: number | null } | null;
}): number | null {
  const positivo = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
  return positivo(c.recomendacoes?.codigo_vendedor) ?? positivo(c.codigo_vendedor);
}
// MIRROR-END
