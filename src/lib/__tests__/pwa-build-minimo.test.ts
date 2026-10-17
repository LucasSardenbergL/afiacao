import { describe, it, expect } from 'vitest';
import {
  compararBuild,
  decidirExigencia,
  formatarPrazo,
  lerConfigBuildMinimo,
  type BuildMinimo,
} from '@/lib/pwa-build-minimo';

const MINIMO = '2026-10-17T15:00:00.000Z';
const PRAZO = '2026-10-20T21:00:00.000Z';
const CONFIG: BuildMinimo = { buildMinimoEm: MINIMO, prazo: PRAZO };
const VELHO = '2026-10-16T12:00:00.000Z';
const NOVO = '2026-10-17T15:30:00.000Z';
const ANTES_DO_PRAZO = Date.parse(PRAZO) - 60_000;
const DEPOIS_DO_PRAZO = Date.parse(PRAZO) + 60_000;

describe('lerConfigBuildMinimo (linha pwa_build_minimo de company_config)', () => {
  it('lê o JSON com os dois carimbos', () => {
    expect(lerConfigBuildMinimo(JSON.stringify({ build_minimo_em: MINIMO, prazo: PRAZO }))).toEqual(CONFIG);
  });

  it('linha ausente, JSON quebrado ou campo ilegível → null (sem exigência, nunca tranca o staff)', () => {
    expect(lerConfigBuildMinimo(null)).toBeNull();
    expect(lerConfigBuildMinimo(undefined)).toBeNull();
    expect(lerConfigBuildMinimo('')).toBeNull();
    expect(lerConfigBuildMinimo('{nao é json')).toBeNull();
    expect(lerConfigBuildMinimo('"texto"')).toBeNull();
    expect(lerConfigBuildMinimo('null')).toBeNull();
    expect(lerConfigBuildMinimo(JSON.stringify({ build_minimo_em: MINIMO }))).toBeNull();
    expect(lerConfigBuildMinimo(JSON.stringify({ prazo: PRAZO }))).toBeNull();
    expect(lerConfigBuildMinimo(JSON.stringify({ build_minimo_em: 'ontem', prazo: PRAZO }))).toBeNull();
    expect(lerConfigBuildMinimo(JSON.stringify({ build_minimo_em: MINIMO, prazo: 20261020 }))).toBeNull();
  });
});

describe('compararBuild — o carimbo é ORDENÁVEL (o hash do entry não é)', () => {
  it('anterior ao mínimo → abaixo; igual ou depois → em_dia', () => {
    expect(compararBuild(VELHO, MINIMO)).toBe('abaixo');
    expect(compararBuild(MINIMO, MINIMO)).toBe('em_dia');
    expect(compararBuild(NOVO, MINIMO)).toBe('em_dia');
  });

  it('compara INSTANTE, não texto: fuso diferente do mesmo instante é igual', () => {
    expect(compararBuild('2026-10-17T12:00:00-03:00', MINIMO)).toBe('em_dia');
    expect(compararBuild('2026-10-17T11:59:59-03:00', MINIMO)).toBe('abaixo');
  });

  it('carimbo ausente/ilegível → desconhecido, nunca abaixo', () => {
    expect(compararBuild(null, MINIMO)).toBe('desconhecido');
    expect(compararBuild('desconhecido', MINIMO)).toBe('desconhecido');
  });
});

describe('decidirExigencia — aviso antes do prazo, bloqueio depois', () => {
  const base = { buildEm: VELHO, buildServidorEm: null, config: CONFIG, agora: ANTES_DO_PRAZO };

  it('abaixo do mínimo, antes do prazo → aviso com o prazo', () => {
    expect(decidirExigencia(base)).toEqual({ tipo: 'aviso', prazo: PRAZO });
  });

  it('abaixo do mínimo, depois do prazo → bloqueio', () => {
    expect(decidirExigencia({ ...base, agora: DEPOIS_DO_PRAZO })).toEqual({ tipo: 'bloqueio', prazo: PRAZO });
  });

  it('o instante do prazo já bloqueia (prazo é "até", inclusivo do lado do bloqueio)', () => {
    expect(decidirExigencia({ ...base, agora: Date.parse(PRAZO) }).tipo).toBe('bloqueio');
  });

  it('build no mínimo ou acima → nada, mesmo depois do prazo', () => {
    expect(decidirExigencia({ ...base, buildEm: MINIMO, agora: DEPOIS_DO_PRAZO })).toEqual({ tipo: 'nenhuma' });
    expect(decidirExigencia({ ...base, buildEm: NOVO, agora: DEPOIS_DO_PRAZO })).toEqual({ tipo: 'nenhuma' });
  });

  it('sem config → nada', () => {
    expect(decidirExigencia({ ...base, config: null, agora: DEPOIS_DO_PRAZO })).toEqual({ tipo: 'nenhuma' });
  });

  it('carimbo do build desconhecido → nada (ausência de dado não bloqueia)', () => {
    expect(decidirExigencia({ ...base, buildEm: null, agora: DEPOIS_DO_PRAZO })).toEqual({ tipo: 'nenhuma' });
  });

  it('servidor TAMBÉM abaixo do mínimo (mínimo erguido antes do Publish) → só aviso, nunca bloqueio sem saída', () => {
    expect(decidirExigencia({ ...base, buildServidorEm: VELHO, agora: DEPOIS_DO_PRAZO })).toEqual({
      tipo: 'aviso',
      prazo: PRAZO,
    });
  });

  it('servidor no mínimo → o bloqueio vale (há build bom para baixar)', () => {
    expect(decidirExigencia({ ...base, buildServidorEm: NOVO, agora: DEPOIS_DO_PRAZO }).tipo).toBe('bloqueio');
  });
});

describe('formatarPrazo', () => {
  it('mostra no fuso da operação, não no do aparelho', () => {
    expect(formatarPrazo(PRAZO)).toBe('20/10 às 18:00');
  });
});
