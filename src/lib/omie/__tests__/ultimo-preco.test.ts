import { describe, it, expect } from 'vitest';
import { parseDataFlexivel, mergeUltimoPreco } from '../ultimo-preco';

describe('parseDataFlexivel', () => {
  it('DD/MM/YYYY (Omie dInc) → ms comparável', () => {
    expect(parseDataFlexivel('28/05/2026')).toBe(Date.UTC(2026, 4, 28));
  });
  it('YYYY-MM-DD (order_date_kpi local) → ms', () => {
    expect(parseDataFlexivel('2026-05-28')).toBe(Date.UTC(2026, 4, 28));
  });
  it('ISO completo (com hora) → ms do dia', () => {
    expect(parseDataFlexivel('2026-05-28T13:00:00Z')).toBe(Date.UTC(2026, 4, 28));
  });
  it('formatos comparáveis: DD/MM/YYYY == YYYY-MM-DD do mesmo dia', () => {
    expect(parseDataFlexivel('28/05/2026')).toBe(parseDataFlexivel('2026-05-28'));
  });
  it('vazio/null/lixo → null', () => {
    expect(parseDataFlexivel('')).toBeNull();
    expect(parseDataFlexivel(null)).toBeNull();
    expect(parseDataFlexivel('xx/yy/zzzz')).toBeNull();
    expect(parseDataFlexivel('2026-13-40')).toBeNull(); // mês/dia inválidos
  });
});

describe('mergeUltimoPreco (precedência por data; empate → Omie)', () => {
  it('Omie mais recente → ganha o Omie', () => {
    const r = mergeUltimoPreco(
      { 100: { price: 540, date: '2026-05-01' } },
      { 100: { price: 605, date: '2026-05-28' } },
    );
    expect(r[100]).toEqual({ price: 605, fonte: 'omie' });
  });

  it('local mais recente → ganha o local (pedido novo ainda não no Omie)', () => {
    const r = mergeUltimoPreco(
      { 100: { price: 700, date: '2026-06-02' } },
      { 100: { price: 605, date: '2026-05-28' } },
    );
    expect(r[100]).toEqual({ price: 700, fonte: 'local' });
  });

  it('empate de data → Omie (confirmado no ERP ganha)', () => {
    const r = mergeUltimoPreco(
      { 100: { price: 540, date: '2026-05-28' } },
      { 100: { price: 605, date: '28/05/2026' } },
    );
    expect(r[100]).toEqual({ price: 605, fonte: 'omie' });
  });

  it('só local → usa local', () => {
    const r = mergeUltimoPreco({ 100: { price: 540, date: '2026-05-01' } }, {});
    expect(r[100]).toEqual({ price: 540, fonte: 'local' });
  });

  it('só Omie → usa Omie', () => {
    const r = mergeUltimoPreco({}, { 100: { price: 605, date: '28/05/2026' } });
    expect(r[100]).toEqual({ price: 605, fonte: 'omie' });
  });

  it('datas ambas nulas/ilegíveis → Omie ganha (desempate determinístico)', () => {
    const r = mergeUltimoPreco(
      { 100: { price: 540, date: null } },
      { 100: { price: 605, date: '' } },
    );
    expect(r[100]).toEqual({ price: 605, fonte: 'omie' });
  });

  it('data do vencedor nula mas do outro válida → ganha o que TEM data', () => {
    const r = mergeUltimoPreco(
      { 100: { price: 540, date: '2026-05-28' } },
      { 100: { price: 605, date: null } },
    );
    expect(r[100]).toEqual({ price: 540, fonte: 'local' });
  });

  it('preço <= 0 é ignorado (cai pro outro lado se válido; senão omitido)', () => {
    const r = mergeUltimoPreco(
      { 100: { price: 0, date: '2026-06-10' }, 200: { price: 0, date: '2026-06-10' } },
      { 100: { price: 605, date: '2026-05-28' }, 300: { price: 90, date: '2026-05-28' } },
    );
    expect(r[100]).toEqual({ price: 605, fonte: 'omie' }); // local 0 ignorado, usa Omie
    expect(r[200]).toBeUndefined();                         // ambos inválidos → fora
    expect(r[300]).toEqual({ price: 90, fonte: 'omie' });
  });
});
