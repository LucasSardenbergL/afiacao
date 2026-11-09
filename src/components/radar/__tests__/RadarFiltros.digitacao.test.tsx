/**
 * Pacote N, itens 4 e 5: a busca e o município só viram filtro depois de uma pausa na digitação (antes cada tecla
 * era uma `radar_lista`), Enter/sair do campo confirmam na hora, valor trocado por fora entra no campo; e todo
 * controle de filtro tem rótulo acessível (antes, só placeholder).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/components/radar/RadarBuscaCnae', () => ({ RadarBuscaCnae: () => null }));

import { RadarFiltros, ATRASO_DIGITACAO_MS } from '@/components/radar/RadarFiltros';
import type { RadarFiltros as Filtros } from '@/queries/useRadarLista';

const FILTROS: Filtros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'score', incluirSaiuDoDump: false, soIneditos: false, soSugeridos: false, regiao: 'atuacao',
};

afterEach(() => { vi.useRealTimers(); });

describe('RadarFiltros — digitação adiada', () => {
  it('cada tecla NÃO vira filtro: só a pausa confirma, uma vez, com o texto final', () => {
    vi.useFakeTimers();
    const set = vi.fn();
    render(<RadarFiltros filtros={FILTROS} set={set} />);
    const busca = screen.getByLabelText('Buscar por razão social ou nome fantasia');
    for (const t of ['m', 'ma', 'mad', 'made']) fireEvent.change(busca, { target: { value: t } });
    act(() => { vi.advanceTimersByTime(ATRASO_DIGITACAO_MS - 1); });
    expect(set).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ busca: 'made' });
  });

  it('Enter confirma na hora, e a pausa depois não manda de novo', () => {
    vi.useFakeTimers();
    const set = vi.fn();
    render(<RadarFiltros filtros={FILTROS} set={set} />);
    const muni = screen.getByLabelText('Município');
    fireEvent.change(muni, { target: { value: 'uba' } });
    fireEvent.keyDown(muni, { key: 'Enter' });
    expect(set).toHaveBeenCalledWith({ municipio: 'uba', municipioCodigo: '' });
    act(() => { vi.advanceTimersByTime(ATRASO_DIGITACAO_MS * 2); });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('sair do campo confirma na hora', () => {
    const set = vi.fn();
    render(<RadarFiltros filtros={FILTROS} set={set} />);
    const busca = screen.getByLabelText('Buscar por razão social ou nome fantasia');
    fireEvent.change(busca, { target: { value: 'serraria' } });
    fireEvent.blur(busca);
    expect(set).toHaveBeenCalledWith({ busca: 'serraria' });
  });

  it('valor trocado POR FORA (favorito, cidade do ranking) entra no campo, sem eco de volta', () => {
    vi.useFakeTimers();
    const set = vi.fn();
    const { rerender } = render(<RadarFiltros filtros={FILTROS} set={set} />);
    rerender(<RadarFiltros filtros={{ ...FILTROS, municipio: 'UBERLANDIA' }} set={set} />);
    expect((screen.getByLabelText('Município') as HTMLInputElement).value).toBe('UBERLANDIA');
    act(() => { vi.advanceTimersByTime(ATRASO_DIGITACAO_MS * 2); });
    expect(set).not.toHaveBeenCalled();
  });
});

describe('RadarFiltros — rótulos acessíveis', () => {
  it('busca, município, UF e status têm nome acessível (não só placeholder)', () => {
    render(<RadarFiltros filtros={FILTROS} set={vi.fn()} />);
    expect(screen.getByRole('searchbox', { name: 'Buscar por razão social ou nome fantasia' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Município' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'UF' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Status do lead' })).toBeTruthy();
  });
});
