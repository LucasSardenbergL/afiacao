import { describe, expect, it } from 'vitest';
import {
  agruparFamilias,
  baselineDre,
  fnv1a32,
  inverterOpcoes,
  LINHAS_DRE,
  mascararCodigos,
  montarItemDre,
  montarItensBoletim,
  NENHUM,
  NENHUMA,
  particao,
} from './dados';

const CANDIDATOS = [
  { account: 'vendas', omie_codigo_produto: 1, codigo: 'P1', descricao: 'VERNIZ PU BRILHANTE FO20.6827.00GL' },
  { account: 'vendas', omie_codigo_produto: 2, codigo: 'P2', descricao: 'VERNIZ PU BRILHANTE FO20.6827.00QT' },
  { account: 'colacor_vendas', omie_codigo_produto: 3, codigo: 'P3', descricao: 'VERNIZ PU BRILHANTE FO20.6827.00GL' },
  { account: 'vendas', omie_codigo_produto: 4, codigo: 'P4', descricao: 'SELADORA FO20.6828.00GL' },
  { account: 'vendas', omie_codigo_produto: 5, codigo: 'P5', descricao: 'KIT FO20.6827.00GL + FC.1234.00QT' },
  { account: 'vendas', omie_codigo_produto: 6, codigo: 'P6', descricao: 'LIXA 6827 GRAO 220' },
];

const SPEC = {
  spec_id: 's1',
  product_code: 'FO20.6827.00',
  product_name: 'Verniz PU Brilhante',
  doc_title: 'Boletim FO20.6827.00',
  doc_texto: 'Verniz PU brilhante FO20.6827.00. Rendimento 10 m2/L. Catalisador FC.1234.00.',
};

describe('agruparFamilias — 1 boletim → N embalagens: a unidade é a FÓRMULA (código-base)', () => {
  const fam = agruparFamilias('FO20.6827.00', CANDIDATOS);

  it('4 famílias na ordem de 1ª aparição (a ordem da RPC)', () => {
    expect(fam.map((f) => f.grupoChave)).toEqual([
      'B:FO20.6827.00',
      'B:FO20.6828.00',
      'B:FC.1234.00+FO20.6827.00',
      'D:LIXA 6827 GRAO 220',
    ]);
  });

  it('a família exata junta embalagens E contas (GL/QT, vendas/colacor_vendas)', () => {
    expect(fam[0].membros.map((m) => m.omie_codigo_produto)).toEqual([1, 2, 3]);
    expect(fam[0].exata).toBe(true);
  });

  it('kit com DUAS bases não é o produto (ambíguo ⇒ nunca exata)', () => {
    expect(fam[2].exata).toBe(false);
  });
});

describe('montarItensBoletim — prata + negativo sintético + prata mascarada', () => {
  const itens = montarItensBoletim(SPEC, CANDIDATOS);
  const porTipo = Object.fromEntries(itens.map((i) => [i.tipoGabarito, i]));

  it('família exata única ⇒ 3 variantes', () => {
    expect(itens.map((i) => i.tipoGabarito)).toEqual(['prata', 'sintetico_negativo', 'prata_mascarada']);
  });

  it('prata: gabarito = a família exata; baseline escolhe a MESMA (por construção)', () => {
    const p = porTipo.prata;
    expect(p.opcoes.at(-1)?.chave).toBe(NENHUM);
    expect(p.opcoes).toHaveLength(5);
    expect(p.gabarito).toEqual([p.opcoes[0].chave]);
    expect(p.baseline).toBe(p.opcoes[0].chave);
    expect(p.grupo).toBe('B:FO20.6827.00');
  });

  it('negativo: a família certa SAI das opções ⇒ a resposta certa é "nenhum"; baseline abstém', () => {
    const n = porTipo.sintetico_negativo;
    expect(n.opcoes).toHaveLength(4);
    expect(n.opcoes.some((o) => o.chave.includes('VERNIZ'))).toBe(false);
    expect(n.gabarito).toEqual([NENHUM]);
    expect(n.baseline).toBeNull();
  });

  it('mascarada: nenhum código sobra no estado nem nas opções; baseline abstém', () => {
    const m = porTipo.prata_mascarada;
    const tudo = JSON.stringify([m.state, m.opcoes]);
    expect(tudo).not.toMatch(/6827/);
    expect(tudo).not.toMatch(/FO20/);
    expect(m.gabarito).toEqual([m.opcoes[0].chave]);
    expect(m.baseline).toBeNull();
  });

  it('chaves das opções são ÚNICAS mesmo quando o mascaramento as colide', () => {
    for (const it of itens) {
      const chaves = it.opcoes.map((o) => o.chave);
      expect(new Set(chaves).size).toBe(chaves.length);
    }
  });

  it('sem família exata ⇒ 1 item SEM gabarito (resíduo: vai para adjudicação humana)', () => {
    const r = montarItensBoletim({ ...SPEC, product_code: 'XX.9999.00' }, CANDIDATOS);
    expect(r).toHaveLength(1);
    expect(r[0].tipoGabarito).toBe('sem_gabarito');
    expect(r[0].gabarito).toBeNull();
    expect(r[0].baseline).toBeNull();
  });

  it('sem candidatos ⇒ nenhum item (falha de RECUPERAÇÃO, contada à parte — não vai ao modelo)', () => {
    expect(montarItensBoletim(SPEC, [])).toEqual([]);
  });
});

