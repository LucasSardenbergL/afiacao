import { describe, it, expect } from 'vitest';
import { mesclarResultados, docsParaExtrair } from '../extraction-drafts';
import type { ResultadoExtracao } from '../aprovacao-fila';
import type { KbExtractedSpec } from '../specs-types';

// Spec mínima para testes — todos os campos obrigatórios preenchidos com defaults
function makeSpec(overrides: Partial<KbExtractedSpec> = {}): KbExtractedSpec {
  return {
    product_code: 'TST.001',
    product_name: 'Produto Teste',
    supplier: 'sayerlack',
    product_line: null,
    product_category: null,
    densidade_g_cm3: null,
    solidos_pct: null,
    viscosidade_aplicacao_s: null,
    viscosidade_copo: null,
    brilho_ub: null,
    dureza: null,
    rendimento_m2_por_litro: null,
    demaos_recomendadas: null,
    gramatura_g_m2_min: null,
    gramatura_g_m2_max: null,
    pot_life_horas: null,
    temp_aplicacao_c_min: null,
    temp_aplicacao_c_max: null,
    umidade_aplicacao_pct_min: null,
    umidade_aplicacao_pct_max: null,
    catalisador_codigo: null,
    catalisador_proporcao_pct: null,
    diluente_codigo: null,
    equipamentos_aplicacao: [],
    lixa_recomendada: null,
    substrato: [],
    secagem_manuseio_h: null,
    secagem_empilhamento_h: null,
    secagem_total_h: null,
    validade_dias: null,
    temp_armazenamento_c_min: null,
    temp_armazenamento_c_max: null,
    certificacoes_aplicaveis: [],
    isento_metais_pesados: [],
    isento_substancias: [],
    diferenciais_chave: [],
    uso_recomendado: null,
    publico_alvo: null,
    extraction_confidence: 0.9,
    extraction_gaps: [],
    ...overrides,
  };
}

function makeResultado(documentId: string, overrides: Partial<KbExtractedSpec> = {}): ResultadoExtracao {
  return { documentId, spec: makeSpec(overrides) };
}

// ── mesclarResultados ─────────────────────────────────────────────────────────

