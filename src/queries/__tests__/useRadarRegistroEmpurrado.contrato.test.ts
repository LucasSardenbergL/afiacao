import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Radar H — contrato dos sensores do lead empurrado: NUNCA rejeitam; devolvem sucesso/falha; falha transitória é
 * tentada 3 vezes; a que sobra vai para track() + ledger (radar_registrar_falha_sensor). Lente: nada é chamado.
 */
type Resp = { data: unknown; error: unknown };
const respostas: Array<Resp | Error> = [];
const rpc = vi.fn((_n: string, _a?: unknown): Promise<Resp> => {
  const r = respostas.shift() ?? { data: { ok: true, registrado: true }, error: null };
  return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a?: unknown) => rpc(n, a) } }));
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));
let lente = false;
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => lente }));

import {
  registrarAberturaEmpurrada,
  registrarCardServido,
  registrarFichaEntregue,
} from '../useRadarRegistroEmpurrado';

const chamadas = (nome: string) => rpc.mock.calls.filter((c) => c[0] === nome);

beforeEach(() => {
  respostas.length = 0;
  rpc.mockClear();
  track.mockClear();
  lente = false;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useRadarRegistroEmpurrado — contrato', () => {
  it('sucesso devolve ok:true e não registra falha', async () => {
    await expect(registrarCardServido(3)).resolves.toEqual({ ok: true, registrado: true });
    expect(chamadas('radar_registrar_card_servido')).toEqual([['radar_registrar_card_servido', { p_n_leads: 3 }]]);
    expect(chamadas('radar_registrar_falha_sensor')).toHaveLength(0);
    expect(track).not.toHaveBeenCalled();
  });

  it('erro permanente: 1 tentativa, devolve a falha (não rejeita) e registra no ledger + track', async () => {
    respostas.push({ data: null, error: { code: '42501', message: 'forbidden' } });
    await expect(registrarAberturaEmpurrada({ origem: 'card', cnpj: 'X' })).resolves.toEqual({
      ok: false, motivo: 'sem_acesso', transitorio: false,
    });
    expect(chamadas('radar_registrar_abertura_empurrada')).toHaveLength(1);
    expect(chamadas('radar_registrar_falha_sensor')).toEqual([
      ['radar_registrar_falha_sensor', { p_sensor: 'abertura_card', p_motivo: 'sem_acesso' }],
    ]);
    expect(track).toHaveBeenCalledWith('radar.sensor_falhou', { sensor: 'abertura_card', motivo: 'sem_acesso', tentativas: 1 });
  });

  it('ok:false do servidor (link desconhecido) é falha do sensor do e-mail', async () => {
    respostas.push({ data: { ok: false, motivo: 'link_desconhecido' }, error: null });
    const r = await registrarAberturaEmpurrada({ origem: 'email', cnpj: 'X', envio: 'E' });
    expect(r).toEqual({ ok: false, motivo: 'link_desconhecido', transitorio: false });
    expect(chamadas('radar_registrar_abertura_empurrada')[0][1]).toEqual({ p_origem: 'email', p_cnpj: 'X', p_envio: 'E' });
    expect(chamadas('radar_registrar_falha_sensor')[0][1]).toEqual({ p_sensor: 'abertura_email', p_motivo: 'link_desconhecido' });
  });

  it('falha transitória é tentada de novo e, se recuperar, não registra falha', async () => {
    vi.useFakeTimers();
    respostas.push(new TypeError('Failed to fetch'), { data: null, error: { code: '57014' } });
    const p = registrarFichaEntregue({ origem: 'email', cnpj: 'X', envio: 'E' });
    await vi.advanceTimersByTimeAsync(400 + 1200);
    await expect(p).resolves.toEqual({ ok: true, registrado: true });
    expect(chamadas('radar_registrar_ficha_entregue')).toHaveLength(3);
    expect(chamadas('radar_registrar_falha_sensor')).toHaveLength(0);
  });

  it('falha transitória que não passa: 3 tentativas e falha registrada com o nº de tentativas', async () => {
    vi.useFakeTimers();
    respostas.push(new TypeError('x'), new TypeError('x'), new TypeError('x'));
    const p = registrarFichaEntregue({ origem: 'card', cnpj: 'X' });
    await vi.advanceTimersByTimeAsync(400 + 1200);
    await expect(p).resolves.toEqual({ ok: false, motivo: 'rede', transitorio: true });
    expect(chamadas('radar_registrar_ficha_entregue')).toHaveLength(3);
    expect(track).toHaveBeenCalledWith('radar.sensor_falhou', { sensor: 'ficha_card', motivo: 'rede', tentativas: 3 });
    expect(chamadas('radar_registrar_falha_sensor')[0][1]).toEqual({ p_sensor: 'ficha_card', p_motivo: 'rede' });
  });

  it('lente "Ver como": não chama nada e devolve motivo lente', async () => {
    lente = true;
    await expect(registrarCardServido(2)).resolves.toEqual({ ok: false, motivo: 'lente', transitorio: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('o registro da falha que também falha é engolido (não rejeita)', async () => {
    respostas.push({ data: null, error: { code: '22023' } }, new TypeError('rede caiu'));
    await expect(registrarCardServido(9)).resolves.toMatchObject({ ok: false, motivo: 'parametro_invalido' });
    await Promise.resolve();
    expect(chamadas('radar_registrar_falha_sensor')).toHaveLength(1);
  });
});
