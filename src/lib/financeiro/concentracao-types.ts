// F5 Concentração de recebíveis — tipos puros.
// Spec: docs/superpowers/specs/2026-07-05-concentracao-recebiveis-design.md
// Money-path: ausente ≠ zero — o helper NUNCA calcula sobre fonte não provada.

export type Company = 'oben' | 'colacor' | 'colacor_sc';

/** Status da LEITURA da fonte, atestado pela camada de read (hook). O helper só
 *  calcula com 'ok'/'parcial'; 'indisponivel' (query falhou/RLS/timeout) NÃO é zero. */
export type FonteStatus = 'ok' | 'indisponivel' | 'parcial';

/** Título de recebível ABERTO (status_titulo ∈ {A VENCER, ATRASADO}), já filtrado. */
export interface TituloAberto {
  omie_codigo_cliente: number | null;
  saldo: number;
  atrasado: boolean; // vencido: status_titulo ∈ {ATRASADO, VENCIDO} (lista positiva)
}

export type MotivoConcentracao =
  | 'ok' //            fonte ok/parcial + carteira com linhas válidas
  | 'sem_carteira' //  fonte ok + 0 títulos válidos → zero PROVADO
  | 'fonte_indisponivel' // leitura falhou/RLS/timeout → NÃO é zero, não calcula
  | 'fonte_parcial'; // truncada (cap) ou linha(s) inválida(s) → calcula flagueado

export type ImpactoAbsoluto = 'baixo' | 'moderado' | 'alto';

export interface LinhaExposicao {
  codigo: number;
  saldo: number; //             R$ aberto do código
  vencido: number; //           R$ ATRASADO do código
  pctVencidoProprio: number; // vencido/saldo ∈ [0,1]
  share: number; //             saldo/totalAberto ∈ [0,1]
}

export interface ConcentracaoResult {
  motivo: MotivoConcentracao;
  clientes: number | null; //                 nº de códigos distintos válidos
  totalAberto: number | null; //              0 em sem_carteira; null em indisponivel
  maiorExposicao: number | null; //           R$ do maior código
  top1Pct: number | null;
  top5Pct: number | null;
  c50: number | null; //                      menor nº de códigos que somam ≥50%
  hhi: number | null; //                      SECUNDÁRIO
  nEfetivo: number | null; //                 1/hhi, SECUNDÁRIO
  impactoAbsoluto: ImpactoAbsoluto | null; //  TOM (nunca oculta topN)
  topN: LinhaExposicao[]; //                  [] fora de ok/parcial
  linhasInvalidas: number; //                 saldos/códigos inválidos (dispara fonte_parcial)
}
