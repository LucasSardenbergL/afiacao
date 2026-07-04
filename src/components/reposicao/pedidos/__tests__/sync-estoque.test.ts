import { describe, expect, it } from 'vitest';
import { edgeSyncOk, frescorEstoque, resumoSyncRecalc } from '../shared';

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

// O botão dispara as 2 edges via supabase.functions.invoke, que devolve {data, error}. Uma edge só
// contou como sucesso se o invoke NÃO falhou (rede/HTTP) E o corpo trouxe {ok:true}. HTTP 200 com
// {ok:false}/{error} é falha LÓGICA — não pode virar sucesso (senão o toast mente: "sincronizado"
// quando não foi). Ambas as edges (omie-sync-estoque / omie-sync-status-produtos) retornam {ok}.
describe('edgeSyncOk — sucesso real de uma edge de sync', () => {
  it('invoke ok + corpo {ok:true} → true', () => {
    expect(edgeSyncOk({ status: 'fulfilled', value: { data: { ok: true }, error: null } })).toBe(true);
  });

  it('HTTP 200 mas corpo {ok:false} → false (falha lógica NÃO vira sucesso)', () => {
    expect(edgeSyncOk({ status: 'fulfilled', value: { data: { ok: false, error: 'x' }, error: null } })).toBe(false);
  });

  it('corpo {error} sem ok (erro de validação da edge) → false', () => {
    expect(edgeSyncOk({ status: 'fulfilled', value: { data: { error: 'empresa inválida' }, error: null } })).toBe(false);
  });

  it('erro do invoke (rede/HTTP) → false, mesmo que data tenha vindo', () => {
    expect(edgeSyncOk({ status: 'fulfilled', value: { data: { ok: true }, error: { message: 'network' } } })).toBe(false);
  });

  it('promessa rejeitada → false', () => {
    expect(edgeSyncOk({ status: 'rejected' })).toBe(false);
  });

  it('data null/ausente → false', () => {
    expect(edgeSyncOk({ status: 'fulfilled', value: { data: null, error: null } })).toBe(false);
  });
});

// O botão "Sincronizar Omie" dispara DUAS edges (saldo: omie-sync-estoque · status ativo/inativo:
// omie-sync-status-produtos) em paralelo. resumoSyncOmie agrega o toast — falha parcial NÃO vira
// sucesso, e o sucesso lembra de recalcular (a sync não mexe em pedido já gerado).
// Botão "Sincronizar e recalcular": sincroniza Omie (saldo+status) e, SÓ SE ambas deram certo,
// recalcula. Se a sync falhar, NÃO recalcula (senão regeneraria o ciclo com dado velho = money-path).
describe('resumoSyncRecalc — toast do botão "Sincronizar e recalcular"', () => {
  it('sync ok + recálculo ok → success com nº de pedidos', () => {
    const r = resumoSyncRecalc(true, true, { ok: true, pedidos: 3 });
    expect(r.tone).toBe('success');
    expect(r.message).toMatch(/3 pedidos/);
  });

  it('1 pedido → singular', () => {
    expect(resumoSyncRecalc(true, true, { ok: true, pedidos: 1 }).message).toMatch(/1 pedido\b/);
  });

  it('0 pedidos → plural, ainda success', () => {
    const r = resumoSyncRecalc(true, true, { ok: true, pedidos: 0 });
    expect(r.tone).toBe('success');
    expect(r.message).toMatch(/0 pedidos/);
  });

  it('sync ok mas recálculo falhou → warning, manda usar Recalcular', () => {
    const r = resumoSyncRecalc(true, true, { ok: false, pedidos: 0 });
    expect(r.tone).toBe('warning');
    expect(r.message).toMatch(/recalcul/i);
  });

  it('recálculo falhou COM motivo → warning inclui o erro (não achatar — Codex)', () => {
    const r = resumoSyncRecalc(true, true, { ok: false, pedidos: 0, erro: 'deadlock detected' });
    expect(r.tone).toBe('warning');
    expect(r.message).toMatch(/deadlock detected/);
  });

  it('sync ok mas recálculo nem rodou (null) → warning', () => {
    expect(resumoSyncRecalc(true, true, null).tone).toBe('warning');
  });

  it('estoque falhou → warning, NÃO recalculou (money-path: não regenera com dado velho)', () => {
    const r = resumoSyncRecalc(false, true, null);
    expect(r.tone).toBe('warning');
    expect(r.message).toMatch(/estoque/i);
    expect(r.message).toMatch(/não recalcul/i);
  });

  it('status falhou → warning, NÃO recalculou', () => {
    const r = resumoSyncRecalc(true, false, null);
    expect(r.tone).toBe('warning');
    expect(r.message).toMatch(/status/i);
    expect(r.message).toMatch(/não recalcul/i);
  });

  it('ambas falham → error, NÃO recalculou', () => {
    const r = resumoSyncRecalc(false, false, null);
    expect(r.tone).toBe('error');
    expect(r.message).toMatch(/não recalcul/i);
  });
});
