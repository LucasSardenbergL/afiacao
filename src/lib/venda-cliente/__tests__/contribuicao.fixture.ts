import type { Json } from '@/integrations/supabase/types';

/** Métricas com TODAS as chaves que a RPC monta (jsonb_build_object). */
export function metricasJson(over: Record<string, Json> = {}): Record<string, Json> {
  return {
    itens: 3, itens_sem_preco: 0, itens_desconto_nao_apurado: 1, itens_desconto_invalido: 0,
    receita_bruta_sem_liquida: 100, itens_custo_data: 2, itens_custo_atual: 0, itens_sem_custo: 1,
    receita_bruta: 1100, desconto: 50, receita_liquida: 950, receita_com_custo: 950, receita_custo_atual: null,
    custo: 400, margem_bruta: 550, margem_bruta_pct: 57.89, pedidos: 2, pedidos_prazo_ok: 1, pedidos_sem_titulo: 1,
    pedidos_taxa_ausente: 0, pedidos_prazo_rejeitado: 0, receita_com_prazo: 950, custo_prazo: 20.1,
    custo_prazo_pct: 2.12, prazo_medio_dias: 48, receita_contribuicao: 950, custo_contribuicao: 400,
    custo_prazo_contribuicao: 20.1, contribuicao: 529.9, contribuicao_pct: 55.78, itens_com_piso: 2,
    itens_abaixo_piso: 1, gap_piso: 28,
    ...over,
  };
}
