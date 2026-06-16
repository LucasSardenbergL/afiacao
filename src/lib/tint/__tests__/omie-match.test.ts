import { describe, it, expect } from 'vitest';
import {
  extrairCodigoBaseInicio,
  parseDescricaoOmie,
  casarLinhaProduto,
  ranquearProdutos,
  sugerirMapeamento,
  type LinhaSku,
  type ProdutoOmieMatch,
} from '../omie-match';

// ── extração do código-base da tint_bases.descricao (código vem no INÍCIO) ──
describe('extrairCodigoBaseInicio', () => {
  it('extrai o código no início, ignorando o resto', () => {
    expect(extrairCodigoBaseInicio('WJOB.7796 - BASE ACRIL FOSCO BRANCA')).toBe('WJOB.7796');
  });
  it('preserva a 2ª parte .00 (não normaliza/remove)', () => {
    expect(extrairCodigoBaseInicio('JO10.7644.00 - VERNIZ ACRILICO')).toBe('JO10.7644.00');
  });
  it('normaliza caixa', () => {
    expect(extrairCodigoBaseInicio('  wjoi.7796 - base inter')).toBe('WJOI.7796');
  });
  it('retorna null quando não há código no início', () => {
    expect(extrairCodigoBaseInicio('BASE ACRIL FOSCO SEM CODIGO')).toBeNull();
  });
  it('não casa código com dígitos a mais na 1ª parte (anti-substring WJOB.77960)', () => {
    expect(extrairCodigoBaseInicio('WJOB.77960 - X')).toBeNull();
  });
  it('lida com null/vazio', () => {
    expect(extrairCodigoBaseInicio(null)).toBeNull();
    expect(extrairCodigoBaseInicio('')).toBeNull();
  });
});

// ── parse da descricao Omie (código + embalagem colados/separados no FIM) ──
describe('parseDescricaoOmie', () => {
  it('código + embalagem colada (GL)', () => {
    expect(parseDescricaoOmie('BASE ACRIL BRANC BRIL 05 WJOB.7796GL')).toEqual({
      codigoBase: 'WJOB.7796',
      embalagem: 'GL',
    });
  });
  it('embalagem separada por espaço (405ML)', () => {
    expect(parseDescricaoOmie('BASE ACRIL INTER BRIL05 WJOI.7796 405ML')).toEqual({
      codigoBase: 'WJOI.7796',
      embalagem: '405ML',
    });
  });
  it('código com 2ª parte .00 + embalagem', () => {
    expect(parseDescricaoOmie('VERNIZ ACRILICO FOSCO JO10.7644.00GL')).toEqual({
      codigoBase: 'JO10.7644.00',
      embalagem: 'GL',
    });
  });
  it('embalagem QT', () => {
    expect(parseDescricaoOmie('BASE ACRIL BRANC BRIL 05 WJOB.7796QT')).toEqual({
      codigoBase: 'WJOB.7796',
      embalagem: 'QT',
    });
  });
  it('anti-substring: código grudado em outra palavra → null', () => {
    expect(parseDescricaoOmie('PRODUTOWJOB.7796GL')).toBeNull();
  });
  it('anti-substring: dígito a mais na 1ª parte → null', () => {
    expect(parseDescricaoOmie('BASE WJOB.77960GL')).toBeNull();
  });
  it('sem código → null', () => {
    expect(parseDescricaoOmie('PRODUTO GENERICO QUALQUER')).toBeNull();
  });
});

// ── casamento estrutural linha×produto (chave dura, igualdade EXATA) ──
describe('casarLinhaProduto', () => {
  const linha = (base: string, emb: string): LinhaSku => ({ baseDescricao: base, embalagemDescricao: emb });
  const prod = (descricao: string): ProdutoOmieMatch => ({ id: 'p', codigo: 'PRD', descricao });

  it('código e embalagem batem', () => {
    expect(casarLinhaProduto(linha('WJOB.7796 - BASE', 'GL'), prod('BASE ... WJOB.7796GL'))).toEqual({
      codigoBateu: true,
      embalagemBateu: true,
    });
  });
  it('WJOB ≠ WJOI: mesmo número, base diferente → código NÃO bate', () => {
    expect(casarLinhaProduto(linha('WJOB.7796 - BRANCA', 'GL'), prod('BASE INTER WJOI.7796GL')).codigoBateu).toBe(
      false,
    );
  });
  it('embalagem diferente (QT vs GL) → embalagem NÃO bate', () => {
    expect(casarLinhaProduto(linha('WJOB.7796 - BASE', 'QT'), prod('BASE ... WJOB.7796GL')).embalagemBateu).toBe(
      false,
    );
  });
  it('sem alias implícito: QT ≠ 810ML', () => {
    expect(casarLinhaProduto(linha('WJOI.7796 - BASE', 'QT'), prod('BASE ... WJOI.7796 810ML')).embalagemBateu).toBe(
      false,
    );
  });
});

