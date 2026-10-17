// Missão de desova (programa Cabreúva-Colacor, PR2): transforma a fila de excesso
// (diagnóstico) em TAREFA para o comercial (ação), sem tocar preço. A descrição é o
// contrato humano da missão — precisa ser honesta com capital não medido (cmc ausente).
import { describe, it, expect } from 'vitest';
import { formatarMissaoDesova, type AlvoDesova } from '../desova-helpers';

const alvo = (over: Partial<AlvoDesova> = {}): AlvoDesova => ({
  sku_codigo_omie: 12345,
  sku_descricao: 'Lixa 80 rolo 50m',
  excedente_un: 40,
  capital_excedente: 1200,
  tempo_digerir_dias: 90,
  dias_sem_vender: 30,
  ...over,
});

describe('formatarMissaoDesova', () => {
  it('uma linha completa: descrição carrega sku, excedente, digestão e capital; total soma', () => {
    const m = formatarMissaoDesova([alvo()]);
    expect(m.titulo).toBe('Desova de excesso — 1 SKU, R$ 1.200 presos');
    expect(m.descricao).toContain('12345');
    expect(m.descricao).toContain('Lixa 80 rolo 50m');
    expect(m.descricao).toContain('40 un excedentes');
    expect(m.descricao).toContain('digere em 90d');
    expect(m.capitalTotal).toBe(1200);
    expect(m.capitalIncompleto).toBe(false);
  });

  it('capital null (cmc ausente) NÃO vira R$0: linha diz não medido, total ignora e marca parcial', () => {
    const m = formatarMissaoDesova([alvo(), alvo({ sku_codigo_omie: 999, capital_excedente: null })]);
    expect(m.capitalTotal).toBe(1200); // só o medido — nunca soma 0 fabricado
    expect(m.capitalIncompleto).toBe(true);
    expect(m.titulo).toContain('≥ R$ 1.200'); // total parcial vira piso explícito
    expect(m.descricao).toContain('capital não medido');
  });

  it('sem giro (tempo null) é dito, não zerado', () => {
    const m = formatarMissaoDesova([alvo({ tempo_digerir_dias: null })]);
    expect(m.descricao).toContain('sem giro');
    expect(m.descricao).not.toContain('digere em 0');
  });

  it('lista trunca além de 8 SKUs, mas o TOTAL soma todos', () => {
    const alvos = Array.from({ length: 11 }, (_, i) => alvo({ sku_codigo_omie: i + 1, capital_excedente: 100 }));
    const m = formatarMissaoDesova(alvos);
    expect(m.titulo).toBe('Desova de excesso — 11 SKUs, R$ 1.100 presos');
    expect(m.descricao).toContain('… e mais 3 SKUs');
    expect((m.descricao.match(/un excedentes/g) ?? []).length).toBe(8);
  });

  it('descrição sem sku_descricao usa o código, sem inventar nome', () => {
    const m = formatarMissaoDesova([alvo({ sku_descricao: null })]);
    expect(m.descricao).toContain('12345');
    expect(m.descricao).not.toContain('null');
  });
});

describe('formatarMissaoDesova — prefixo do título (missão por cliente do Raio-X)', () => {
  it('(a) com prefixo, o título começa com "Cliente X — "', () => {
    const m = formatarMissaoDesova([alvo()], 'Cliente X');
    expect(m.titulo.startsWith('Cliente X — Desova de excesso')).toBe(true);
    expect(m.descricao.startsWith('Cliente X — Desova de excesso')).toBe(true);
  });

  it('(b) sem prefixo o título é idêntico ao da aba Excesso', () => {
    expect(formatarMissaoDesova([alvo()]).titulo).toBe('Desova de excesso — 1 SKU, R$ 1.200 presos');
    expect(formatarMissaoDesova([alvo()], undefined).titulo).toBe('Desova de excesso — 1 SKU, R$ 1.200 presos');
  });

  it('capital null (sem custo) não vira R$ 0 e dias_sem_vender null é omitido', () => {
    const m = formatarMissaoDesova([alvo({ capital_excedente: null, dias_sem_vender: null })], 'Cliente X');
    expect(m.capitalIncompleto).toBe(true);
    expect(m.descricao).toContain('capital não medido (sem CMC)');
    expect(m.descricao).not.toContain('sem vender');
    expect(m.descricao.split('\n')[2]).not.toMatch(/R\$/); // a linha do SKU não fabrica R$ 0
  });

  it('todos os alvos sem capital: título diz "capital não medido", nunca "R$ 0"', () => {
    const m = formatarMissaoDesova([alvo({ capital_excedente: null }), alvo({ sku_codigo_omie: 2, capital_excedente: null })]);
    expect(m.titulo).toBe('Desova de excesso — 2 SKUs, capital não medido (sem CMC)');
    expect(m.titulo).not.toMatch(/R\$/);
  });

  it('com prefixo (Raio-X) a descrição não cita fila de excesso nem o motor', () => {
    const m = formatarMissaoDesova(Array.from({ length: 10 }, (_, i) => alvo({ sku_codigo_omie: i + 1 })), 'Cliente X');
    expect(m.descricao).toContain('SKUs parados (Raio-X) para oferecer a este cliente.');
    expect(m.descricao).not.toMatch(/fila de excesso|motor/);
  });
});
