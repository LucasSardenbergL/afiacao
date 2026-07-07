/**
 * Helpers da consolidação de demanda N→1 (Frente C — UX do de-para de SKU).
 *
 * A RPC `consolidar_demanda_sku(p_empresa, p_sku_antigo, p_sku_novo)` (money-path,
 * em prod desde 2026-07-05) lança `RAISE EXCEPTION ... USING ERRCODE` com SQLSTATE
 * dedicados; o supabase.rpc os expõe em `error.code`. Aqui traduzimos para mensagens
 * de usuário — degradação honesta, sem vazar o texto cru do banco.
 * Domínio: docs/agent/reposicao.md (Consolidação de demanda N→1).
 */

export interface ConsolidacaoErro {
  code?: string | null;
  message?: string | null;
}

/** Traduz o SQLSTATE da RPC `consolidar_demanda_sku` para uma mensagem de usuário. */
export function mensagemErroConsolidacao(err: ConsolidacaoErro | null | undefined): string {
  switch (err?.code) {
    case 'ZR001':
      return 'O SKU destino não pode ser o próprio SKU (auto-referência).';
    case 'ZR002':
      return 'O destino já participa de outra consolidação — cadeia não é suportada.';
    case 'ZR003':
      return 'Código de SKU inválido (precisa ser numérico).';
    case 'ZR004':
      return 'O SKU destino não está ativo/comprável na reposição — habilite-o antes de consolidar.';
    case 'ZR005':
      return 'Este SKU não tem parâmetros de reposição para descontinuar.';
    case '42501':
      return 'Você não tem permissão para consolidar demanda.';
    default:
      return err?.message || 'Falha ao consolidar a demanda.';
  }
}
