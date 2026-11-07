import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Sensor da ficha do Radar: abrir a ficha chama o ledger REAL (`registrarNoLedger`) com 'radar.ficha_aberta' e o
 * CNPJ do lead — é o que vira `radar_eventos.evento='abriu'` COM cnpj (migration 20261106132259). Só o supabase e a
 * lente são mockados; os filhos da ficha viram nada (o defeito que importa mora no efeito da própria ficha).
 * O que pegaria a saída errada: 1 chamada por render/refetch (infla), chave sem CNPJ (o bug de prod de 2026-11-06),
 * ou a lente "Ver como" contando a inspeção do master como abertura.
 */
const { Nada } = vi.hoisted(() => ({ Nada: () => null }));
const rpc = vi.fn((..._a: unknown[]) => Promise.resolve({ data: null, error: null }));
let lente = false;
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => lente }));
vi.mock('@/queries/useRadarTelefoneCompartilhado', () => ({ useRadarTelefoneCompartilhado: () => ({ data: undefined }) }));
vi.mock('@/queries/useRadarContatos', () => ({
  LIMITE_HISTORICO_RADAR: 20,
  useRadarContatos: () => ({ data: [], isPending: false, isError: false, isFetching: false, error: null, status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1, refetch: vi.fn() }),
}));
vi.mock('../RadarOutcomeMenu', () => ({ RadarOutcomeMenu: Nada }));
vi.mock('../RadarAcoesLead', () => ({ RadarAcoesLead: Nada }));
vi.mock('../RadarConflitosCadastro', () => ({ RadarConflitosDoLead: Nada }));
vi.mock('../RadarAtendimentoLead', () => ({ RadarAtendimentoLead: Nada }));
vi.mock('../RadarModoDiscagem', () => ({ RadarModoDiscagem: Nada }));
vi.mock('../RadarVinculosLead', () => ({ RadarVinculosLead: Nada }));
vi.mock('../RadarSucessaoLead', () => ({ RadarSucessaoLead: Nada }));

import { RadarDetailSheet } from '../RadarDetailSheet';

function lead(cnpj: string): RadarEmpresa {
  return { cnpj, razao_social: `Lead ${cnpj}`, prospeccao_status: 'a_contatar' } as unknown as RadarEmpresa;
}
const chamadasFicha = () => rpc.mock.calls.filter((c) => (c[1] as { p_evento?: string })?.p_evento === 'radar.ficha_aberta');

function ficha(empresa: RadarEmpresa | null) {
  return <RadarDetailSheet empresa={empresa} hojeISO="2026-11-06" onClose={() => {}} />;
}

describe('RadarDetailSheet — sensor da ficha aberta', () => {
  beforeEach(() => { rpc.mockClear(); lente = false; });

  it('abrir a ficha registra radar.ficha_aberta com o CNPJ como chave e nas props', () => {
    render(ficha(lead('11222333000181')));
    expect(chamadasFicha()).toEqual([
      ['analytics_ledger_registrar', { p_evento: 'radar.ficha_aberta', p_chave: '11222333000181', p_props: { cnpj: '11222333000181' } }],
    ]);
  });

  it('1 chamada por CNPJ aberto: refetch (objeto novo, mesmo CNPJ) não repete; trocar de lead registra o novo', () => {
    const { rerender } = render(ficha(lead('11222333000181')));
    rerender(ficha(lead('11222333000181')));
    expect(chamadasFicha()).toHaveLength(1);
    rerender(ficha(lead('AB12CD34000155')));
    expect(chamadasFicha().map((c) => (c[1] as { p_chave: string }).p_chave)).toEqual(['11222333000181', 'AB12CD34000155']);
  });

  it('ficha fechada (empresa null) não registra nada', () => {
    render(ficha(null));
    expect(chamadasFicha()).toHaveLength(0);
  });

  it('sob a lente "Ver como" a abertura não sai (inspeção do master não infla o abriu)', () => {
    lente = true;
    render(ficha(lead('11222333000181')));
    expect(rpc).not.toHaveBeenCalled();
  });
});
