import { describe, expect, it } from 'vitest';
import { frescorEstoque, interpretarRespostaSyncEstoque } from '../shared';

// Âncora fixa pra não depender do relógio da máquina.
const AGORA = new Date('2026-07-02T20:00:00-03:00');
const antes = (horas: number) => new Date(AGORA.getTime() - horas * 3_600_000).toISOString();

describe('frescorEstoque — badge de frescor do snapshot de estoque', () => {
  it('sem sync registrado → error e rótulo honesto (nunca ≠ há 0h)', () => {
    expect(frescorEstoque(null, AGORA)).toEqual({ tone: 'error', label: 'estoque nunca sincronizado' });
    expect(frescorEstoque(undefined, AGORA)).toEqual({ tone: 'error', label: 'estoque nunca sincronizado' });
  });

  it('timestamp inválido é tratado como ausente (não vira NaN no rótulo)', () => {
    expect(frescorEstoque('não-é-data', AGORA)).toEqual({ tone: 'error', label: 'estoque nunca sincronizado' });
  });

  it('fresco (≤4h, cadência intraday 2h com 1 janela de folga) → ok', () => {
    expect(frescorEstoque(antes(0.5), AGORA)).toEqual({ tone: 'ok', label: 'sincronizado há menos de 1h' });
    expect(frescorEstoque(antes(3), AGORA)).toEqual({ tone: 'ok', label: 'sincronizado há 3h' });
    expect(frescorEstoque(antes(4), AGORA)).toEqual({ tone: 'ok', label: 'sincronizado há 4h' });
  });

  it('duas janelas intraday perdidas (>4h) → warning (inclui a madrugada, honesto: o dado ESTÁ velho)', () => {
    expect(frescorEstoque(antes(4.5), AGORA)).toEqual({ tone: 'warning', label: 'sincronizado há 4h' });
    expect(frescorEstoque(antes(13), AGORA)).toEqual({ tone: 'warning', label: 'sincronizado há 13h' });
  });

  it('até o cron diário falhou (>24h) → error, rótulo em dias (o incidente de 2 dias que motivou o badge)', () => {
    expect(frescorEstoque(antes(30), AGORA)).toEqual({ tone: 'error', label: 'sincronizado há 1 dia' });
    expect(frescorEstoque(antes(49), AGORA)).toEqual({ tone: 'error', label: 'sincronizado há 2 dias' });
  });
});

describe('interpretarRespostaSyncEstoque — toast do botão "Sincronizar estoque"', () => {
  it('sucesso limpo → success com contagem e duração', () => {
    const r = interpretarRespostaSyncEstoque({ ok: true, sincronizados: 448, nao_encontrados: 0, erros_upsert: 0, total_skus_esperados: 448, duracao_ms: 74_200 });
    expect(r.tone).toBe('success');
    expect(r.message).toBe('Estoque sincronizado: 448 SKUs atualizados em 74s');
  });

  it('sucesso com SKUs não encontrados no Omie → success, mas diz quantos ficaram de fora', () => {
    const r = interpretarRespostaSyncEstoque({ ok: true, sincronizados: 440, nao_encontrados: 8, erros_upsert: 0, total_skus_esperados: 448, duracao_ms: 60_000 });
    expect(r.tone).toBe('success');
    expect(r.message).toBe('Estoque sincronizado: 440 SKUs atualizados em 60s (8 não encontrados no Omie)');
  });

  it('erros de gravação → warning (sincronizou parcial, não mascarar)', () => {
    const r = interpretarRespostaSyncEstoque({ ok: true, sincronizados: 400, nao_encontrados: 0, erros_upsert: 48, total_skus_esperados: 448, duracao_ms: 80_000 });
    expect(r.tone).toBe('warning');
    expect(r.message).toBe('Estoque sincronizado com ressalvas: 400 SKUs atualizados, 48 erro(s) de gravação');
  });

  it('nenhum SKU habilitado (early-return da edge) → info com a mensagem da edge', () => {
    const r = interpretarRespostaSyncEstoque({ ok: true, total_skus_esperados: 0, mensagem: 'Nenhum SKU habilitado, nada a sincronizar.' });
    expect(r.tone).toBe('info');
    expect(r.message).toBe('Nenhum SKU habilitado, nada a sincronizar.');
  });

  it('resposta não-ok ou vazia → error (nunca fingir sucesso)', () => {
    expect(interpretarRespostaSyncEstoque({ ok: false, error: 'Erro lendo sku_parametros: timeout' })).toEqual({
      tone: 'error',
      message: 'Sync de estoque falhou: Erro lendo sku_parametros: timeout',
    });
    expect(interpretarRespostaSyncEstoque(null)).toEqual({ tone: 'error', message: 'Sync de estoque falhou: resposta vazia da edge' });
    expect(interpretarRespostaSyncEstoque(undefined)).toEqual({ tone: 'error', message: 'Sync de estoque falhou: resposta vazia da edge' });
  });
});
