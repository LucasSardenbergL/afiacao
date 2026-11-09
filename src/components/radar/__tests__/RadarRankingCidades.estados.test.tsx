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
  // Contrato de `visitarAplicado` (o real é provado em para-visitar-contagem.test.ts): toda linha com a data.
  visitarAplicado: (d: Array<{ visitar_contado_em: string | null }> | undefined) =>
    !!d && d.length > 0 && d.every((m) => m.visitar_contado_em != null),
  formatarContadoEm: () => '09/11 07:35',
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

// Pacote I, item 2: contagem e penetração são leituras INDEPENDENTES — uma falhar e a outra não é falha PARCIAL, e o
// card tem que dizer (antes a coluna "cli." e as oportunidades sumiam caladas, e o card parecia completo).
describe('RadarRankingCidades — falha parcial da penetração (pacote I)', () => {
  const PEN = { municipio_codigo: '4123', municipio_nome: 'UBERLÂNDIA', uf: 'MG', empresas_lote: 900, clientes: 9, penetracao: 1, concorrentes: null };

  it('penetração OK: a coluna "cli." aparece e não há aviso', () => {
    penetracao = { data: [PEN], isLoading: false, isError: false, error: null };
    const r = desenhar();
    expect(r.container.textContent).toContain('1 cli.');
    expect(screen.queryByTestId('radar-ranking-penetracao-aviso')).toBeNull();
  });

  it('contagem OK e penetração FALHOU: as cidades ficam e o card DIZ que a penetração faltou', () => {
    penetracao = { data: undefined, isLoading: false, isError: true, error: { message: 'connection failure' } };
    const r = desenhar();
    expect(r.container.textContent).toContain('812 empresas');
    expect(screen.getByTestId('radar-ranking-penetracao-aviso').textContent)
      .toContain('Não foi possível carregar penetração por cidade.');
    expect(screen.getByTestId('radar-ranking-penetracao-aviso').textContent).toContain('não é falta de cliente');
    expect(r.container.textContent, 'falha virou "0% cli."').not.toMatch(/0(,0)?% cli\./);
  });

  it('sem lote completo (o hook devolve null): diz por que não há penetração', () => {
    penetracao = { data: null, isLoading: false, isError: false, error: null };
    desenhar();
    expect(screen.getByTestId('radar-ranking-penetracao-aviso').textContent).toContain('ainda não há lote completo');
  });

  it('releitura falhou sobre dado anterior: mostra o dado e avisa que está desatualizado', () => {
    penetracao = { data: [PEN], isLoading: false, isError: true, error: { message: 'connection failure' } };
    const r = desenhar();
    expect(r.container.textContent).toContain('1 cli.');
    expect(screen.getByTestId('radar-ranking-penetracao-aviso').textContent).toContain('Penetração desatualizada');
  });

  it('penetração ainda carregando: "… cli." na linha, sem aviso de falha', () => {
    penetracao = { data: undefined, isLoading: true, isError: false, error: null };
    const r = desenhar();
    expect(r.container.textContent).toContain('… cli.');
    expect(screen.queryByTestId('radar-ranking-penetracao-aviso')).toBeNull();
  });
});

describe('RadarRankingCidades — "Para visitar" (dimensão do agregado, migration 20261111160000)', () => {
  const comVisitar = (f: Partial<RadarFiltros>) =>
    render(<RadarRankingCidades filtros={{ ...filtros, ...f } as RadarFiltros} hojeISO="2026-11-09" onPick={() => {}} />);

  it('chip ligado e a resposta aplicou: diz de quando é a contagem, sem o aviso de "não aplica"', () => {
    contagem = { data: [{ ...MUNI, para_visitar: 812, para_visitar_total: 812, visitar_contado_em: '2026-11-09T10:35:00Z' }], isLoading: false, isError: false, error: null };
    comVisitar({ paraVisitar: true });
    expect(screen.getByTestId('radar-ranking-visitar-contado').textContent).toContain('09/11 07:35');
    expect(screen.queryByTestId('radar-ranking-sem-visitar')).toBeNull();
  });

  it('chip ligado e a resposta NÃO aplicou (caminho vivo / dimensão indisponível): o aviso continua', () => {
    contagem = { data: [{ ...MUNI, para_visitar: null, para_visitar_total: null, visitar_contado_em: null }], isLoading: false, isError: false, error: null };
    comVisitar({ paraVisitar: true });
    expect(screen.getByTestId('radar-ranking-sem-visitar')).toBeTruthy();
    expect(screen.queryByTestId('radar-ranking-visitar-contado')).toBeNull();
  });

  it('chip desligado: nenhum dos dois avisos', () => {
    contagem = { data: [{ ...MUNI, para_visitar: 3, para_visitar_total: 3, visitar_contado_em: '2026-11-09T10:35:00Z' }], isLoading: false, isError: false, error: null };
    comVisitar({ paraVisitar: false });
    expect(screen.queryByTestId('radar-ranking-sem-visitar')).toBeNull();
    expect(screen.queryByTestId('radar-ranking-visitar-contado')).toBeNull();
  });
});
