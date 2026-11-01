import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AvisoPrazoCliente } from '../AvisoPrazoCliente';
import type { AvisoPrazo } from '@/hooks/unifiedOrder/usePrazoAviso';
import type { PrazoDecisaoEstado } from '@/services/orderSubmission/prazoDecisao';

// `vi.hoisted`: as factories de vi.mock são içadas acima das declarações — variável de topo normal dá TDZ.
const h = vi.hoisted(() => ({ mockUseAviso: vi.fn(), mockTrack: vi.fn(), lente: false }));
const { mockUseAviso, mockTrack } = h;
vi.mock('@/hooks/unifiedOrder/usePrazoAviso', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/hooks/unifiedOrder/usePrazoAviso')>();
  return { ...mod, usePrazoAviso: (company: unknown, codigo: unknown) => h.mockUseAviso(company, codigo) };
});
vi.mock('@/lib/analytics', () => ({ track: (...args: unknown[]) => h.mockTrack(...args) }));
vi.mock('@/lib/impersonation/lens-write-guard', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/impersonation/lens-write-guard')>();
  return { ...mod, isLensActive: () => h.lente }; // parcial: o client do supabase usa createLensGuardedClient deste módulo
});

const FORMAS = [
  { codigo: '999', descricao: 'A Vista' },
  { codigo: '001', descricao: '30 dias' },
  { codigo: '002', descricao: '30/60 dias' },
  { codigo: '003', descricao: '30/60/90 dias' },
  { codigo: 'B01', descricao: 'Boleto' },
];

const aviso = (over: Partial<AvisoPrazo> = {}): AvisoPrazo => ({
  vencido: 1500.5, nTitulos: 3, diasVencidoMax: 20, vencimentoMaisAntigo: '2026-10-11',
  atrasoMedioVencidoDias: 12.5, nAmbiguos: 0, nInvalidos: 0, syncEm: '2026-10-31T10:00:00Z', qualidade: 'ok', ...over,
});

type Props = Parameters<typeof AvisoPrazoCliente>[0];
function montar(props: Partial<Props> = {}) {
  const onSelect = vi.fn();
  const onEstado = vi.fn<(c: string, e: PrazoDecisaoEstado | null) => void>();
  const base: Props = { company: 'oben', codigo: 10, nomeCliente: 'CLI DEZ', formas: FORMAS, selected: '003', onSelect, onEstado, ...props };
  const utils = render(<AvisoPrazoCliente {...base} />);
  const rerenderCom = (p: Partial<Props>) => utils.rerender(<AvisoPrazoCliente {...base} {...p} />);
  return { ...utils, onSelect, onEstado, rerenderCom };
}
const ultimoEstado = (onEstado: ReturnType<typeof vi.fn>) => onEstado.mock.calls.at(-1)?.[1] as PrazoDecisaoEstado | null | undefined;

