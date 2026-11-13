/**
 * Revisão do Radar 2026-11-11: item 19 — UM seletor de contato no lugar de dois toggles sobrepostos ("Só com telefone"
 * e "Incluir sem contato", polaridades opostas); item 20 — a ordem da fila diz qual botão está valendo (`aria-pressed`).
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/components/radar/RadarBuscaCnae', () => ({ RadarBuscaCnae: () => null }));

import { RadarFiltros, filtroContato } from '@/components/radar/RadarFiltros';
import type { RadarFiltros as Filtros } from '@/queries/useRadarLista';

const FILTROS: Filtros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'score', incluirSaiuDoDump: false, soIneditos: false, soSugeridos: false, regiao: 'atuacao',
};

describe('RadarFiltros — contato e ordem', () => {
  it('URL → seletor: telefone vence; "incluir sem contato" = todos; nada = com algum contato', () => {
    expect(filtroContato({ comTelefone: true, incluirSemContato: true })).toBe('telefone');
    expect(filtroContato({ comTelefone: false, incluirSemContato: true })).toBe('todos');
    expect(filtroContato({})).toBe('algum');
  });

  it('um grupo só, com o atual marcado; escolher escreve os DOIS params de uma vez', () => {
    const set = vi.fn();
    render(<RadarFiltros filtros={FILTROS} set={set} />);
    expect(screen.queryByRole('switch', { name: /só com telefone/i })).toBeNull();
    expect(screen.queryByRole('switch', { name: /incluir sem contato/i })).toBeNull();
    const grupo = screen.getByRole('group', { name: 'Contato' });
    expect(within(grupo).getByRole('button', { name: 'Com algum contato' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(grupo).getByRole('button', { name: 'Com telefone' }));
    expect(set).toHaveBeenLastCalledWith({ comTelefone: true, incluirSemContato: false });
    fireEvent.click(within(grupo).getByRole('button', { name: 'Todos' }));
    expect(set).toHaveBeenLastCalledWith({ comTelefone: false, incluirSemContato: true });
  });

  it('ordem da fila: grupo rotulado e só a ordem ativa com aria-pressed=true', () => {
    render(<RadarFiltros filtros={{ ...FILTROS, preset: 'novas' }} set={() => {}} />);
    const grupo = screen.getByRole('group', { name: 'Ordem da fila' });
    const marcados = within(grupo).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(marcados).toHaveLength(1);
    expect(within(grupo).getAllByRole('button').every((b) => b.hasAttribute('aria-pressed'))).toBe(true);
  });
});
