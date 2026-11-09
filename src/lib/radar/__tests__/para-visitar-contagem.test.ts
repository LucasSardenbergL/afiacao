/**
 * Pacote N, item 2: o número do chip "Para visitar" é SOB DEMANDA. Antes, uma 2ª `radar_lista` (até 200) a cada
 * troca de filtro — ~5,5 s de pré-corte em prod. Agora o chip desligado não lê nada nem mostra número; ligado, o
 * número sai da própria fila (que já é o recorte "para visitar").
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  cabeNoAgregado, dicaDoChip, rotuloDaContagem, rotuloDoAgregado, totalVisitarDoAgregado,
} from '@/queries/useRadarContatoContabil';
import { visitarAplicado, type RadarMunicipioContagem } from '@/queries/useRadarContagemMunicipios';
import type { RadarFiltros } from '@/queries/useRadarLista';

const fila = (paginas: number[], hasNextPage: boolean, extra: { isPending?: boolean; isError?: boolean } = {}) => ({
  isPending: false, isError: false, hasNextPage,
  data: { pages: paginas.map((n) => Array.from({ length: n })) },
  ...extra,
});

describe('rotuloDaContagem', () => {
  it('chip desligado: sem número e sem leitura (nem "…" eterno)', () => {
    expect(rotuloDaContagem(false, fila([], false, { isPending: true }))).toEqual({ isError: false, data: null, rotulo: '' });
  });
  it('ligado e a fila acabou: o número exato', () => {
    expect(rotuloDaContagem(true, fila([37], false))).toEqual({ isError: false, data: 37, rotulo: '37' });
    expect(rotuloDaContagem(true, fila([0], false)).rotulo).toBe('0');
  });
  it('ligado com página seguinte: "N+" (o que já veio, nunca um total inventado)', () => {
    expect(rotuloDaContagem(true, fila([50, 50], true))).toEqual({ isError: false, data: 100, rotulo: '100+' });
  });
  it('ligado e carregando: "…"; ligado e a fila falhou: "?" (nunca 0)', () => {
    expect(rotuloDaContagem(true, { isPending: true, isError: false, hasNextPage: false }).rotulo).toBe('…');
    expect(rotuloDaContagem(true, { isPending: false, isError: true, hasNextPage: false })).toEqual({ isError: true, data: null, rotulo: '?' });
  });
});

/** Migration 20261111160000: com o chip DESLIGADO o número volta, lido do agregado (dimensão "visitar"). */
const F: RadarFiltros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'novas', incluirSaiuDoDump: false, soIneditos: false, soSugeridos: false,
};

describe('cabeNoAgregado — o recorte da fila que o agregado conhece', () => {
  it('filtros estruturais (UF, CNAE, status, cidade por código) cabem', () => {
    expect(cabeNoAgregado(F)).toBe(true);
    expect(cabeNoAgregado({ ...F, uf: 'MG', cnae: '4744', status: 'a_contatar' })).toBe(true);
    expect(cabeNoAgregado({ ...F, municipio: 'JOINVILLE', municipioCodigo: '8105' })).toBe(true);
  });
  it('busca textual, nome de cidade digitado sem código e "só sugeridos" não cabem: sem número', () => {
    expect(cabeNoAgregado({ ...F, busca: 'tintas' })).toBe(false);
    expect(cabeNoAgregado({ ...F, busca: '   ' })).toBe(true);
    expect(cabeNoAgregado({ ...F, municipio: 'SANTA LUZIA' })).toBe(false);
    expect(cabeNoAgregado({ ...F, soSugeridos: true })).toBe(false);
  });
});

describe('totalVisitarDoAgregado / rotuloDoAgregado — ausente ≠ zero', () => {
  const l = (para_visitar_total: number | null, visitar_contado_em: string | null) => ({ para_visitar_total, visitar_contado_em });
  it('a dimensão serviu: o total do recorte e de quando é', () => {
    expect(totalVisitarDoAgregado([l(1234, '2026-11-09T10:35:00Z')])).toEqual({ n: 1234, contadoEm: '2026-11-09T10:35:00Z' });
    expect(rotuloDoAgregado({ isError: false, data: { n: 1234, contadoEm: 'x' } }).rotulo).toBe('1.234');
    expect(rotuloDoAgregado({ isError: false, data: { n: 0, contadoEm: 'x' } }).rotulo).toBe('0');
  });
  it('resposta vazia (recorte fora dos agregados), dimensão indisponível ou erro: sem número, nunca 0', () => {
    expect(totalVisitarDoAgregado([])).toBeNull();
    expect(totalVisitarDoAgregado([l(null, null)])).toBeNull();
    expect(totalVisitarDoAgregado([l(5, null)])).toBeNull();
    expect(rotuloDoAgregado({ isError: false, data: null })).toEqual({ isError: false, data: null, rotulo: '', contadoEm: null });
    expect(rotuloDoAgregado({ isError: true }).rotulo).toBe('');
  });
  it('a dica do chip desligado diz de quando é a contagem', () => {
    const d = dicaDoChip(false, { isError: false, data: 12, rotulo: '12', contadoEm: '2026-11-09T10:35:00Z' });
    expect(d).toContain('12 neste recorte na contagem de 09/11');
    expect(d).toContain('07:35');
    expect(dicaDoChip(false, { isError: false, data: null, rotulo: '' })).toContain('Ligue para ver quantos há');
    expect(dicaDoChip(true, { isError: true, data: null, rotulo: '?' })).toContain('Não consegui contar');
  });
});

describe('visitarAplicado — o mapa/ranking só dizem que recortaram quando TODA linha traz a data', () => {
  const m = (visitar_contado_em: string | null) => ({ visitar_contado_em }) as RadarMunicipioContagem;
  it('todas com data: aplicou; alguma sem, vazia ou ausente: não', () => {
    expect(visitarAplicado([m('2026-11-09T10:35:00Z'), m('2026-11-09T10:35:00Z')])).toBe(true);
    expect(visitarAplicado([m('2026-11-09T10:35:00Z'), m(null)])).toBe(false);
    expect(visitarAplicado([])).toBe(false);
    expect(visitarAplicado(undefined)).toBe(false);
  });
});

