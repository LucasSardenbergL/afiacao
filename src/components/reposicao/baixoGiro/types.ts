import type { SituacaoTipo, SituacaoCta } from "@/lib/reposicao/baixo-giro-helpers";
import type { SituacaoExcesso } from "@/lib/reposicao/excesso-helpers";

export interface RowBaixoGiro {
  id: string;                       // `${sku_codigo_omie}`
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  classe_consolidada: string | null;
  saldo: number | null;             // inventory_position
  cmc: number | null;               // inventory_position
  capital_parado: number | null;    // saldo*cmc (null se cmc null/0)
  dias_sem_vender: number | null;
  demanda_media_diaria: number | null;
  valor_vendido_90d: number | null;
  status_sugestao: string | null;
  situacao_tipo: SituacaoTipo;
  situacao_label: string;
  situacao_cta: SituacaoCta;
  estoque_minimo: number | null;
  ponto_pedido: number | null;
  estoque_maximo: number | null;
  habilitado_reposicao_automatica: boolean | null;
  tipo_reposicao: string | null;
  /** Fonte ALL-TIME (v_sku_ultima_venda): 0 = nenhuma venda em todo o histórico (~out/2025+). */
  vendas_registradas: number;
  /** Sem venda há >= LIMIAR_GIRO_MORTO_DIAS (ou nunca), fora de cold start. */
  giro_morto: boolean;
  /** Venda RARA (1-2 eventos no histórico) com estoque — candidato a virar sob-encomenda. */
  candidato_sob_encomenda: boolean;
}

export interface FiltrosBaixoGiro {
  situacao: SituacaoTipo | "todos";
  estoque: "todos" | "com_estoque" | "sem_estoque";
  giro: "todos" | "morto" | "sob_encomenda_candidato";
  busca: string;
}

/** Fila de desova — SKU com saldo acima do estoque_maximo da política. */
export interface RowExcesso {
  id: string;                          // `${sku_codigo_omie}`
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  classe_consolidada: string | null;
  saldo: number | null;                // inventory_position (linha mais recente entre accounts)
  cmc: number | null;
  ponto_pedido: number | null;
  estoque_maximo: number | null;
  excedente_un: number;                // saldo − estoque_maximo (> 0 por construção)
  capital_excedente: number | null;    // excedente×cmc (null se cmc ausente — nunca R$0)
  tempo_digerir_dias: number | null;   // ceil(excedente/demanda_media_diaria); null = sem giro
  situacao_excesso: SituacaoExcesso;
  demanda_media_diaria: number | null;
  dias_sem_vender: number | null;
  habilitado_reposicao_automatica: boolean | null;
  tipo_reposicao: string | null;
}
