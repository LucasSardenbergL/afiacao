import type { Reexecucao } from './reexecutar';

/**
 * Re-executar POR ENTIDADE no card `sync_state_saude` da /gestao/saude-dados (extensão da fase 1).
 *
 * O check é UMA linha agregada (o watchdog exige source único), então o botão não pode ser do
 * check — depende de QUAL `(entity_type, account)` está não-ok. A lista vem de `sync_state` lida
 * pelo front (RLS "Staff can manage sync state"), classificada pela MESMA regra do bloco
 * `sync_state_saude` de `_data_health_compute` (lido em prod via pg_get_functiondef, 2026-11-03).
 * Nunca parse da `message`: ela é texto para gente e muda de forma.
 *
 * O compute continua sendo a fonte da verdade da COR do card. Se este espelho ficar para trás
 * (par novo no `req`, regra nova), o card segue vermelho e a lista por entidade sai incompleta —
 * a tela avisa quando o card está vermelho e o front não acha entidade nenhuma.
 */
export interface MarcadorSyncState {
  entity_type: string;
  account: string;
  status: string | null;
  last_sync_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  error_message: string | null;
}

/** Espelho da CTE `req(et, acc, sla_h)`: pares com cron dedicado e SLA em horas (eixo 2). */
export const SLA_SYNC_STATE_H: Readonly<Record<string, number>> = {
  'customers/vendas': 30,
  'customers/colacor_vendas': 30,
  'customers/servicos': 30,
  'products_metadados/oben': 30,
  'products_metadados/colacor': 30,
  'products/colacor_vendas': 30,
  'inventory/vendas': 3,
  'inventory/colacor_vendas': 6,
  'inventory/servicos': 6,
  'reposicao_estoque_full/oben': 16,
};

/** `running` sem heartbeat (updated_at) há mais que isto é órfão no compute; abaixo, é run vivo. */
const RUNNING_ORFAO_MS = 6 * 3600 * 1000;

export interface EntidadeNaoOk {
  chave: string;
  entity_type: string;
  account: string;
  grau: 'broken' | 'stale';
  motivo: string;
  /** `running` com heartbeat recente: há um run vivo — o botão vira "já em andamento". */
  emAndamento: boolean;
  error_message: string | null;
}

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

const dataBR = (t: number) =>
  new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });

interface Candidato extends Omit<EntidadeNaoOk, 'chave' | 'emAndamento'> { eixo: 1 | 2 }

/** EIXO 1 — o próprio sync declarando a falha (tabela inteira, com ou sem SLA). */
function eixo1(m: MarcadorSyncState, agora: number): Candidato | null {
  const sla = SLA_SYNC_STATE_H[`${m.entity_type}/${m.account}`];
  const ultimo = ms(m.last_sync_at);
  const base = ms(m.updated_at) ?? ms(m.created_at);
  const comum = { entity_type: m.entity_type, account: m.account, error_message: m.error_message, eixo: 1 as const };
  if (m.status === 'error') {
    // 'error' de par com SLA só é PARADO quando o último sucesso saiu do SLA (1 run perdido o
    // próximo ciclo cura) — ou quando o writer carimbou last_sync_at no próprio erro (fail-closed).
    const parado = sla === undefined
      || ultimo === null
      || (base !== null && ultimo >= base - 60_000)
      || agora - ultimo > sla * 3600 * 1000;
    return parado ? { ...comum, grau: 'broken', motivo: 'falhou' } : null;
  }
  if (m.status === 'running') {
    if (base === null || agora - base <= RUNNING_ORFAO_MS) return null;
    return { ...comum, grau: 'broken', motivo: `preso em running desde ${dataBR(base)}` };
  }
  if (m.status === 'partial') return { ...comum, grau: 'stale', motivo: 'coleta parcial' };
  return null;
}

/** EIXO 2 — last_sync_at que não avança, só nos pares com cadência conhecida. */
function eixo2(chave: string, slaH: number, m: MarcadorSyncState | undefined, agora: number): Candidato | null {
  const [entity_type, account] = chave.split('/');
  const comum = { entity_type, account, error_message: m?.error_message ?? null, eixo: 2 as const };
  if (!m) return { ...comum, grau: 'broken', motivo: 'marcador AUSENTE (nunca rodou)' };
  const ultimo = ms(m.last_sync_at);
  if (ultimo === null) return { ...comum, grau: 'broken', motivo: 'nunca sincronizou' };
  if (agora - ultimo > slaH * 3600 * 1000) return { ...comum, grau: 'broken', motivo: `sem sucesso desde ${dataBR(ultimo)}` };
  return null;
}