describe('AvisoPrazoCliente', () => {
  beforeEach(() => { mockUseAviso.mockReset(); mockTrack.mockReset(); h.lente = false; });

  it('com vencido renderiza R$, títulos, dias, atraso médio e a sugestão um degrau abaixo (30/60 para 30/60/90)', () => {
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    const { onEstado } = montar();
    expect(screen.getByTestId('aviso-prazo-oben')).toBeTruthy();
    expect(screen.getByText(/3 títulos/)).toBeTruthy();
    expect(screen.getByText(/até 20 dias/)).toBeTruthy();
    expect(screen.getByText(/Atraso médio do vencido: 12,5 d/)).toBeTruthy();
    expect(screen.getByText('30/60 dias')).toBeTruthy();
    expect(ultimoEstado(onEstado)).toMatchObject({ company: 'oben', codigo: 10, parcelaHabitual: '003', sugerida: '002', sugeridaDescricao: '30/60 dias', interagiu: false, motivo: null, motivoSistema: null });
    expect(mockTrack).toHaveBeenCalledWith('venda.prazo_aviso_exibido', expect.objectContaining({ account: 'oben', faixa: '16_45d', com_sugestao: true }));
  });

  it('vencido 0 (zero REAL) sem inválidos → nada renderizado e estado null', () => {
    mockUseAviso.mockReturnValue({ data: aviso({ vencido: 0, nTitulos: 0, diasVencidoMax: null }), error: null });
    const { container, onEstado } = montar();
    expect(container.firstChild).toBeNull();
    expect(onEstado.mock.calls.every((c) => c[1] === null)).toBe(true);
  });

  it('vencido 0 mas com títulos inválidos/ambíguos → NOTA de qualidade, sem sugestão e sem decisão (os 12 clientes de datas inválidas)', () => {
    mockUseAviso.mockReturnValue({ data: aviso({ vencido: 0, nTitulos: 0, diasVencidoMax: null, nInvalidos: 1 }), error: null });
    const { onEstado } = montar();
    expect(screen.getByTestId('aviso-prazo-oben-qualidade').textContent).toMatch(/1 título em aberto com dados inválidos/);
    expect(screen.queryByTestId('aviso-prazo-oben')).toBeNull();
    expect(onEstado.mock.calls.every((c) => c[1] === null)).toBe(true);
  });

  it('indisponível (null) → silêncio; erro na fonte MESMO com dado anterior em cache → silêncio + track', () => {
    mockUseAviso.mockReturnValue({ data: null, error: null });
    expect(montar().container.firstChild).toBeNull();
    mockUseAviso.mockReturnValue({ data: aviso(), error: new Error('boom') });
    const { container, onEstado } = montar();
    expect(container.firstChild).toBeNull();
    expect(onEstado.mock.calls.every((c) => c[1] === null)).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith('venda.prazo_aviso_erro', expect.objectContaining({ message: 'boom' }));
  });

  it('Aplicar sugestão troca a condição, marca interagiu e mostra "aplicada"', () => {
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    const { onSelect, onEstado, rerenderCom } = montar();
    fireEvent.click(screen.getByRole('button', { name: /Aplicar sugestão/ }));
    expect(onSelect).toHaveBeenCalledWith('002');
    rerenderCom({ selected: '002' });
    expect(screen.getByTestId('aviso-prazo-oben-aplicada').textContent).toMatch(/Sugestão aplicada/);
    expect(ultimoEstado(onEstado)).toMatchObject({ sugerida: '002', interagiu: true, parcelaHabitual: '003' });
  });

  it('depois de interagir a oferta CONGELA: aplicar 30/60 não vira "sugira 30" em cascata', () => {
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    const { onEstado, rerenderCom } = montar();
    fireEvent.click(screen.getByRole('button', { name: /Aplicar sugestão/ }));
    rerenderCom({ selected: '002' });
    expect(ultimoEstado(onEstado)).toMatchObject({ parcelaHabitual: '003', sugerida: '002' });
    expect(screen.queryByText(/hoje: 30\/60 dias\)/)).toBeNull();
  });

  it('ANTES de interagir a oferta segue a seleção: habitual chega depois (999 → 003) e a sugestão nasce certa', () => {
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    const { onEstado, rerenderCom } = montar({ selected: '999' });
    expect(ultimoEstado(onEstado)).toMatchObject({ sugerida: null, motivoSistema: 'ja_a_vista' });
    rerenderCom({ selected: '003' });
    expect(ultimoEstado(onEstado)).toMatchObject({ parcelaHabitual: '003', sugerida: '002', motivoSistema: null });
    expect(screen.getByRole('button', { name: /Aplicar sugestão/ })).toBeTruthy();
  });

  it('vendedora põe À VISTA à mão: "Aplicar" some (não se empurra 30/60 para quem já antecipou mais)', () => {
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    const { rerenderCom } = montar();
    fireEvent.click(screen.getByRole('button', { name: /Manter 30\/60\/90 dias/ }));
    rerenderCom({ selected: '999' });
    expect(screen.queryByRole('button', { name: /Aplicar sugestão/ })).toBeNull();
    expect(screen.getByTestId('aviso-prazo-oben-aplicada').textContent).toMatch(/já antecipa mais que a sugestão/);
  });

  it('formas recarregadas com o código sugerido mudado de significado → oferta EXPIRA (sem Aplicar)', () => {
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    const { rerenderCom } = montar();
    fireEvent.click(screen.getByRole('button', { name: /Manter 30\/60\/90 dias/ }));
    rerenderCom({ formas: FORMAS.map((f) => (f.codigo === '002' ? { codigo: '002', descricao: '120 dias' } : f)) });
    expect(screen.getByTestId('aviso-prazo-oben-expirada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aplicar sugestão/ })).toBeNull();
  });

  it('Manter abre o motivo; sem motivo o estado publica interagiu=true e motivo=null (vira recusou_sem_motivo no envio)', () => {
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    const { onEstado } = montar();
    fireEvent.click(screen.getByRole('button', { name: /Manter 30\/60\/90 dias/ }));
    expect(screen.getByTestId('aviso-prazo-oben-manter')).toBeTruthy();
    expect(ultimoEstado(onEstado)).toMatchObject({ interagiu: true, motivo: null });
  });

  it('vencido há mais de 60 dias → sugestão é à vista direto, com o rótulo', () => {
    mockUseAviso.mockReturnValue({ data: aviso({ diasVencidoMax: 75 }), error: null });
    const { onEstado } = montar();
    expect(screen.getByText(/vencido há mais de 60 dias/)).toBeTruthy();
    expect(ultimoEstado(onEstado)).toMatchObject({ sugerida: '999' });
  });

  it('condição atual ilegível (Boleto) → aviso SEM sugestão, motivoSistema condicao_ilegivel', () => {
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    const { onEstado } = montar({ selected: 'B01' });
    expect(screen.getByTestId('aviso-prazo-oben-sem-sugestao')).toBeTruthy();
    expect(ultimoEstado(onEstado)).toMatchObject({ sugerida: null, motivoSistema: 'condicao_ilegivel' });
  });

  it('sync defasado ou ausente é dito na cara; inválidos aparecem como "não somado"', () => {
    mockUseAviso.mockReturnValue({ data: aviso({ qualidade: 'defasado', nInvalidos: 2 }), error: null });
    montar();
    expect(screen.getByText(/Sync há mais de 24h/)).toBeTruthy();
    expect(screen.getByText(/2 com dados inválidos \(não somado\)/)).toBeTruthy();
  });

  it('sob a lente "Ver como" os botões ficam desabilitados', () => {
    h.lente = true;
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    montar();
    expect((screen.getByRole('button', { name: /Aplicar sugestão/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('troca de cliente zera a oferta e publica null para a conta', () => {
    mockUseAviso.mockReturnValue({ data: aviso(), error: null });
    const { onEstado, rerenderCom } = montar();
    mockUseAviso.mockReturnValue({ data: null, error: null });
    rerenderCom({ codigo: 11, nomeCliente: 'OUTRO' });
    expect(ultimoEstado(onEstado)).toBeNull();
  });
});
