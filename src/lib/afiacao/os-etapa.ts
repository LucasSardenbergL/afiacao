/**
 * Mapa status do pedido de afiação → etapa (cEtapa) da Ordem de Serviço no Omie (Colacor SC).
 *
 * FONTE DA VERDADE deste mapa. Espelhado VERBATIM em:
 *   - supabase/migrations/20260605120000_afiacao_os_status_sync.sql  (função mapear_status_etapa)
 *   - supabase/functions/omie-sync/index.ts                          (função mapearStatusEtapa)
 * Qualquer mudança aqui tem que ser replicada nos dois.
 *
 * Etapas Omie: 10 Aberta · 20 Em andamento · 30 Aguardando faturamento.
 * `null` = NÃO sincroniza (mantém a OS como está). 'entregue' e qualquer status
 * desconhecido caem em null de propósito: o app sincroniza só o andamento
 * operacional (10→20→30) e nunca sobrescreve etapa pós-entrega / faturamento manual.
 */
export function mapearStatusEtapa(status: string): string | null {
  switch (status) {
    case 'pedido_recebido':
    case 'aguardando_coleta':
    case 'orcamento_enviado':
    case 'aprovado':
      return '10';
    case 'em_triagem':
    case 'em_afiacao':
    case 'controle_qualidade':
      return '20';
    case 'pronto_entrega':
    case 'em_rota':
      return '30';
    default:
      // 'entregue' + qualquer desconhecido → mantém a OS como está
      return null;
  }
}
