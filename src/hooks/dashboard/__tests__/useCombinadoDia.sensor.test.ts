import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Sensor do combinado: nunca lança, não grava na lente "Ver como", manda o payload no formato da RPC. */
const { rpc, lente, track } = vi.hoisted(() => ({ rpc: vi.fn(), lente: { ativa: false }, track: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => lente.ativa }));
vi.mock('@/lib/analytics', () => ({ track }));

import { registrarCombinado } from '../useCombinadoDia';

const itens = [
  { tipo: 'recompra' as const, empresa: 'colacor', clienteRef: 'u1', nome: 'Beta', valor: null, detalhe: 'x' },
];

describe('registrarCombinado', () => {
  beforeEach(() => {
    rpc.mockReset();
    track.mockReset();
    lente.ativa = false;
  });

  it('[SENSOR-PAYLOAD] chama combinado_registrar com cliente_ref e valor null preservado', async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    expect(await registrarCombinado('R', itens)).toBe(true);
    expect(rpc).toHaveBeenCalledWith('combinado_registrar', {
      p_vendedora: 'R',
      p_itens: [{ tipo: 'recompra', empresa: 'colacor', cliente_ref: 'u1', nome: 'Beta', valor: null }],
    });
  });

  it('[SENSOR-LENTE] na lente "Ver como" não grava', async () => {
    lente.ativa = true;
    expect(await registrarCombinado('R', itens)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('[SENSOR-ERRO] erro do PostgREST não lança: devolve false e registra o motivo', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'forbidden: combinado_registrar exige master', code: '42501' } });
    expect(await registrarCombinado('R', itens)).toBe(false);
    expect(track).toHaveBeenCalledWith('meu_dia.combinado_sensor_falhou', {
      motivo: 'forbidden: combinado_registrar exige master',
    });
  });
});
