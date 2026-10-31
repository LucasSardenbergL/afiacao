import type { DataHealthCheck } from './types';

/**
 * Botão "Re-executar" da /gestao/saude-dados — FASE 1 (clique humano, não remediador automático).
 *
 * Só entra aqui check cuja correção é re-disparar o MESMO job idempotente que o cron já roda,
 * fora do money-path, e que o JWT staff consegue disparar hoje sem migration nem mudança de edge
 * (levantamento de 2026-10-31). Ficam FORA de propósito:
 *  - money-path (financeiro, pedidos, custos, compra, preço tint): exige /codex + prove-sql antes;
 *  - correção humana (portal Sayerlack, cadastro no Omie, identidade, credencial/secret);
 *  - radar_recruzamento_tick e omie_tipo_produto_oben: sem caminho staff hoje (RPC só
 *    service_role / edge `authorizeCron`);
 *  - vendas_cadastros e sync_state_saude: a ação depende de QUAL entidade está vermelha.
 *
 * O clique nunca mexe no check: ele só volta a `ok` quando o compute ler a fonte fresca.
 * O ledger `acoes_execucoes` (slug abaixo) é o sensor da fase 1 — quantas vezes se clicou e se curou.
 */
export interface Reexecucao {
  rotulo: string;
  /** Slug de `acoes_execucoes` lido pela caption <UltimaExecucao>. */
  acao: string;
  /** Quem grava o slug. 1 escritor por slug: se a edge já grava (comRegistro), o front só lê. */
  escritor: 'front' | 'edge';
  alvo:
    | { tipo: 'rpc'; nome: 'request_customer_metrics_refresh' }
    | { tipo: 'edge'; nome: string; body?: Record<string, string> };
}

export const REEXECUCOES: Readonly<Record<string, Reexecucao>> = {
  customer_metrics: {
    rotulo: 'Recalcular métricas de clientes',
    acao: 'saude_dados.reexecutar_customer_metrics',
    escritor: 'front',
    alvo: { tipo: 'rpc', nome: 'request_customer_metrics_refresh' },
  },
  carteira_scores: {
    rotulo: 'Recalcular scores da carteira',
    acao: 'saude_dados.reexecutar_carteira_scores',
    escritor: 'front',
    alvo: { tipo: 'edge', nome: 'calculate-scores' },
  },
  carteira_rebuild: {
    rotulo: 'Reconstruir carteira',
    acao: 'saude_dados.reexecutar_carteira_rebuild',
    escritor: 'front',
    alvo: { tipo: 'edge', nome: 'carteira-rebuild' },
  },
  estoque_inventario: {
    rotulo: 'Sincronizar inventário (OBEN)',
    acao: 'saude_dados.reexecutar_estoque_inventario',
    escritor: 'front',
    alvo: { tipo: 'edge', nome: 'omie-analytics-sync', body: { action: 'sync_inventory', account: 'vendas' } },
  },
  // A edge grava `reposicao.sync_estoque` (staff → origem manual) — o front não abre um 2º registro.
  estoque_reposicao: {
    rotulo: 'Sincronizar estoque de reposição (OBEN)',
    acao: 'reposicao.sync_estoque',
    escritor: 'edge',
    alvo: { tipo: 'edge', nome: 'omie-sync-estoque', body: { empresa: 'OBEN' } },
  },
};

/** Re-execução oferecida para o check, ou null (check ok, ou fora do catálogo). */
export function reexecucaoDoCheck(check: Pick<DataHealthCheck, 'source' | 'status'>): Reexecucao | null {
  if (check.status === 'ok') return null;
  return Object.prototype.hasOwnProperty.call(REEXECUCOES, check.source) ? REEXECUCOES[check.source] : null;
}

export type DesfechoReexecucao = 'disparado' | 'em_andamento';

/** calculate-scores responde 200 `{skipped:true}` quando o lease está ocupado: nada rodou. */
export function desfechoDaResposta(data: unknown): DesfechoReexecucao {
  if (data && typeof data === 'object' && (data as { skipped?: unknown }).skipped === true) return 'em_andamento';
  return 'disparado';
}

/** carteira-rebuild responde 409 com o lease ocupado: não é falha, mas também não rodou nada. */
export function desfechoDoErro(erro: unknown): DesfechoReexecucao | null {
  return (erro as { status?: unknown } | null)?.status === 409 ? 'em_andamento' : null;
}
