import { describe, expect, it } from 'vitest';
import { agruparPorFaixa, mensagemRegua, normalizarFila, normalizarRegua, ordenarFila, ordenarRegua, parseValorBR, proximosEstados, telefoneWa, variacaoCoorte, type FilaItem, type ReguaItem } from '../cobranca-helpers';

const linha = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  company: 'oben', omie_codigo_cliente: 10, nome_cliente: 'CLI DEZ', saldo_vencido: '300.50', n_vencidas: 2, dias_vencido_max: 60, faixa: '46-90d',
  dona_user_id: 'u1', dona_nome: 'Regina', caso_id: null, estado: 'a_contatar', proximo_contato_em: null, nota_atual: null, atualizado_em: null,
  promessa_id: null, promessa_data: null, promessa_valor: null, promessa_situacao: null, saldo_inicial_coorte: 500, n_titulos_coorte: 3,
  saldo_atual_coorte: 300, coorte_corte_em: '2026-10-31', ultimo_contato_em: null, n_contatos: 0, pode_agir: true, pode_quitar: false, ...o,
});

describe('normalizarFila — ausente ≠ zero, domínio fechado', () => {
  it('numeric em string vira número; nulos ficam null; estado fora do domínio cai em a_contatar', () => {
    const f = normalizarFila(linha())!;
    expect(f.saldoVencido).toBe(300.5);
    expect(f.faixa).toBe('46-90d');
    expect(f.promessaValor).toBeNull();
    expect(normalizarFila(linha({ estado: 'voando' }))!.estado).toBe('a_contatar');
    expect(normalizarFila(linha({ estado: 'cancelado_gestao' }))!.estado).toBe('cancelado_gestao');
    expect(normalizarFila(linha({ promessa_situacao: 'cumprida' }))!.promessaSituacao).toBeNull();
    expect(normalizarFila(linha({ promessa_situacao: 'saldo_caiu' }))!.promessaSituacao).toBe('saldo_caiu');
    expect(normalizarFila(linha({ faixa: 'x' }))!.faixa).toBeNull();
    expect(normalizarFila(linha({ pode_agir: 'true' }))!.podeAgir).toBe(false);
  });
  it('sem cliente ou sem empresa → descartada', () => {
    expect(normalizarFila(linha({ omie_codigo_cliente: null }))).toBeNull();
    expect(normalizarFila(linha({ company: '' }))).toBeNull();
  });
  it('saldo "NaN" é null, não 0', () => {
    expect(normalizarFila(linha({ saldo_vencido: 'NaN' }))!.saldoVencido).toBeNull();
  });
});

describe('agruparPorFaixa — recentes primeiro; soma só quando todos têm saldo', () => {
  const it_ = (o: Partial<FilaItem>): FilaItem => ({ ...normalizarFila(linha())!, ...o });
  it('ordem <=45d, 46-90d, >90d, sem_vencido', () => {
    const g = agruparPorFaixa([it_({ faixa: '>90d' }), it_({ faixa: '<=45d', saldoVencido: 10 }), it_({ faixa: null, saldoVencido: null }), it_({ faixa: '<=45d', saldoVencido: 5 })]);
    expect(g.map((x) => x.faixa)).toEqual(['<=45d', '>90d', 'sem_vencido']);
    expect(g[0].saldo).toBe(15);
    expect(g[2].saldo).toBeNull();
  });
  it('um saldo null no grupo → soma null (nunca soma com 0 fabricado)', () => {
    const g = agruparPorFaixa([it_({ faixa: '<=45d', saldoVencido: 10 }), it_({ faixa: '<=45d', saldoVencido: null })]);
    expect(g[0].saldo).toBeNull();
  });
});

describe('ordenarFila / ordenarRegua — a ordem de tela é refeita após a paginação por chave estável', () => {
  const it_ = (o: Partial<FilaItem>): FilaItem => ({ ...normalizarFila(linha())!, ...o });
  it('faixa (recentes primeiro, sem faixa por último), saldo DESC, código', () => {
    const r = ordenarFila([it_({ omieCodigoCliente: 1, faixa: '>90d', saldoVencido: 900 }), it_({ omieCodigoCliente: 2, faixa: '<=45d', saldoVencido: 10 }),
      it_({ omieCodigoCliente: 3, faixa: null, saldoVencido: null }), it_({ omieCodigoCliente: 4, faixa: '<=45d', saldoVencido: 50 })]);
    expect(r.map((x) => x.omieCodigoCliente)).toEqual([4, 2, 1, 3]);
  });
  it('régua: D+7, D+1, D−2; saldo DESC', () => {
    const base = normalizarRegua({ marco: 'D-2', company: 'oben', omie_codigo_cliente: 1, omie_codigo_lancamento: 1, data_vencimento: '2026-11-02', saldo: 10 })!;
    const r = ordenarRegua([base, { ...base, marco: 'D+1', omieCodigoLancamento: 2, saldo: 5 }, { ...base, marco: 'D+7', omieCodigoLancamento: 3, saldo: 1 }, { ...base, marco: 'D+1', omieCodigoLancamento: 4, saldo: 50 }]);
    expect(r.map((x) => x.omieCodigoLancamento)).toEqual([3, 4, 2, 1]);
  });
});

