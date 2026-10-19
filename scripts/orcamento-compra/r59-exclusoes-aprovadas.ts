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

// VAZIA de propósito (2026-10-19): nenhum cancelamento foi aprovado EXPLICITAMENTE para sair do caixa. 1014/1049
// são os casos que motivaram o R59 e os controles positivos da passada, mas o #3132 os cita como diagnóstico, não
// como autorização (Codex 2026-10-19 P2). Copie a entrada de `pendentesR59` + a evidência do portal/Omie.
export const EXCLUSOES_R59_APROVADAS: readonly ExclusaoR59Aprovada[] = [];
