import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Pacote L (item 3): a agenda "Hoje" do /radar e o sensor dela no LEDGER (regra de fase). O que pegaria a saída
 * errada: 'vista' gravada a cada render (o denominador inflaria), 'vista' gravada com a agenda vazia, item que não
 * abre a ficha, ou leitura que falhou virando agenda vazia (sumiria calada).
 */
const estado: { data: unknown; isError: boolean; error: unknown } = { data: null, isError: false, error: null };
vi.mock('@/queries/useRadarProspectarHoje', () => ({
  useRadarProspectarHoje: () => ({ ...estado, isFetching: false, isLoading: false, refetch: vi.fn() }),
}));
const registrar = vi.fn((_v: unknown) => Promise.resolve({ ok: true, registrado: true }));
vi.mock('@/queries/useRadarAgendaUso', () => ({ registrarUsoAgenda: (v: unknown) => registrar(v) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { RadarAgendaHoje } from '../RadarAgendaHoje';

const DADOS = {
  territorio: [], leads: [], territorioMotivo: null,
  retornos: { total: 1, itens: [{ cnpj: '10300000000101', razaoSocial: 'Lead 103', nomeFantasia: null, municipioNome: 'DIVINOPOLIS',
    uf: 'MG', tipo: 'conversa', retornoEm: '2026-11-07', atrasado: true, nota: 'quer orçamento' }] },
  posses: { vencendo: [{ atendimentoId: 7, cnpj: '10400000000101', razaoSocial: 'Lead 104', nomeFantasia: null,
    expiraEm: '2026-11-10T15:00:00Z' }], vencidas7d: 0 },
};

beforeEach(() => { registrar.mockClear(); estado.data = null; estado.isError = false; estado.error = null; });

describe('RadarAgendaHoje', () => {
  it('mostra retorno e posse, grava "vista" UMA vez por dia com o denominador, e o clique abre e grava "aberta"', () => {
    estado.data = DADOS;
    const onAbrir = vi.fn(() => Promise.resolve());
    const { rerender } = render(<RadarAgendaHoje hojeISO="2026-11-09" onAbrir={onAbrir} />);
    expect(screen.getByTestId('radar-agenda-resumo').textContent).toBe('1 retorno (1 atrasado) · 1 posse vencendo');
    expect(screen.getByText(/atrasado \(07\/11\)/)).toBeTruthy();
    rerender(<RadarAgendaHoje hojeISO="2026-11-09" onAbrir={onAbrir} />);
    expect(registrar.mock.calls.filter(([v]) => (v as { evento: string }).evento === 'vista')).toEqual([
      [{ evento: 'vista', nRetornos: 1, nPosses: 1 }],
    ]);
    fireEvent.click(screen.getByTestId('radar-agenda-posse'));
    expect(onAbrir).toHaveBeenCalledWith('10400000000101');
    expect(registrar).toHaveBeenLastCalledWith({ evento: 'aberta', cnpj: '10400000000101' });
  });

  it('na virada do dia, a "vista" do dia novo é gravada', () => {
    estado.data = DADOS;
    const { rerender } = render(<RadarAgendaHoje hojeISO="2026-11-09" onAbrir={() => Promise.resolve()} />);
    rerender(<RadarAgendaHoje hojeISO="2026-11-10" onAbrir={() => Promise.resolve()} />);
    expect(registrar.mock.calls.filter(([v]) => (v as { evento: string }).evento === 'vista')).toHaveLength(2);
  });

  it('agenda vazia não aparece e não grava "vista"', () => {
    estado.data = { ...DADOS, retornos: { total: 0, itens: [] }, posses: { vencendo: [], vencidas7d: 3 } };
    const { container } = render(<RadarAgendaHoje hojeISO="2026-11-09" onAbrir={() => Promise.resolve()} />);
    expect(container.textContent).toBe('');
    expect(registrar).not.toHaveBeenCalled();
  });

  it('leitura que falhou DIZ (não some como se não houvesse nada para hoje)', () => {
    estado.isError = true; estado.error = new Error('rede');
    render(<RadarAgendaHoje hojeISO="2026-11-09" onAbrir={() => Promise.resolve()} />);
    expect(screen.getByTestId('radar-agenda-erro').textContent).toContain('Não consegui ler');
    expect(registrar).not.toHaveBeenCalled();
  });
});
