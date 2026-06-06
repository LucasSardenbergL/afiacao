export type Status =
  | 'pendente_aprovacao'
  | 'aprovado_aguardando_disparo'
  | 'bloqueado_guardrail'
  | 'disparado'
  | 'cancelado'
  | 'cancelado_humano'
  | 'expirado_sem_aprovacao'
  | string;

export type StatusEnvioPortal =
  | 'nao_aplicavel'
  | 'pendente_envio_portal'
  | 'enviando_portal'
  | 'enviado_portal'
  | 'sucesso_portal'
  | 'aceito_portal_sem_protocolo'
  | 'indeterminado_requer_conciliacao'
  | 'erro_retentavel'
  | 'erro_nao_retentavel'
  | 'falha_envio_portal';

export interface PedidoSugerido {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  grupo_codigo: string | null;
  data_ciclo: string;
  horario_geracao: string | null;
  horario_corte_planejado: string | null;
  horario_disparo_real: string | null;
  valor_total: number;
  num_skus: number;
  pedido_anterior_valor: number | null;
  delta_vs_anterior_perc: number | null;
  status: Status;
  mensagem_bloqueio: string | null;
  omie_pedido_compra_numero: string | null;
  aprovado_em: string | null;
  aprovado_por: string | null;
  condicao_pagamento_codigo: string | null;
  condicao_pagamento_descricao: string | null;
  num_parcelas: number | null;
  dias_parcelas: string | null;
  condicao_origem: string | null;
  // Tracking de envio ao portal B2B
  status_envio_portal: StatusEnvioPortal | null;
  enviado_portal_em: string | null;
  portal_protocolo: string | null;
  portal_resposta: unknown;
  portal_screenshot_url: string | null;
  portal_tentativas: number | null;
  portal_proximo_retry_em: string | null;
  portal_erro: string | null;
  // Resposta do disparo (edge disparar-pedidos-aprovados). Em status='falha_envio',
  // resposta_canal.erro carrega o MOTIVO real da falha (ex.: "SKU(s) sem custo (preço
  // unitário 0)..."). Antes só era visível no banco — não aparecia na UI.
  resposta_canal: { erro?: string; [key: string]: unknown } | null;
  criado_em?: string | null;
  cancelado_em?: string | null;
  cancelado_por?: string | null;
  justificativa_cancelamento?: string | null;
  omie_registrado_em?: string | null;
  // PR5: split de pedidos grandes Sayerlack. Pai tem split_total preenchido
  // e status='split_em_filhos'. Filhos têm split_parent_id+split_lote+split_total
  // e status normal (aprovado_aguardando_disparo / disparado / etc).
  split_parent_id?: number | null;
  split_lote?: number | null;
  split_total?: number | null;
}

export interface CondicaoPagamento {
  codigo: string;
  descricao: string;
  num_parcelas: number | null;
  dias_parcelas: string | null;
}

export interface PedidoItem {
  id: number;
  pedido_id: number;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  estoque_atual: number | null;
  estoque_minimo: number | null;
  ponto_pedido: number | null;
  estoque_maximo: number | null;
  qtde_sugerida: number;
  qtde_final: number | null;
  preco_unitario: number | null;
  valor_linha: number | null;
  primeira_compra: boolean | null;
  ajustado_humano: boolean | null;
  modo_promocao: string | null; // 'flat' | 'forward_buying' | null — distingue o ajuste promocional do mínimo forçado
}