describe('mascararCodigos', () => {
  it('tira códigos com e sem sufixo e números de 3+ dígitos; preserva números curtos', () => {
    const t = mascararCodigos('Verniz FO20.6827.00 rende 10 m2/L, 3,6 L; embalagem FO20.6827.00GL lote 2024', [
      'FO20.6827.00',
    ]);
    expect(t).toBe('Verniz [cód] rende 10 m2/L, 3,6 L; embalagem [cód] lote [cód]');
  });
});

describe('baselineDre — as 9 regex da edge fin-suggest-mapping, em ordem, 1ª que casa', () => {
  it('casos diretos', () => {
    expect(baselineDre('Honorários advocatícios')).toBe('despesas_administrativas');
    expect(baselineDre('Fretes sobre vendas')).toBe('despesas_comerciais');
    expect(baselineDre('Rendimentos de aplicações')).toBe('receitas_financeiras');
    expect(baselineDre('Custo das mercadorias vendidas')).toBe('cmv');
    expect(baselineDre('Material de limpeza')).toBeNull();
  });

  it('falso positivo REAL da regex: "iss" dentro de "Comissões" ⇒ impostos', () => {
    expect(baselineDre('Comissões sobre vendas')).toBe('impostos');
  });
});

describe('montarItemDre', () => {
  it('11 linhas + "nenhuma"; gabarito do seed quando há; baseline = regex', () => {
    const it1 = montarItemDre({ company: 'oben', omie_codigo: '3.01.03', descricao: 'Aluguel' }, 'despesas_administrativas');
    expect(it1.opcoes).toHaveLength(12);
    expect(it1.opcoes.at(-1)?.chave).toBe(NENHUMA);
    expect(it1.gabarito).toEqual(['despesas_administrativas']);
    expect(it1.tipoGabarito).toBe('seed');
    expect(it1.baseline).toBe('despesas_administrativas');
    expect(it1.grupo).toBe('oben:3.01.03');
  });
  it('sem seed ⇒ sem gabarito', () => {
    const it2 = montarItemDre({ company: 'oben', omie_codigo: '9.99', descricao: 'Material de limpeza' }, null);
    expect(it2.gabarito).toBeNull();
    expect(it2.tipoGabarito).toBe('sem_gabarito');
  });
  it('LINHAS_DRE tem as 11 da edge', () => {
    expect(LINHAS_DRE.map((l) => l.chave)).toHaveLength(11);
  });
});

describe('ordem e partição', () => {
  it('inverterOpcoes inverte TUDO, inclusive a posição do "nenhum"', () => {
    const inv = inverterOpcoes([{ chave: 'a', descricao: null }, { chave: 'b', descricao: null }, { chave: NENHUM, descricao: null }]);
    expect(inv.map((o) => o.chave)).toEqual([NENHUM, 'b', 'a']);
  });
  it('FNV-1a 32 (vetor oficial: "a" = 0xe40c292c)', () => {
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });
  it('partição determinística pelo GRUPO (irmãos nunca ficam dos dois lados)', () => {
    expect(particao('a')).toBe('dev'); // 0xe40c292c é par
    expect(particao('abc')).toBe('teste'); // 0x1a47e90b é ímpar
    expect(particao('B:FO20.6827.00')).toBe(particao('B:FO20.6827.00'));
  });
});
