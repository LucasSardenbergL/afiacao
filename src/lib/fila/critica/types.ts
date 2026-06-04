// src/lib/fila/critica/types.ts
// Motor "Crítica da Fila" (v1 determinístico). Tipos puros, sem dependência de rede.

export type SeveridadeSinal = 'info' | 'atencao' | 'critico';
export type TipoSinal = 'order_delta' | 'rota_outcome' | 'tarefa_estado';
export type Confianca = 'alta' | 'media' | 'baixa';
export type ChaveContradicao =
  | 'recorrente_sumiu'
  | 'sem_resposta_repetido'
  | 'tarefa_feita_sem_prova'
  | 'alto_valor_fora_rota';

/** Um fato determinístico do exhaust, atado à sua fonte (anti-alucinação). */
export interface SinalVoz {
  tipo: TipoSinal;
  texto: string; // pt-BR, pronto pra render
  fonte: { tabela: string; id: string; observadoEm: string | null }; // source_type / source_id / observed_at
  severidade: SeveridadeSinal;
}

export interface Contradicao {
  chave: ChaveContradicao;
  texto: string; // frase do badge
  evidencias: SinalVoz[]; // ≥1 SEMPRE; contradição sem evidência é descartada pelo composer
  confianca: Confianca;
}

export interface EvidencePack {
  clienteUserId: string;
  clienteNome: string | null;
  sinais: SinalVoz[]; // timeline de fricção (todos os sinais achados)
  contradicoes: Contradicao[]; // subconjunto que vira badge
  faltaDado: string[]; // degradação honesta — o que NÃO deu pra checar
}

// ── Entrada normalizada (Supabase-agnostic) ──────────────────────────
export interface MetricaCliente {
  intervaloMedioDias: number | null;
  diasDesdeUltimaCompra: number | null;
  atrasoRelativo: number | null;
  faturamento90d: number | null;
  faturamentoPrev90d: number | null;
  isColdStart: boolean;
}
export interface RotaCliente {
  naCallQueue: boolean;
  semRespostaRecenteN: number;
  ultimoContatoRealHaDias: number | null;
}
export interface TarefaCliente {
  atrasada: boolean;
  temSugestaoPendente: boolean;
  descricao: string;
}
export interface CriticaInput {
  clienteUserId: string;
  clienteNome: string | null;
  metrica: MetricaCliente | null; // null = sem linha em customer_metrics_mv
  rota: RotaCliente | null; // null = cadência indisponível (leitura de log falhou)
  tarefa: TarefaCliente | null; // null = sem tarefa atrelada a este cliente
}

/** Resultado de um detector individual. */
export interface DetectResult {
  sinais: SinalVoz[];
  contradicao: Contradicao | null;
}

/** Limiares — reusam o motor existente (useAiOps); valores de "alto valor" a calibrar no piloto. */
export interface CriticaCfg {
  atrasoRelativoMin: number; // 2.0  (useAiOps churn)
  quedaFatPct: number; // 0.5  (faturamento_90d < prev*0.5)
  semRespostaMin: number; // 3   (CADENCIA_DEFAULT.limiarSemResposta)
  altoValorFat90dMin: number; // calibrar no piloto
  altoValorDiasQuietoMin: number; // calibrar no piloto
}

export const CRITICA_CFG_DEFAULT: CriticaCfg = {
  atrasoRelativoMin: 2.0,
  quedaFatPct: 0.5,
  semRespostaMin: 3,
  altoValorFat90dMin: 5000,
  altoValorDiasQuietoMin: 45,
};