/** Entidades não-ok pela regra do compute, 1 por par (broken vence; empate → eixo 1). */
export function entidadesNaoOk(marcadores: readonly MarcadorSyncState[], agora: Date): EntidadeNaoOk[] {
  const t = agora.getTime();
  const porChave = new Map(marcadores.map(m => [`${m.entity_type}/${m.account}`, m]));
  const candidatos: Candidato[] = [
    ...marcadores.map(m => eixo1(m, t)),
    ...Object.entries(SLA_SYNC_STATE_H).map(([chave, sla]) => eixo2(chave, sla, porChave.get(chave), t)),
  ].filter((c): c is Candidato => c !== null);

  const escolhido = new Map<string, Candidato>();
  for (const c of candidatos) {
    const chave = `${c.entity_type}/${c.account}`;
    const atual = escolhido.get(chave);
    const melhor = !atual
      || (c.grau === 'broken' && atual.grau !== 'broken')
      || (c.grau === atual.grau && c.eixo < atual.eixo);
    if (melhor) escolhido.set(chave, c);
  }

  return [...escolhido.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([chave, { eixo: _eixo, ...c }]) => {
      const m = porChave.get(chave);
      const base = m ? ms(m.updated_at) ?? ms(m.created_at) : null;
      const emAndamento = m?.status === 'running' && base !== null && t - base <= RUNNING_ORFAO_MS;
      return { ...c, chave, emAndamento };
    });
}

/**
 * Entidades com botão: re-disparam o MESMO job do cron (mesmo body), fora do money-path, e o JWT
 * staff já passa no gate da edge (`authorizeCronOrStaff` / staff na omie-sync-estoque).
 * FORA de propósito — o teste trava:
 *  - `pedidos_compra*`: money-path (compra) — exige /codex + prove-sql antes de qualquer botão;
 *  - `customers/*`: mexe em identidade (profiles/aliases fiscais) e `sync_customers` responde 202
 *    (aceito em background, nada concluído no clique);
 *  - `products_metadados/*`, `inventory/servicos` e o resto: fora do levantamento de 2026-11-03.
 * Slug do front: `saude_dados.reexecutar_sync_state_<entity>_<account>` (1 escritor por slug). A
 * `omie-sync-estoque` já grava `reposicao.sync_estoque` server-side: o front só lê esse slug.
 */
export const REEXECUCOES_SYNC_STATE: Readonly<Record<string, Reexecucao>> = {
  'inventory/vendas': {
    rotulo: 'Sincronizar inventário (OBEN)',
    acao: 'saude_dados.reexecutar_sync_state_inventory_vendas',
    escritor: 'front',
    alvo: { tipo: 'edge', nome: 'omie-analytics-sync', body: { action: 'sync_inventory', account: 'vendas' } },
  },
  'inventory/colacor_vendas': {
    rotulo: 'Sincronizar inventário (Colacor)',
    acao: 'saude_dados.reexecutar_sync_state_inventory_colacor_vendas',
    escritor: 'front',
    alvo: { tipo: 'edge', nome: 'omie-analytics-sync', body: { action: 'sync_inventory', account: 'colacor_vendas' } },
  },
  // Body idêntico ao do cron sync-colacor-vendas-products (max_pages 50).
  'products/colacor_vendas': {
    rotulo: 'Sincronizar produtos (Colacor)',
    acao: 'saude_dados.reexecutar_sync_state_products_colacor_vendas',
    escritor: 'front',
    alvo: {
      tipo: 'edge', nome: 'omie-analytics-sync',
      body: { action: 'sync_products', account: 'colacor_vendas', max_pages: 50 },
    },
  },
  'reposicao_estoque_full/oben': {
    rotulo: 'Sincronizar estoque de reposição (OBEN)',
    acao: 'reposicao.sync_estoque',
    escritor: 'edge',
    alvo: { tipo: 'edge', nome: 'omie-sync-estoque', body: { empresa: 'OBEN' } },
  },
};

type AcaoDaEntidade =
  | { tipo: 'botao'; r: Reexecucao }
  | { tipo: 'em_andamento' }
  | { tipo: 'sem_botao'; porque: string };

/** O que o card oferece para a entidade: botão, "já em andamento" (sem disparar) ou o porquê de não ter. */
export function acaoDaEntidade(e: Pick<EntidadeNaoOk, 'entity_type' | 'account' | 'emAndamento'>): AcaoDaEntidade {
  if (e.entity_type.startsWith('pedidos_compra')) return { tipo: 'sem_botao', porque: 'money-path (compra) — fora do botão' };
  if (e.entity_type === 'customers') return { tipo: 'sem_botao', porque: 'mexe em identidade — fora do botão' };
  const chave = `${e.entity_type}/${e.account}`;
  if (!Object.prototype.hasOwnProperty.call(REEXECUCOES_SYNC_STATE, chave)) {
    return { tipo: 'sem_botao', porque: 'sem re-execução por aqui' };
  }
  if (e.emAndamento) return { tipo: 'em_andamento' };
  return { tipo: 'botao', r: REEXECUCOES_SYNC_STATE[chave] };
}
