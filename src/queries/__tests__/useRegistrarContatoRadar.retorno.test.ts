import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pacote G: o registro manda `p_retorno` só no "em conversa". Se o app novo encontra o banco ANTERIOR à migration
 * 20261111100000 (Publish antes da migration), o PostgREST não acha a assinatura com p_retorno (PGRST202) — o contato
 * não pode se perder por isso: repete sem a data. Qualquer outro erro sobe como antes (sem retry às cegas).
 */
const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { registrarContatoRadar } from '../useRegistrarContatoRadar';

beforeEach(() => { rpc.mockReset(); });

describe('registrarContatoRadar — p_retorno e banco anterior', () => {
  it('manda p_retorno quando há data, e lê nota_gravada/retorno_em', async () => {
    rpc.mockResolvedValueOnce({ data: { id: 'c1', deduped: false, nota_gravada: true, retorno_em: '2026-11-16' }, error: null });
    const r = await registrarContatoRadar({ cnpj: '10100000000101', acao: 'em_conversa', nota: 'x', retorno: '2026-11-16' });
    expect(rpc).toHaveBeenCalledWith('registrar_contato_radar', { p_cnpj: '10100000000101', p_acao: 'em_conversa', p_nota: 'x', p_retorno: '2026-11-16' });
    expect(r).toEqual({ id: 'c1', deduped: false, notaGravada: true, retornoEm: '2026-11-16' });
  });

  it('PGRST202 com data (banco anterior): repete SEM a data e o contato é gravado', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    rpc.mockResolvedValueOnce({ data: { id: 'c2', deduped: false }, error: null });
    const r = await registrarContatoRadar({ cnpj: '10100000000101', acao: 'em_conversa', retorno: '2026-11-16' });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).toEqual({ p_cnpj: '10100000000101', p_acao: 'em_conversa', p_nota: undefined, p_retorno: undefined });
    expect(r).toEqual({ id: 'c2', deduped: false, notaGravada: null, retornoEm: null });
  });

  it('PGRST202 sem data enviada não repete (não é o caso do banco anterior) e o erro sobe', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'x' } });
    await expect(registrarContatoRadar({ cnpj: '10100000000101', acao: 'contatado_sem_resposta' })).rejects.toMatchObject({ code: 'PGRST202' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('outro erro (RD008) sobe sem retry — nada gravado, a ficha avisa', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'RD008', message: 'RADAR_RETORNO_INVALIDO' } });
    await expect(registrarContatoRadar({ cnpj: '10100000000101', acao: 'em_conversa', retorno: '2027-12-31' })).rejects.toMatchObject({ code: 'RD008' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
