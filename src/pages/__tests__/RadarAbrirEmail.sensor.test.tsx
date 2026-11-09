import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * Radar D1 + H — o link do e-mail semanal (/radar/abrir/:envio/:cnpj) grava o CLIQUE e, quando o lead foi lido no
 * navegador, a FICHA ENTREGUE (2º momento); depois cai na ficha pelo deep link /radar?cnpj=. Lead que não veio não
 * conta como ficha: vira falha do sensor. Link malformado não grava; lente "Ver como" não grava.
 */
const rpc = vi.fn((_n: string, _a?: unknown) => Promise.resolve({ data: { ok: true, registrado: true }, error: null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a?: unknown) => rpc(n, a) } }));
let lente = { isImpersonating: false, effectiveUserId: 'eu' };
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => lente }));
const lerEmpresa = vi.fn((_c: string): Promise<unknown> => Promise.resolve({ cnpj: '00000000000101' }));
vi.mock('@/queries/useRadarConflitosCadastro', () => ({ lerEmpresaRadar: (c: string) => lerEmpresa(c) }));
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import RadarAbrirEmail from '../RadarAbrirEmail';

const ENVIO = '0f2b6c1e-3a4d-4b5e-8f60-1a2b3c4d5e6f';
const CNPJ = '00000000000101';
function Destino() {
  const l = useLocation();
  return <p data-testid="destino">{l.pathname + l.search}</p>;
}
function abrir(caminho: string) {
  return render(
    <MemoryRouter initialEntries={[caminho]}>
      <Routes>
        <Route path="/radar/abrir/:envio/:cnpj" element={<RadarAbrirEmail />} />
        <Route path="/radar" element={<Destino />} />
      </Routes>
    </MemoryRouter>,
  );
}
const chamadas = (nome: string) => rpc.mock.calls.filter((c) => c[0] === nome);

beforeEach(() => {
  rpc.mockClear();
  lerEmpresa.mockReset();
  lerEmpresa.mockImplementation(() => Promise.resolve({ cnpj: CNPJ }));
  track.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  lente = { isImpersonating: false, effectiveUserId: 'eu' };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RadarAbrirEmail', () => {
  it('grava o clique, lê o lead, grava a ficha entregue e cai na ficha', async () => {
    abrir(`/radar/abrir/${ENVIO}/${CNPJ}`);
    expect(await screen.findByTestId('destino')).toHaveTextContent(`/radar?cnpj=${CNPJ}`);
    await waitFor(() => expect(chamadas('radar_registrar_ficha_entregue')).toHaveLength(1));
    const args = { p_origem: 'email', p_cnpj: CNPJ, p_envio: ENVIO };
    expect(chamadas('radar_registrar_abertura_empurrada')).toEqual([['radar_registrar_abertura_empurrada', args]]);
    expect(chamadas('radar_registrar_ficha_entregue')).toEqual([['radar_registrar_ficha_entregue', args]]);
    expect(lerEmpresa).toHaveBeenCalledWith(CNPJ);
    expect(chamadas('radar_registrar_falha_sensor')).toHaveLength(0);
  });

  it('lead não encontrado: NÃO grava ficha, registra a falha do sensor e segue para o Radar', async () => {
    lerEmpresa.mockImplementation(() => Promise.resolve(null));
    abrir(`/radar/abrir/${ENVIO}/${CNPJ}`);
    expect(await screen.findByTestId('destino')).toHaveTextContent(`/radar?cnpj=${CNPJ}`);
    await waitFor(() =>
      expect(chamadas('radar_registrar_falha_sensor')).toEqual([
        ['radar_registrar_falha_sensor', { p_sensor: 'ficha_email', p_motivo: 'lead_nao_encontrado' }],
      ]),
    );
    expect(chamadas('radar_registrar_ficha_entregue')).toHaveLength(0);
    expect(track).toHaveBeenCalledWith('radar.sensor_falhou', { sensor: 'ficha_email', motivo: 'lead_nao_encontrado', tentativas: 1 });
  });

  it('leitura da ficha falhou: falha com o motivo da leitura, sem ficha', async () => {
    lerEmpresa.mockImplementation(() => Promise.reject({ code: '42501', message: 'permission denied' }));
    abrir(`/radar/abrir/${ENVIO}/${CNPJ}`);
    expect(await screen.findByTestId('destino')).toHaveTextContent(`/radar?cnpj=${CNPJ}`);
    await waitFor(() =>
      expect(chamadas('radar_registrar_falha_sensor')).toEqual([
        ['radar_registrar_falha_sensor', { p_sensor: 'ficha_email', p_motivo: 'leitura_sem_acesso' }],
      ]),
    );
    expect(chamadas('radar_registrar_ficha_entregue')).toHaveLength(0);
  });

  it('ficha que não chega em 8 s: segue para o Radar e registra a demora (não conta como ficha)', async () => {
    vi.useFakeTimers();
    lerEmpresa.mockImplementation(() => new Promise(() => undefined));
    abrir(`/radar/abrir/${ENVIO}/${CNPJ}`);
    expect(screen.queryByTestId('destino')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.getByTestId('destino')).toHaveTextContent(`/radar?cnpj=${CNPJ}`);
    expect(chamadas('radar_registrar_falha_sensor')).toEqual([
      ['radar_registrar_falha_sensor', { p_sensor: 'ficha_email', p_motivo: 'ficha_demorou' }],
    ]);
    expect(chamadas('radar_registrar_ficha_entregue')).toHaveLength(0);
  });

  it('link malformado: vai para o Radar sem gravar nem ler nada', async () => {
    abrir(`/radar/abrir/nao-e-uuid/${CNPJ}`);
    expect(await screen.findByTestId('destino')).toHaveTextContent(/^\/radar$/);
    expect(rpc).not.toHaveBeenCalled();
    expect(lerEmpresa).not.toHaveBeenCalled();
  });

  it('lente "Ver como": abre a ficha sem gravar nada', async () => {
    lente = { isImpersonating: true, effectiveUserId: 'vendedora-x' };
    abrir(`/radar/abrir/${ENVIO}/${CNPJ}`);
    expect(await screen.findByTestId('destino')).toHaveTextContent(`/radar?cnpj=${CNPJ}`);
    expect(rpc).not.toHaveBeenCalled();
  });
});
