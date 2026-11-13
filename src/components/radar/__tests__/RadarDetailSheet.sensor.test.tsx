import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
// A ficha lê o usuário real só para a chave do rascunho da nota (pacote G4).
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-teste' } }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => lente }));
vi.mock('@/queries/useRadarTelefoneCompartilhado', () => ({ useRadarTelefoneCompartilhado: () => ({ data: undefined }) }));
vi.mock('@/queries/useRadarContatoContabil', () => ({
  useRadarContatoContabil: () => ({ data: undefined, isError: false }),
  useCorrigirContatoContabil: () => ({ mutate: () => {}, isPending: false }),
}));
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
vi.mock('@/components/credito-vinculo/AvisoVinculoCredito', () => ({ AvisoVinculoCredito: Nada }));

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

  // Pacote M: ligar/WhatsApp/copiar viram INTENÇÃO de contato no ledger (radar_eventos), fora do PostHog censurado.
  describe('intenção de contato', () => {
    const comCelular = () => ({ ...lead('11222333000181'), telefone1: '(37) 99999-1234' }) as unknown as RadarEmpresa;
    const intencoes = () => rpc.mock.calls.filter((c) => c[0] === 'radar_registrar_intencao').map((c) => c[1]);

    it('e-mail (mailto) grava a intenção "email" — revisão 2026-11-11, item 18', () => {
      render(ficha({ ...lead('11222333000181'), email: 'compras@lead.com.br' } as unknown as RadarEmpresa));
      fireEvent.click(screen.getByRole('link', { name: /compras@lead\.com\.br/ }));
      expect(intencoes()).toEqual([{ p_cnpj: '11222333000181', p_canal: 'email' }]);
    });

    it('WhatsApp grava a intenção com o CNPJ da ficha', () => {
      render(ficha(comCelular()));
      fireEvent.click(screen.getByTestId('radar-whatsapp'));
      expect(intencoes()).toEqual([{ p_cnpj: '11222333000181', p_canal: 'whatsapp' }]);
    });

    it('Copiar telefone (desktop) grava a intenção depois de copiar', async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
      render(ficha(comCelular()));
      fireEvent.click(screen.getByRole('button', { name: /Copiar telefone/ }));
      await waitFor(() => expect(intencoes()).toEqual([{ p_cnpj: '11222333000181', p_canal: 'copiar' }]));
    });

    it('sob a lente "Ver como" o WhatsApp não grava intenção', () => {
      lente = true;
      render(ficha(comCelular()));
      fireEvent.click(screen.getByTestId('radar-whatsapp'));
      expect(intencoes()).toHaveLength(0);
    });
  });
});

describe('RadarDetailSheet — formatação e acessibilidade (revisão 2026-11-11, item 20)', () => {
  it('o diálogo tem descrição acessível; a abertura sai em dd/mm/aaaa e a idade no singular', () => {
    const empresa = { ...lead('11222333000181'), data_abertura: '2025-03-01' } as unknown as RadarEmpresa;
    render(<RadarDetailSheet empresa={empresa} hojeISO="2026-06-01" onClose={() => {}} />);
    const dialogo = screen.getByRole('dialog');
    const desc = dialogo.getAttribute('aria-describedby');
    expect(desc && document.getElementById(desc)?.textContent).toMatch(/Ficha do lead/);
    expect(dialogo.textContent).toContain('01/03/2025 (1 ano)');
    expect(dialogo.textContent).not.toContain('2025-03-01');
  });
});

describe('RadarDetailSheet — atalhos (revisão 2026-11-11, item 17)', () => {
  it('pelo registro do app: "n" chama o próximo; "c" copia o telefone e grava a intenção "copiar"', async () => {
    lente = false; rpc.mockClear();
    const { ShortcutsRegistryProvider } = await import('@/components/shell/ShortcutsRegistry');
    const onProximo = vi.fn();
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const empresa = { ...lead('11222333000181'), telefone1: '3732220001' } as unknown as RadarEmpresa;
    render(
      <ShortcutsRegistryProvider>
        <RadarDetailSheet empresa={empresa} hojeISO="2026-11-06" onClose={() => {}} onProximo={onProximo} />
      </ShortcutsRegistryProvider>,
    );
    fireEvent.keyDown(window, { key: 'n' });
    expect(onProximo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'c' });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('3732220001'));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('radar_registrar_intencao', expect.objectContaining({ p_cnpj: '11222333000181', p_canal: 'copiar' })));
  });
});
