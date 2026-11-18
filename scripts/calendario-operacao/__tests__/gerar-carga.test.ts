import { describe, expect, it } from 'vitest';
import { FORNECEDORES_NAO_SAYERLACK, gerarCarga, pascoa } from '../gerar-carga';

const carga = gerarCarga(FORNECEDORES_NAO_SAYERLACK);
const achar = (data: string, empresa: string) => carga.empresa.find((l) => l.data === data && l.empresa === empresa);

describe('pascoa', () => {
  it('calcula a Páscoa gregoriana', () => {
    expect(pascoa(2027)).toBe('2027-03-28');
    expect(pascoa(2030)).toBe('2030-04-21');
    expect(pascoa(2026)).toBe('2026-04-05');
  });
});

describe('gerarCarga — calendário de operação', () => {
  it('dia de volta do recesso (04/01/2027) não tem linha', () => {
    expect(achar('2027-01-04', 'OBEN')).toBeUndefined();
  });
  it('recesso 2026 é manual/fechado', () => {
    expect(achar('2026-12-18', 'OBEN')).toMatchObject({ status: 'fechado', origem: 'manual', peso: 0 });
  });
  it('Carnaval 2027 é meia_equipe com peso 1', () => {
    expect(achar('2027-02-09', 'OBEN')).toMatchObject({ status: 'meia_equipe', peso: 1, origem: 'escala' });
  });
  it('20/11/2026 fechado; 20/11/2025 aberto histórico', () => {
    expect(achar('2026-11-20', 'OBEN')).toMatchObject({ status: 'fechado' });
    expect(achar('2025-11-20', 'OBEN')).toMatchObject({ status: 'aberto', origem: 'historico', peso: 1 });
  });
  it('Sexta Santa não vira meia_equipe (feriado fechado vence a janela)', () => {
    expect(achar('2027-03-26', 'OBEN')).toMatchObject({ status: 'fechado', origem: 'feriado' });
  });
  it('precedência: 01/01/2027 manual; 01/06/2029 emenda; 01/06/2026 histórico', () => {
    expect(achar('2027-01-01', 'OBEN')?.origem).toBe('manual');
    expect(achar('2029-06-01', 'OBEN')?.origem).toBe('emenda');
    expect(achar('2026-06-01', 'OBEN')?.origem).toBe('historico');
  });
  it('Corpus Christi entra como feriado fechado da empresa', () => {
    expect(achar('2027-05-27', 'COLACOR')).toMatchObject({ status: 'fechado', origem: 'feriado' });
  });
  it('nenhuma linha em fim de semana', () => {
    for (const l of carga.empresa) expect([0, 6]).not.toContain(new Date(`${l.data}T12:00:00Z`).getUTCDay());
  });
  it('pendente_dado só na OBEN', () => {
    const p = carga.empresa.filter((l) => l.status === 'pendente_dado');
    expect(p).toHaveLength(7);
    expect(p.every((l) => l.empresa === 'OBEN' && l.peso === 1)).toBe(true);
  });
  it('sem duplicata por (data, empresa) e fechado ⇒ peso 0', () => {
    const chaves = carga.empresa.map((l) => `${l.data}|${l.empresa}`);
    expect(new Set(chaves).size).toBe(chaves.length);
    for (const l of carga.empresa) if (l.status === 'fechado') expect(l.peso).toBe(0);
  });
  it('mesma operação para OBEN e COLACOR (exceto pendente_dado)', () => {
    const f = (e: string) => carga.empresa.filter((l) => l.empresa === e && l.status !== 'pendente_dado').length;
    expect(f('OBEN')).toBe(f('COLACOR'));
  });
});

describe('gerarCarga — fornecedores e feriados', () => {
  it('Sayerlack só fecha 25/12 e 01/01', () => {
    const s = carga.fornecedor.filter((l) => l.fornecedor_nome === 'RENNER SAYERLACK S/A' && l.empresa === 'OBEN');
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((l) => l.data.endsWith('-12-25') || l.data.endsWith('-01-01'))).toBe(true);
  });
  it('demais fornecedores fecham 21/12–03/01', () => {
    const l = carga.fornecedor.filter((x) => x.fornecedor_nome === 'MASTERCOL INDUSTRIA E COMERCIO LTDA' && x.empresa === 'OBEN');
    expect(l.some((x) => x.data === '2026-12-21')).toBe(true);
    expect(l.some((x) => x.data === '2027-01-04')).toBe(false);
  });
  it('feriados nacionais 2027: 10, sem Corpus/Carnaval/Cinzas', () => {
    const n = carga.feriadosNacionais.filter((f) => f.data.startsWith('2027'));
    expect(n).toHaveLength(10);
    expect(n.every((f) => f.tipo === 'nacional')).toBe(true);
    expect(carga.feriadosNacionais.some((f) => f.data === '2027-05-27')).toBe(false);
  });
});
