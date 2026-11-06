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
import { render, screen, fireEvent, act } from '@testing-library/react';

type Q = { data: unknown; isLoading: boolean; isError: boolean; error: unknown };
let contagem: Q;
let penetracao: Q;
let habilitado: boolean[] = [];

vi.mock('@/queries/useRadarContagemMunicipios', () => ({
  useRadarContagemMunicipios: (_f: unknown, _h: string, enabled: boolean) => { habilitado.push(enabled); return contagem; },
  useRadarPenetracaoMunicipios: () => penetracao,
  oportunidadesPenetracao: () => [],
  formatarPenetracao: (p: number | null) => (p == null ? '—' : `${p}`),
  bateuNoTeto: (n: number | null | undefined) => n != null && n >= 500,
  LIMITE_MUNICIPIOS: 500,
}));
vi.mock('@/queries/useRadarLoteVigente', () => ({
  useRadarLoteVigente: () => ({ data: { mes_referencia: '2026-10' } }),
}));

import { RadarRankingCidades } from '../RadarRankingCidades';
import type { RadarFiltros } from '@/queries/useRadarLista';

const filtros = { uf: '' } as RadarFiltros;
const desenhar = (p: { adiar?: boolean; onPick?: (c: unknown) => void } = {}) =>
  render(<RadarRankingCidades filtros={filtros} hojeISO="2026-11-03" onPick={p.onPick ?? (() => {})} adiar={p.adiar} />);
const MUNI = { municipio_codigo: '4123', municipio_nome: 'UBERLÂNDIA', uf: 'MG', lat: null, lng: null, total: 812, com_telefone: 640, a_contatar: 790 };

beforeEach(() => {
  habilitado = [];
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

// Pacote C: clique por código (C2), soma rotulada com o teto (C4), carga só quando visível e depois da fila (C5).
describe('RadarRankingCidades — pacote C', () => {
  it('C2: o clique leva código, nome e UF da cidade (não só o nome)', () => {
    const onPick = vi.fn();
    desenhar({ onPick });
    fireEvent.click(screen.getByText('UBERLÂNDIA'));
    expect(onPick).toHaveBeenCalledWith({ codigo: '4123', nome: 'UBERLÂNDIA', uf: 'MG' });
  });

  it('C4: a soma diz "nos N municípios exibidos" e o recorte; abaixo do teto, sem aviso de teto', () => {
    const soma = desenhar().getByTestId('radar-ranking-soma').textContent ?? '';
    expect(soma).toContain('nos 1 municípios exibidos no Brasil');
    expect(soma).not.toContain('teto');
  });

  it('C4: no teto de 500, avisa que há municípios fora da soma', () => {
    contagem = { ...contagem, data: Array.from({ length: 500 }, (_, i) => ({ ...MUNI, municipio_codigo: String(1000 + i) })) };
    const soma = desenhar().getByTestId('radar-ranking-soma').textContent ?? '';
    expect(soma).toContain('nos 500 municípios exibidos');
    expect(soma).toContain('teto de 500');
  });

  it('C5: com a fila ainda carregando (adiar), as agregações ficam desligadas e o card espera', () => {
    const r = desenhar({ adiar: true });
    expect(habilitado.every((e) => e === false)).toBe(true);
    expect(r.container.textContent).not.toContain('812 empresas');
  });

  it('C5: fora da tela não carrega; ao entrar na tela, liga', () => {
    let aoCruzar: ((e: Array<{ isIntersecting: boolean }>) => void) | null = null;
    const Original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) { aoCruzar = cb; }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    } as unknown as typeof IntersectionObserver;
    try {
      desenhar();
      expect(habilitado.at(-1)).toBe(false);
      act(() => aoCruzar?.([{ isIntersecting: true }]));
      expect(habilitado.at(-1)).toBe(true);
    } finally {
      globalThis.IntersectionObserver = Original;
    }
  });
});
