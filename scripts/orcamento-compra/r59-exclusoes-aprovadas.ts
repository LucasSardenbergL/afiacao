// scripts/orcamento-compra/r59-exclusoes-aprovadas.ts — R59 v2 (2026-10-19): o que pode sair do caixa por
// "encerrado no Omie sem NF". 1 escritor: PR revisado. Fora daqui, o candidato FICA no caixa e sai listado em
// `pendentesR59` para revisão.
//
// Por quê: medido em prod (passada de encerrados v1.8, disparo #542), o filtro só-encerrados do Omie devolve o
// ciclo CONCLUÍDO (520 de 549 pedidos), não só o cancelado sem NF; e o `foraDoCaixa` tem cegueira conhecida (NF
// de vários pedidos gravada na linha de OUTRO pedido antes de 2026-10-18 não é vista — Codex 2026-10-19 P1). A
// fração da carteira deixou de ser a guarda; a contenção é cada exclusão nomeada e conferida no portal/Omie.
//
// Casa por `disparado_id` (pedido_compra_sugerido.id) E `omie_pedido` (nCodPed): a aprovação fica presa à
// identidade revisada. Entrada nova = evidência do cancelamento no fornecedor (sem reenvio, sem NF).

export interface ExclusaoR59Aprovada {
  disparado_id: number;
  omie_pedido: string;
  /** protocolo + cContrato(s) revisados, como `pendentesR59` os lista; conjunto diferente hoje = revisar de novo */
  identificadores: readonly string[];
  numero: string;
  evidencia: string;
  aprovado_por: string;
  aprovado_em: string;
}

// 2026-10-19: o founder conferiu no portal Sayerlack cada identificador dos 4 candidatos que a passada de encerrados
// (v1.8, disparo #542) e o backtest apontaram. Entram os 3 CANCELADOS. Ficou de fora o 1230 (2790/12184846749):
// 2130311 e 2130322 estão "Atendido total" — houve faturamento que o backtest NÃO enxerga (NF consolidada de
// vários pedidos gravada na linha de outro, a cegueira do Codex 2026-10-19 P1). Ele segue no caixa, como pendente.
const CONFERENCIA = 'founder (Lucas) — conferência no portal Sayerlack, 2026-10-19';

export const EXCLUSOES_R59_APROVADAS: readonly ExclusaoR59Aprovada[] = [
  {
    disparado_id: 80, omie_pedido: '12087313479', numero: '1005', identificadores: ['2096768', 'AFI26050780'],
    evidencia: '2096768 cancelado na Sayerlack; AFI26050780 é o código interno do próprio disparado (AFI + 26-05-07 + id 80, cCodIntPed AFI-80), presente só neste pedido',
    aprovado_por: CONFERENCIA, aprovado_em: '2026-10-19',
  },
  {
    disparado_id: 91, omie_pedido: '12096301530', numero: '1014', identificadores: ['2093559', '2096771'],
    evidencia: '2093559 e 2096771 (original e reenvio) cancelados na Sayerlack',
    aprovado_por: CONFERENCIA, aprovado_em: '2026-10-19',
  },
  {
    disparado_id: 194, omie_pedido: '12098830141', numero: '1049', identificadores: ['2094968'],
    evidencia: '2094968 cancelado na Sayerlack',
    aprovado_por: CONFERENCIA, aprovado_em: '2026-10-19',
  },
];
