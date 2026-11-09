import { describe, expect, it } from 'vitest';
import { REEXECUCOES, desfechoDaResposta, desfechoDoErro, reexecucaoDoCheck } from '../reexecutar';

// Checks money-path ou de correção humana (levantamento 2026-10-31). Nenhum pode ganhar botão
// sem passar pelo ritual /codex + prove-sql — este teste é o lembrete no diff.
const FORA_DO_BOTAO = [
  'saldo_bancario', 'contas_receber', 'contas_pagar', 'omie_sync_financeiro', 'vendas_pedidos',
  'reposicao_sugestoes', 'custos_produtos', 'pedidos_compra_sync', 'tint_cobertura_bases',
  'vendas_empurradas_sem_gemeo', 'reposicao_disparo', 'reposicao_portal_humano',
  'reposicao_portal_pipeline', 'reposicao_sayerlack_fabricado', 'custos_proxy_conf_alta',
  'custos_product_cost_revivido', 'tint_vinculo_omie', 'vendas_familia_ausente', 'alert_channel',
  'carteira_identidade_quarentena', 'analytics_outbox_transporte', 'analytics_outbox_trigger',
  'sync_reprocess_saude', 'radar_lote_idade',
];

describe('reexecucaoDoCheck', () => {
  it('check ok não oferece botão — re-executar o que está verde só gasta cota do Omie', () => {
    expect(reexecucaoDoCheck({ source: 'customer_metrics', status: 'ok' })).toBeNull();
  });

  it('stale, broken e unknown oferecem a re-execução do catálogo', () => {
    for (const status of ['stale', 'broken', 'unknown'] as const) {
      expect(reexecucaoDoCheck({ source: 'carteira_rebuild', status })?.alvo).toEqual({ tipo: 'edge', nome: 'carteira-rebuild' });
    }
  });

  it('source fora do catálogo (inclusive chave herdada do Object) não oferece botão', () => {
    expect(reexecucaoDoCheck({ source: 'saldo_bancario', status: 'broken' })).toBeNull();
    expect(reexecucaoDoCheck({ source: 'constructor', status: 'broken' })).toBeNull();
  });
});

describe('catálogo REEXECUCOES', () => {
  it('nenhum check money-path ou de correção humana tem botão', () => {
    expect(FORA_DO_BOTAO.filter(s => Object.prototype.hasOwnProperty.call(REEXECUCOES, s))).toEqual([]);
  });

  it('slug escrito pelo front é saude_dados.* e único; o da edge é o que a edge grava', () => {
    const doFront = Object.values(REEXECUCOES).filter(r => r.escritor === 'front').map(r => r.acao);
    expect(doFront.every(a => a.startsWith('saude_dados.reexecutar_'))).toBe(true);
    expect(new Set(doFront).size).toBe(doFront.length);
    expect(REEXECUCOES.estoque_reposicao).toMatchObject({ escritor: 'edge', acao: 'reposicao.sync_estoque' });
  });
});

describe('desfecho do disparo', () => {
  it('200 {skipped:true} (lease ocupado do calculate-scores) é em_andamento, não sucesso', () => {
    expect(desfechoDaResposta({ skipped: true })).toBe('em_andamento');
    expect(desfechoDaResposta({ skipped: 'true' })).toBe('disparado');
    expect(desfechoDaResposta({ ok: true })).toBe('disparado');
    expect(desfechoDaResposta(null)).toBe('disparado');
  });

  it('409 (lease ocupado do carteira-rebuild) é em_andamento; outro erro segue erro', () => {
    expect(desfechoDoErro({ status: 409 })).toBe('em_andamento');
    expect(desfechoDoErro({ status: 500 })).toBeNull();
    expect(desfechoDoErro(new Error('x'))).toBeNull();
    expect(desfechoDoErro(null)).toBeNull();
  });
});
