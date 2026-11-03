import { describe, expect, it } from 'vitest';
import { REEXECUCOES } from '../reexecutar';
import {
  REEXECUCOES_SYNC_STATE, SLA_SYNC_STATE_H, acaoDaEntidade, entidadesNaoOk, type MarcadorSyncState,
} from '../syncState';

const AGORA = new Date('2026-11-03T15:00:00Z');
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3600 * 1000).toISOString();

/** Todos os pares do `req` saudáveis: só o que o caso muda acende. */
function saudaveis(): MarcadorSyncState[] {
  return Object.keys(SLA_SYNC_STATE_H).map(chave => {
    const [entity_type, account] = chave.split('/');
    return {
      entity_type, account, status: 'complete',
      last_sync_at: horasAtras(1), updated_at: horasAtras(1), created_at: horasAtras(100), error_message: null,
    };
  });
}

function com(chave: string, patch: Partial<MarcadorSyncState>): MarcadorSyncState[] {
  return saudaveis().map(m => (`${m.entity_type}/${m.account}` === chave ? { ...m, ...patch } : m));
}

describe('trava: money-path e identidade nunca ganham botão', () => {
  it('nenhuma chave do catálogo é pedidos_compra* ou customers/*', () => {
    const proibidas = Object.keys(REEXECUCOES_SYNC_STATE)
      .filter(k => k.startsWith('pedidos_compra') || k.startsWith('customers/'));
    expect(proibidas).toEqual([]);
  });

  // 2ª camada, independente do catálogo: casa o MOTIVO, não só "sem botão" — senão a guarda
  // some e o teste segue verde pelo fallback "fora do catálogo" (falsificado em 2026-11-03).
  it('pedidos_compra* e customers/* caem em sem_botao pela guarda própria, mesmo vermelhos e parados', () => {
    for (const [entity_type, account, porque] of [
      ['pedidos_compra', 'oben', 'money-path (compra) — fora do botão'],
      ['pedidos_compra', 'colacor', 'money-path (compra) — fora do botão'],
      ['pedidos_compra_itens', 'oben', 'money-path (compra) — fora do botão'],
      ['customers', 'vendas', 'mexe em identidade — fora do botão'],
      ['customers', 'colacor_vendas', 'mexe em identidade — fora do botão'],
      ['customers', 'servicos', 'mexe em identidade — fora do botão'],
    ]) {
      expect(acaoDaEntidade({ entity_type, account, emAndamento: false })).toEqual({ tipo: 'sem_botao', porque });
    }
  });

  it('o catálogo é exatamente o levantado — entrar entidade nova é decisão que aparece no diff', () => {
    expect(Object.keys(REEXECUCOES_SYNC_STATE).sort()).toEqual([
      'inventory/colacor_vendas', 'inventory/vendas', 'products/colacor_vendas', 'reposicao_estoque_full/oben',
    ]);
  });
});

describe('catálogo REEXECUCOES_SYNC_STATE', () => {
  it('slug do front é saude_dados.reexecutar_sync_state_<entity>_<account> e não colide com a fase 1', () => {
    for (const [chave, r] of Object.entries(REEXECUCOES_SYNC_STATE)) {
      if (r.escritor !== 'front') continue;
      expect(r.acao).toBe(`saude_dados.reexecutar_sync_state_${chave.replace('/', '_')}`);
    }
    const doFront = [...Object.values(REEXECUCOES), ...Object.values(REEXECUCOES_SYNC_STATE)]
      .filter(r => r.escritor === 'front').map(r => r.acao);
    expect(new Set(doFront).size).toBe(doFront.length);
  });

  it('estoque de reposição: a edge grava reposicao.sync_estoque, o front não registra', () => {
    expect(REEXECUCOES_SYNC_STATE['reposicao_estoque_full/oben'])
      .toMatchObject({ escritor: 'edge', acao: 'reposicao.sync_estoque' });
  });

  it('products/colacor_vendas usa o body do cron (max_pages 50)', () => {
    expect(REEXECUCOES_SYNC_STATE['products/colacor_vendas'].alvo).toEqual({
      tipo: 'edge', nome: 'omie-analytics-sync',
      body: { action: 'sync_products', account: 'colacor_vendas', max_pages: 50 },
    });
  });
});

