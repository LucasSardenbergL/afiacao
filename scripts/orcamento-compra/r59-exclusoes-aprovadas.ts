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
  numero: string;
  evidencia: string;
  aprovado_por: string;
  aprovado_em: string;
}

export const EXCLUSOES_R59_APROVADAS: readonly ExclusaoR59Aprovada[] = [
  {
    disparado_id: 91, omie_pedido: '12096301530', numero: '1014',
    evidencia: 'cancelado no portal Sayerlack — caso que motivou o R59 (docs/historico/orcamento-compra-v1.md, #3132); controle positivo da passada v1.8',
    aprovado_por: 'founder (#3132)', aprovado_em: '2026-10-18',
  },
  {
    disparado_id: 194, omie_pedido: '12098830141', numero: '1049',
    evidencia: 'cancelado no portal Sayerlack — caso que motivou o R59 (docs/historico/orcamento-compra-v1.md, #3132); controle positivo da passada v1.8',
    aprovado_por: 'founder (#3132)', aprovado_em: '2026-10-18',
  },
];