describe('proximosEstados / variacaoCoorte', () => {
  it('nunca oferece o atual nem promessa (ação própria)', () => {
    expect(proximosEstados('contatado')).toEqual(['a_contatar', 'pago_informado', 'negociado', 'disputa']);
    expect(proximosEstados('promessa')).not.toContain('promessa');
  });
  it('variação pelos títulos CONGELADOS (não pelo vencido total); atual desconhecido → null, nunca 0', () => {
    const f = normalizarFila(linha({ saldo_inicial_coorte: 500, saldo_atual_coorte: 300, saldo_vencido: 900 }))!;
    expect(variacaoCoorte(f)).toEqual({ inicial: 500, atual: 300, variacao: 200 });
    expect(variacaoCoorte(normalizarFila(linha({ saldo_inicial_coorte: null }))!)).toBeNull();
    expect(variacaoCoorte(normalizarFila(linha({ saldo_atual_coorte: null }))!)).toBeNull();
  });
});

describe('parseValorBR — gramática monetária fechada (nunca ×100 em silêncio)', () => {
  it('formatos aceitos', () => {
    expect(parseValorBR('1234')).toBe(1234);
    expect(parseValorBR('1234,5')).toBe(1234.5);
    expect(parseValorBR('1.234,50')).toBe(1234.5);
    expect(parseValorBR('1234.50')).toBe(1234.5);
    expect(parseValorBR('1250.50')).toBe(1250.5);
  });
  it('rejeita agrupamento inválido, vazio, zero e negativo', () => {
    expect(parseValorBR('1.2.3')).toBeNull();
    expect(parseValorBR('12.3456')).toBeNull();
    expect(parseValorBR('')).toBeNull();
    expect(parseValorBR('0')).toBeNull();
    expect(parseValorBR('-5')).toBeNull();
    expect(parseValorBR('abc')).toBeNull();
  });
});

describe('telefoneWa — destino válido ou nada', () => {
  it('DDD+número ganha 55; com DDI fica; "(55) 99999-0010" é DDD 55, não DDI', () => {
    expect(telefoneWa('48999990010')).toBe('5548999990010');
    expect(telefoneWa('(55) 99999-0010')).toBe('5555999990010');
    expect(telefoneWa('+55 48 99999-0010')).toBe('5548999990010');
    expect(telefoneWa('4833330000')).toBe('554833330000');
  });
  it('sem dígitos suficientes ou demais → null', () => {
    expect(telefoneWa('')).toBeNull();
    expect(telefoneWa(null)).toBeNull();
    expect(telefoneWa('999')).toBeNull();
    expect(telefoneWa('123456789012345')).toBeNull();
    expect(telefoneWa('sem telefone')).toBeNull();
  });
});

describe('normalizarRegua / mensagemRegua', () => {
  const r = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    marco: 'D+1', company: 'oben', omie_codigo_cliente: 52, nome_cliente: 'CLI D1', omie_codigo_lancamento: 5201, numero_documento: 'NF 123',
    data_vencimento: '2026-10-30', saldo: 90, telefone: '48999990010', dona_user_id: 'u1', caso_id: null, estado: null, pode_agir: true, ...o,
  });
  it('marco fora do domínio ou sem título → descartado', () => {
    expect(normalizarRegua(r({ marco: 'D+3' }))).toBeNull();
    expect(normalizarRegua(r({ omie_codigo_lancamento: null }))).toBeNull();
    expect(normalizarRegua(r())!.marco).toBe('D+1');
  });
  it('mensagem por marco, em pt-BR, com NF, valor e data; D−2 é lembrete (não cobra)', () => {
    const d2 = mensagemRegua(normalizarRegua(r({ marco: 'D-2', data_vencimento: '2026-11-02' }))!, 'Oben');
    expect(d2).toMatch(/lembrar/);
    expect(d2).toMatch(/vence em 02\/11\/2026/);
    expect(d2).not.toMatch(/não identificamos/i);
    const d7 = mensagemRegua(normalizarRegua(r({ marco: 'D+7' }))!, 'Oben');
    expect(d7).toMatch(/7 dias/);
    expect(d7).toMatch(/R\$\s?90,00/);
  });
  it('sem nome e sem saldo não inventa texto', () => {
    const m = mensagemRegua(normalizarRegua(r({ nome_cliente: null, saldo: null, numero_documento: null }))!, 'Oben');
    expect(m).toMatch(/^Olá! Aqui é da Oben\./);
    expect(m).not.toMatch(/R\$/);
  });
});

describe('ReguaItem tipo', () => {
  it('exporta o tipo (compilação)', () => {
    const x: ReguaItem | null = normalizarRegua({ marco: 'D-2', company: 'oben', omie_codigo_cliente: 1, omie_codigo_lancamento: 2, data_vencimento: '2026-11-02' });
    expect(x?.marco).toBe('D-2');
  });
});