describe('entidadesNaoOk — mesma regra do bloco sync_state_saude do compute', () => {
  it('tudo saudável: lista vazia', () => {
    expect(entidadesNaoOk(saudaveis(), AGORA)).toEqual([]);
  });

  it("'error' de par com SLA, último sucesso dentro do SLA: 1 run perdido, não acende", () => {
    const m = com('inventory/vendas', { status: 'error', last_sync_at: horasAtras(2), updated_at: horasAtras(0.2) });
    expect(entidadesNaoOk(m, AGORA)).toEqual([]);
  });

  it("'error' além do SLA, ou com last_sync_at carimbado no erro, ou par sem SLA: broken", () => {
    const alem = com('inventory/vendas', { status: 'error', last_sync_at: horasAtras(4), updated_at: horasAtras(0.2) });
    expect(entidadesNaoOk(alem, AGORA).map(e => [e.chave, e.grau])).toEqual([['inventory/vendas', 'broken']]);

    const carimbado = com('inventory/vendas', { status: 'error', last_sync_at: horasAtras(0.2), updated_at: horasAtras(0.2) });
    expect(entidadesNaoOk(carimbado, AGORA).map(e => e.chave)).toEqual(['inventory/vendas']);

    const semSla: MarcadorSyncState = {
      entity_type: 'pedidos_compra', account: 'oben', status: 'error',
      last_sync_at: horasAtras(1), updated_at: horasAtras(0.5), created_at: null, error_message: 'x',
    };
    expect(entidadesNaoOk([...saudaveis(), semSla], AGORA).map(e => [e.chave, e.grau, e.motivo]))
      .toEqual([['pedidos_compra/oben', 'broken', 'falhou']]);
  });

  it('running com heartbeat recente: não acende pelo eixo 1, e marca em andamento se o eixo 2 acender', () => {
    const vivo = com('products/colacor_vendas', { status: 'running', updated_at: horasAtras(0.1) });
    expect(entidadesNaoOk(vivo, AGORA)).toEqual([]);

    const vivoMasParado = com('products/colacor_vendas', {
      status: 'running', last_sync_at: horasAtras(40), updated_at: horasAtras(0.1),
    });
    const [e] = entidadesNaoOk(vivoMasParado, AGORA);
    expect(e).toMatchObject({ chave: 'products/colacor_vendas', grau: 'broken', emAndamento: true });
    expect(acaoDaEntidade(e)).toEqual({ tipo: 'em_andamento' });
  });

  it('running órfão (>6h sem heartbeat): broken e com botão, não "em andamento"', () => {
    const orfao = com('inventory/colacor_vendas', { status: 'running', updated_at: horasAtras(7) });
    const [e] = entidadesNaoOk(orfao, AGORA);
    expect(e).toMatchObject({ grau: 'broken', emAndamento: false });
    expect(e.motivo).toMatch(/^preso em running desde /);
    expect(acaoDaEntidade(e).tipo).toBe('botao');
  });

  it("'partial' é stale; marcador ausente do req é broken; par repetido nos 2 eixos sai 1 vez", () => {
    const parcial = com('inventory/vendas', { status: 'partial' });
    expect(entidadesNaoOk(parcial, AGORA).map(e => [e.chave, e.grau])).toEqual([['inventory/vendas', 'stale']]);

    const semMarcador = saudaveis().filter(m => !(m.entity_type === 'reposicao_estoque_full'));
    expect(entidadesNaoOk(semMarcador, AGORA).map(e => [e.chave, e.motivo]))
      .toEqual([['reposicao_estoque_full/oben', 'marcador AUSENTE (nunca rodou)']]);

    // partial (stale, eixo 1) + parado além do SLA (broken, eixo 2): broken vence.
    const dois = com('inventory/vendas', { status: 'partial', last_sync_at: horasAtras(10) });
    expect(entidadesNaoOk(dois, AGORA).map(e => [e.chave, e.grau])).toEqual([['inventory/vendas', 'broken']]);
  });

  it('par fora do req e dormente (complete antigo) não acende', () => {
    const dormente: MarcadorSyncState = {
      entity_type: 'backfill_cadastro', account: 'all', status: 'complete',
      last_sync_at: null, updated_at: horasAtras(3000), created_at: null, error_message: null,
    };
    expect(entidadesNaoOk([...saudaveis(), dormente], AGORA)).toEqual([]);
  });
});
