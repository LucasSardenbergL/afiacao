import { describe, it, expect } from 'vitest';
import { itensDesativados, itensDesativadosMessage, type AtivoRow, type ItemComCodigo } from '../ativoGate';

const item = (over: Partial<ItemComCodigo> = {}): ItemComCodigo => ({
  omie_codigo_produto: 1001,
  descricao: 'Produto X',
  ...over,
});

describe('itensDesativados — semântica #894 (só ativo===false bloqueia)', () => {
  it('bloqueia produto com ativo=false', () => {
    const rows: AtivoRow[] = [{ omie_codigo_produto: 1001, ativo: false }];
    expect(itensDesativados([item({ omie_codigo_produto: 1001 })], rows)).toEqual([
      { omie_codigo_produto: 1001, descricao: 'Produto X' },
    ]);
  });

  it('libera ativo=true', () => {
    const rows: AtivoRow[] = [{ omie_codigo_produto: 1001, ativo: true }];
    expect(itensDesativados([item({ omie_codigo_produto: 1001 })], rows)).toEqual([]);
  });

  it('libera ativo=null (coluna default true; ausência ≠ desativação)', () => {
    const rows: AtivoRow[] = [{ omie_codigo_produto: 1001, ativo: null }];
    expect(itensDesativados([item({ omie_codigo_produto: 1001 })], rows)).toEqual([]);
  });

  it('libera produto AUSENTE do espelho (espelho desatualizado não trava venda legítima)', () => {
    expect(itensDesativados([item({ omie_codigo_produto: 1001 })], [])).toEqual([]);
  });

  it('deduplica o mesmo código inativo repetido', () => {
    const rows: AtivoRow[] = [{ omie_codigo_produto: 1001, ativo: false }];
    const r = itensDesativados([item({ omie_codigo_produto: 1001 }), item({ omie_codigo_produto: 1001 })], rows);
    expect(r).toHaveLength(1);
  });

  it('casa código string com linha numérica (bigint vem como number/string)', () => {
    const rows: AtivoRow[] = [{ omie_codigo_produto: 1001, ativo: false }];
    expect(itensDesativados([item({ omie_codigo_produto: '1001' })], rows)).toHaveLength(1);
  });

  it('ignora item com código não-numérico (NaN não é "desativado")', () => {
    const rows: AtivoRow[] = [{ omie_codigo_produto: 1001, ativo: false }];
    expect(itensDesativados([item({ omie_codigo_produto: undefined })], rows)).toEqual([]);
  });

  it('preserva a ordem original e só os inativos', () => {
    const rows: AtivoRow[] = [
      { omie_codigo_produto: 1001, ativo: false },
      { omie_codigo_produto: 3003, ativo: false },
    ];
    const r = itensDesativados(
      [item({ omie_codigo_produto: 3003 }), item({ omie_codigo_produto: 2002 }), item({ omie_codigo_produto: 1001 })],
      rows,
    );
    expect(r.map((i) => i.omie_codigo_produto)).toEqual([3003, 1001]);
  });
});

describe('itensDesativadosMessage', () => {
  it('cita descrição quando há', () => {
    const msg = itensDesativadosMessage([{ omie_codigo_produto: 1001, descricao: 'Tinta Y' }]);
    expect(msg).toMatch(/desativad/i);
    expect(msg).toContain('Tinta Y');
  });

  it('cai pro código quando não há descrição', () => {
    expect(itensDesativadosMessage([{ omie_codigo_produto: 4004 }])).toContain('4004');
  });
});