describe('mesclarResultados', () => {
  it('retorna lista vazia quando banco e memória estão vazios', () => {
    expect(mesclarResultados([], [])).toEqual([]);
  });

  it('retorna só o banco quando memória está vazia', () => {
    const banco = [makeResultado('doc-1'), makeResultado('doc-2')];
    const resultado = mesclarResultados(banco, []);
    expect(resultado).toHaveLength(2);
    expect(resultado.map((r) => r.documentId)).toEqual(['doc-1', 'doc-2']);
  });

  it('retorna só a memória quando banco está vazio', () => {
    const memoria = [makeResultado('doc-A'), makeResultado('doc-B')];
    const resultado = mesclarResultados([], memoria);
    expect(resultado).toHaveLength(2);
    expect(resultado.map((r) => r.documentId)).toEqual(['doc-A', 'doc-B']);
  });

  it('memória GANHA no dedup — sobrescreve o mesmo documentId do banco', () => {
    const specBanco = makeSpec({ product_name: 'Nome do Banco' });
    const specMemoria = makeSpec({ product_name: 'Nome da Memória' });
    const banco = [{ documentId: 'doc-1', spec: specBanco }];
    const memoria = [{ documentId: 'doc-1', spec: specMemoria }];

    const resultado = mesclarResultados(banco, memoria);
    expect(resultado).toHaveLength(1);
    expect(resultado[0].documentId).toBe('doc-1');
    expect(resultado[0].spec.product_name).toBe('Nome da Memória');
  });

  it('memória aparece antes do banco na lista final (memória primeiro)', () => {
    const banco = [makeResultado('doc-banco')];
    const memoria = [makeResultado('doc-mem')];

    const resultado = mesclarResultados(banco, memoria);
    expect(resultado[0].documentId).toBe('doc-mem');
    expect(resultado[1].documentId).toBe('doc-banco');
  });

  it('itens exclusivos do banco aparecem depois dos de memória', () => {
    const banco = [makeResultado('b-1'), makeResultado('b-2'), makeResultado('shared')];
    const memoria = [makeResultado('shared'), makeResultado('m-1')];

    const resultado = mesclarResultados(banco, memoria);
    const ids = resultado.map((r) => r.documentId);

    // memória primeiro (shared + m-1), depois banco-exclusivos (b-1, b-2)
    expect(ids.indexOf('shared')).toBeLessThan(ids.indexOf('b-1'));
    expect(ids.indexOf('m-1')).toBeLessThan(ids.indexOf('b-1'));
    expect(ids.indexOf('m-1')).toBeLessThan(ids.indexOf('b-2'));
    // shared aparece só UMA vez
    expect(ids.filter((id) => id === 'shared')).toHaveLength(1);
  });

  it('não duplica documentos que existem só no banco', () => {
    const banco = [makeResultado('doc-1'), makeResultado('doc-2'), makeResultado('doc-3')];
    const resultado = mesclarResultados(banco, []);
    expect(resultado).toHaveLength(3);
  });

  it('não duplica documentos que existem só na memória', () => {
    const memoria = [makeResultado('doc-A'), makeResultado('doc-B')];
    const resultado = mesclarResultados([], memoria);
    expect(resultado).toHaveLength(2);
  });

  it('dedup múltiplos documentos compartilhados — todos resolvidos pela memória', () => {
    const banco = [makeResultado('doc-1'), makeResultado('doc-2'), makeResultado('doc-3')];
    const memoria = [
      makeResultado('doc-1', { product_name: 'Mem1' }),
      makeResultado('doc-2', { product_name: 'Mem2' }),
    ];

    const resultado = mesclarResultados(banco, memoria);
    expect(resultado).toHaveLength(3); // doc-1, doc-2, doc-3
    const map = Object.fromEntries(resultado.map((r) => [r.documentId, r.spec.product_name]));
    expect(map['doc-1']).toBe('Mem1');
    expect(map['doc-2']).toBe('Mem2');
    expect(map['doc-3']).toBe('Produto Teste'); // banco
  });
});

// ── docsParaExtrair ───────────────────────────────────────────────────────────

describe('docsParaExtrair', () => {
  it('retorna lista vazia quando filaIds está vazia', () => {
    expect(docsParaExtrair([], new Set())).toEqual([]);
  });

  it('retorna todos os IDs quando não há rascunhos prontos', () => {
    const ids = ['doc-1', 'doc-2', 'doc-3'];
    expect(docsParaExtrair(ids, new Set())).toEqual(ids);
  });

  it('filtra IDs que já têm rascunho ready', () => {
    const ids = ['doc-1', 'doc-2', 'doc-3'];
    const draftsReady = new Set(['doc-2']);
    expect(docsParaExtrair(ids, draftsReady)).toEqual(['doc-1', 'doc-3']);
  });

  it('retorna lista vazia quando todos têm rascunho ready', () => {
    const ids = ['doc-1', 'doc-2'];
    const draftsReady = new Set(['doc-1', 'doc-2']);
    expect(docsParaExtrair(ids, draftsReady)).toEqual([]);
  });

  it('preserva a ordem dos IDs originais', () => {
    const ids = ['z', 'a', 'm', 'b'];
    const draftsReady = new Set(['m']);
    expect(docsParaExtrair(ids, draftsReady)).toEqual(['z', 'a', 'b']);
  });

  it('IDs no Set que não estão na fila são ignorados (sem efeito)', () => {
    const ids = ['doc-1', 'doc-2'];
    const draftsReady = new Set(['doc-99']); // não está na fila
    expect(docsParaExtrair(ids, draftsReady)).toEqual(['doc-1', 'doc-2']);
  });
});
