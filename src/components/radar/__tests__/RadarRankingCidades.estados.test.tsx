/**
 * "Onde caçar" (ranking de cidades do /radar) — erro NÃO pode virar "0 empresas · nenhuma cidade".
 *
 * A contagem por município passou a vir de um agregado pré-computado (radar_agregado_municipio,
 * migration 20261103100000, leitor 4 do Mini). Na hora seguinte à carga mensal ele ainda é do lote
 * anterior e a RPC recusa com 'agregado indisponível'. Antes, qualquer erro aqui caía em `q.data`
 * undefined → `totalGeral` 0 → "0 empresas · 0 c/ telefone" + "Nenhuma cidade nestes filtros.": o zero
 * fabricado (money-path §2, ausente ≠ zero).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

type Q = { data: unknown; isLoading: boolean; isError: boolean; error: unknown };
let contagem: Q;
let penetracao: Q;

vi.mock('@/queries/useRadarContagemMunicipios', () => ({
  useRadarContagemMunicipios: () => contagem,
  useRadarPenetracaoMunicipios: () => penetracao,
  oportunidadesPenetracao: () => [],
  formatarPenetracao: (p: number | null) => (p == null ? '—' : `${p}`),
}));

import { RadarRankingCidades } from '../RadarRankingCidades';
import type { RadarFiltros } from '@/queries/useRadarLista';

const filtros = { uf: '' } as RadarFiltros;
const desenhar = () => render(<RadarRankingCidades filtros={filtros} hojeISO="2026-11-03" onPick={() => {}} />);
const MUNI = { municipio_codigo: '4123', municipio_nome: 'UBERLÂNDIA', uf: 'MG', lat: null, lng: null, total: 812, com_telefone: 640, a_contatar: 790 };

beforeEach(() => {
  contagem = { data: [MUNI], isLoading: false, isError: false, error: null };
  penetracao = { data: undefined, isLoading: false, isError: false, error: null };
});

describe('RadarRankingCidades — erro e indisponível NÃO são zero', () => {
  it('leitura OK: total e cidades', () => {
    const r = desenhar();
    expect(r.container.textContent).toContain('812 empresas');
    expect(screen.getByText('UBERLÂNDIA')).toBeTruthy();
  });

  it('agregado do lote ainda não calculado: "indisponível", sem "0 empresas" nem "nenhuma cidade"', () => {
    contagem = {
      data: undefined, isLoading: false, isError: true,
      error: { message: 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas', code: 'P0001' },
    };
    const r = desenhar();
    expect(screen.getByText(/Contagem por cidade indisponível: a contagem do lote vigente está sendo recalculada/)).toBeTruthy();
    expect(r.container.textContent, 'erro virou zero fabricado').not.toContain('0 empresas');
    expect(r.container.textContent).not.toContain('Nenhuma cidade nestes filtros');
    expect(r.container.textContent).toContain('—');
  });

  it('falha de leitura qualquer: "não foi possível carregar", também sem zero', () => {
    contagem = { data: undefined, isLoading: false, isError: true, error: { message: 'connection failure' } };
    const r = desenhar();
    expect(screen.getByText('Não foi possível carregar contagem por cidade.')).toBeTruthy();
    expect(r.container.textContent).not.toContain('0 empresas');
  });

  it('zero LEGÍTIMO (resposta vazia) continua sendo "nenhuma cidade"', () => {
    contagem = { data: [], isLoading: false, isError: false, error: null };
    const r = desenhar();
    expect(r.container.textContent).toContain('Nenhuma cidade nestes filtros');
    expect(r.container.textContent).toContain('0 empresas');
  });
});
