import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * Radar D1 — o link do e-mail semanal (/radar/abrir/:envio/:cnpj) grava a abertura no ledger (numerador do sensor) e
 * cai na ficha pelo deep link /radar?cnpj=. Link malformado não grava; lente "Ver como" não grava.
 */
const rpc = vi.fn((_n: string, _a?: unknown) => Promise.resolve({ data: { ok: true, registrado: true, do_destinatario: true }, error: null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a?: unknown) => rpc(n, a) } }));
let lente = { isImpersonating: false, effectiveUserId: 'eu' };
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => lente }));

import RadarAbrirEmail from '../RadarAbrirEmail';

const ENVIO = '0f2b6c1e-3a4d-4b5e-8f60-1a2b3c4d5e6f';
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

beforeEach(() => { rpc.mockClear(); lente = { isImpersonating: false, effectiveUserId: 'eu' }; });

describe('RadarAbrirEmail', () => {
  it('grava a abertura com envio + CNPJ e cai na ficha do lead', async () => {
    abrir(`/radar/abrir/${ENVIO}/00000000000101`);
    expect(await screen.findByTestId('destino')).toHaveTextContent('/radar?cnpj=00000000000101');
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc).toHaveBeenCalledWith('radar_registrar_abertura_empurrada', { p_origem: 'email', p_cnpj: '00000000000101', p_envio: ENVIO });
  });

  it('link malformado: vai para o Radar sem gravar nada', async () => {
    abrir('/radar/abrir/nao-e-uuid/00000000000101');
    expect(await screen.findByTestId('destino')).toHaveTextContent(/^\/radar$/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('lente "Ver como": abre a ficha sem gravar a abertura', async () => {
    lente = { isImpersonating: true, effectiveUserId: 'vendedora-x' };
    abrir(`/radar/abrir/${ENVIO}/00000000000101`);
    expect(await screen.findByTestId('destino')).toHaveTextContent('/radar?cnpj=00000000000101');
    expect(rpc).not.toHaveBeenCalled();
  });
});