// ── sugestão: confiança vem da CARDINALIDADE da chave dura, NÃO do score ──
describe('sugerirMapeamento', () => {
  const linha: LinhaSku = { baseDescricao: 'WJOB.7796 - BASE ACRIL', embalagemDescricao: 'GL' };
  const vazio = new Set<string>();

  it('1 candidato com código+embalagem exatos e único → forte', () => {
    const produtos: ProdutoOmieMatch[] = [
      { id: 'a', codigo: 'PRD03644', descricao: 'BASE ACRIL BRANC BRIL 05 WJOB.7796GL' },
      { id: 'b', codigo: 'PRD03506', descricao: 'BASE ACRIL BRANC BRIL 05 WJOB.7796QT' },
    ];
    expect(sugerirMapeamento(linha, produtos, vazio)).toEqual({ tipo: 'forte', produtoId: 'a' });
  });

  it('FURO CODEX: 2 candidatos com a MESMA chave dura → revisar (score nunca decide forte)', () => {
    const produtos: ProdutoOmieMatch[] = [
      { id: 'a', codigo: 'PRD1', descricao: 'BASE ACRIL FOSCO BRANC WJOB.7796GL' }, // + palavras
      { id: 'b', codigo: 'PRD2', descricao: 'BASE WJOB.7796GL' },
    ];
    const r = sugerirMapeamento(linha, produtos, vazio);
    expect(r.tipo).toBe('revisar');
  });

  it('código bate mas nenhuma embalagem bate → revisar (não forte)', () => {
    const produtos: ProdutoOmieMatch[] = [
      { id: 'a', codigo: 'PRD', descricao: 'BASE ACRIL WJOB.7796QT' }, // só QT, linha é GL
    ];
    const r = sugerirMapeamento(linha, produtos, vazio);
    expect(r.tipo).toBe('revisar');
    if (r.tipo === 'revisar') expect(r.candidatos).toContain('a');
  });

  it('CASO-BORDA: número igual mas base diferente (WJOB vs WJOI) → sem_sugestao', () => {
    const produtos: ProdutoOmieMatch[] = [
      { id: 'a', codigo: 'PRD', descricao: 'BASE ACRIL INTER WJOI.7796GL' },
    ];
    expect(sugerirMapeamento(linha, produtos, vazio)).toEqual({ tipo: 'sem_sugestao' });
  });

  it('o único candidato forte já está mapeado a OUTRA base → revisar (não rouba vínculo)', () => {
    const produtos: ProdutoOmieMatch[] = [
      { id: 'a', codigo: 'PRD03644', descricao: 'BASE ACRIL BRANC BRIL 05 WJOB.7796GL' },
    ];
    const r = sugerirMapeamento(linha, produtos, new Set(['a']));
    expect(r.tipo).toBe('revisar');
  });
});

// ── ranqueamento pro combobox (score SÓ ordena a tela) ──
describe('ranquearProdutos', () => {
  const linha: LinhaSku = { baseDescricao: 'WJOB.7796 - BASE ACRIL FOSCO', embalagemDescricao: 'GL' };

  it('código+embalagem no topo, depois só-código, depois o resto', () => {
    const produtos: ProdutoOmieMatch[] = [
      { id: 'outro', codigo: 'PRD', descricao: 'CONCENTRADO PRETO WP12.3900GL' },
      { id: 'soCodigo', codigo: 'PRD', descricao: 'BASE ACRIL WJOB.7796QT' },
      { id: 'exato', codigo: 'PRD', descricao: 'BASE ACRIL FOSCO BRANC WJOB.7796GL' },
    ];
    const r = ranquearProdutos(linha, produtos);
    expect(r.map((p) => p.id)).toEqual(['exato', 'soCodigo', 'outro']);
    expect(r[0].codigoBateu).toBe(true);
    expect(r[0].embalagemBateu).toBe(true);
  });
});
