import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Revisão do Radar 2026-11-11 — a ação de telefone na LINHA da fila.
 *   - item 10: no toque, o alvo tem 44×44 (a âncora `tel:` tinha 32 px de largura; o CSS global só alarga <button>);
 *   - item 12: o toque vai ao ledger de intenção COM o CNPJ (a linha não passava) e abre a ficha, onde o desfecho
 *     é registrado;
 *   - item 20: "1 ano", não "1 anos".
 */
let atendimentos = new Map<string, unknown>();
vi.mock('@/queries/useRadarAtendimentos', () => ({
  useRadarAtendimentosAtivos: () => ({ data: atendimentos, isError: false, isSuccess: true, isLoading: false }),
}));
vi.mock('@/hooks/useIsTouchDevice', () => ({ useIsTouchDevice: () => true }));
const registrarIntencaoContato = vi.fn();
vi.mock('@/queries/useRadarRegistroEmpurrado', () => ({ registrarIntencaoContato: (...a: unknown[]) => registrarIntencaoContato(...a) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { RadarLinha } from '../RadarLinha';
import type { RadarEmpresa } from '@/queries/useRadarLista';

const EMPRESA = {
  cnpj: '12345678000195', razao_social: 'ACME LTDA', nome_fantasia: null, ja_cliente: false, prospeccao_status: 'a_contatar',
  telefone1: '3732220001', telefone2: null, municipio_nome: 'DIVINOPOLIS', uf: 'MG', data_abertura: '2019-03-01', porte: '01',
  cnae_descricao: null, ultimo_lote: '2026-08', primeira_vista_em: null,
} as unknown as RadarEmpresa;

beforeEach(() => { registrarIntencaoContato.mockClear(); atendimentos = new Map(); });

describe('RadarLinha — telefone e idade', () => {
  it('toque: 44×44, intenção "ligar" com o CNPJ e a ficha abre', () => {
    const onAbrir = vi.fn();
    render(<RadarLinha empresa={EMPRESA} hojeISO="2020-06-01" selecionada={false} onSelecionar={() => {}} onAbrir={onAbrir} lote={null} />);
    const ligar = screen.getByRole('link', { name: /ligar pelo celular/i });
    expect(ligar.className).toMatch(/\bh-11\b/);
    expect(ligar.className).toMatch(/\bw-11\b/);
    expect(ligar.className).not.toMatch(/\bw-8\b/);
    fireEvent.click(ligar);
    expect(registrarIntencaoContato).toHaveBeenCalledWith('12345678000195', 'ligar');
    expect(onAbrir).toHaveBeenCalledTimes(1);
  });

  it('idade no singular: "1 ano"', () => {
    render(<RadarLinha empresa={EMPRESA} hojeISO="2020-06-01" selecionada={false} onSelecionar={() => {}} onAbrir={() => {}} lote={null} />);
    expect(screen.getByText(/1 ano ·/)).toBeTruthy();
    expect(screen.queryByText(/1 anos/)).toBeNull();
  });
});
