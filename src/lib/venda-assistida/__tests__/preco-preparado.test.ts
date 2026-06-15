import { describe, it, expect } from 'vitest';
import {
  litrosDaEmbalagem,
  precoLitroPreparado,
  type EmbalagemPreco,
} from '../preco-preparado';

describe('litrosDaEmbalagem (de-para confirmado pelo founder 2026-06-14)', () => {
  it('GL: 3,6 normal / 3,24 se base', () => {
    expect(litrosDaEmbalagem('GL', 'PRIMER PU FL.6269.02GL')).toBe(3.6);
    expect(litrosDaEmbalagem('GL', 'BASE PU METALLIC PEARL MULT TOTAL WFOB.6736GL')).toBe(3.24);
  });
  it('QT: 0,9 normal / 0,81 se base', () => {
    expect(litrosDaEmbalagem('QT', 'WP12.3900QT CONCENTRADO PRETO')).toBe(0.9);
    expect(litrosDaEmbalagem('QT', 'BASE FUNDO ACAB PU TRANSP WFOT.6529QT')).toBe(0.81);
  });
  it('BH: 20 normal / 18 se base', () => {
    expect(litrosDaEmbalagem('BH', 'VERNIZ PU FO20.6827.00BH')).toBe(20);
    expect(litrosDaEmbalagem('BH', 'BASE BRILH BRANC PU WFBB.6045BH')).toBe(18);
  });
  it('LT/L5/BB/BD: valor único (sem variante base)', () => {
    expect(litrosDaEmbalagem('LT', 'F ACAB FL20.6468.00LT')).toBe(18);
    expect(litrosDaEmbalagem('L5', 'qualquer L5')).toBe(5);
    expect(litrosDaEmbalagem('BB', 'qualquer BB')).toBe(5);
    expect(litrosDaEmbalagem('BD', 'qualquer BD')).toBe(18);
    // base na descrição NÃO muda os tamanhos que não são QT/GL/BH
    expect(litrosDaEmbalagem('BD', 'BASE qualquer BD')).toBe(18);
  });
  it('fracionado 405ML: a DESCRIÇÃO manda, mesmo com sufixo QT (item-pai)', () => {
    expect(litrosDaEmbalagem('QT', 'ISOLANTE PU FI.6197 405ML')).toBe(0.405);
    expect(litrosDaEmbalagem('QT', 'ISOLANTE PU FI.6197 405 ML')).toBe(0.405);
  });
  it('CGL e sufixo desconhecido → null (sob consulta), nunca chute', () => {
    expect(litrosDaEmbalagem('CGL', 'qualquer CGL')).toBeNull();
    expect(litrosDaEmbalagem('XX', 'qualquer')).toBeNull();
    expect(litrosDaEmbalagem('', '')).toBeNull();
  });
  it('case-insensitive no sufixo e na palavra base', () => {
    expect(litrosDaEmbalagem('gl', 'base fundo wfot.gl')).toBe(3.24);
    expect(litrosDaEmbalagem('Qt', 'BASE algo')).toBe(0.81);
  });
  it('"base" é palavra, não substring (não casa "baseado"/"database")', () => {
    expect(litrosDaEmbalagem('GL', 'PRODUTO BASEADO EM AGUA GL')).toBe(3.6);
  });
});

const emb = (valor: number, litros: number | null): EmbalagemPreco => ({ valor, litros });

describe('precoLitroPreparado (catalisado, % da base, (B+rC)/(1+r))', () => {
  it('escolhe a MAIOR embalagem de base com litros conhecidos', () => {
    // QT base 0,81 (R$81 → R$100/L) vs GL base 3,24 (R$324 → R$100/L) → usa a maior (GL)
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(81, 0.81), emb(324, 3.24)],
      catalisadorEmbalagens: null,
      proporcaoPct: null,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.litrosBaseUsada).toBe(3.24);
      expect(r.precoLitroBase).toBe(100);
    }
  });

  it('produto 1-componente (sem catalisador) → preparado = a própria base', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],
      catalisadorEmbalagens: null,
      proporcaoPct: null,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.valorLitroPreparado).toBe(100);
      expect(r.precoLitroCatalisador).toBeNull();
    }
  });

  it('catalisado 10%: (B + 0,1·C)/1,1 — B=100, C=200 → (100+20)/1,1 = 109,0909', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],          // B = 100/L
      catalisadorEmbalagens: [emb(180, 0.9)],   // C = 200/L
      proporcaoPct: 10,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.valorLitroPreparado).toBeCloseTo((100 + 0.1 * 200) / 1.1, 4);
      expect(r.precoLitroCatalisador).toBe(200);
    }
  });

  it('🔴 catalisador OBRIGATÓRIO (r>0) ausente → incomplete, NUNCA soma como zero', () => {
    const semCat = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],
      catalisadorEmbalagens: null,
      proporcaoPct: 10,
    });
    expect(semCat.status).toBe('incomplete');
    // falsificação: se tratasse ausente como zero, daria (100+0)/1,1 = 90,9 (preço ERRADO mais barato)
    if (semCat.status === 'ok') throw new Error('catalisador ausente virou preço — bug money-path');

    const catSemLitros = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],
      catalisadorEmbalagens: [emb(180, null)],  // sem litros → não dá pra precificar
      proporcaoPct: 10,
    });
    expect(catSemLitros.status).toBe('incomplete');
  });

  it('base sem litros conhecidos → incomplete (sob consulta)', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(360, null)],
      catalisadorEmbalagens: [emb(180, 0.9)],
      proporcaoPct: 10,
    });
    expect(r.status).toBe('incomplete');
  });

  it('base vazia → incomplete', () => {
    const r = precoLitroPreparado({ baseEmbalagens: [], catalisadorEmbalagens: null, proporcaoPct: null });
    expect(r.status).toBe('incomplete');
  });

  it('guards: valor/litros <=0, NaN, Infinity → embalagem ignorada', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(0, 3.6), emb(-10, 3.6), emb(NaN, 3.6), emb(360, 0)],
      catalisadorEmbalagens: null,
      proporcaoPct: null,
    });
    expect(r.status).toBe('incomplete'); // nenhuma válida
  });

  it('proporcaoPct=0 trata como sem catalisador (= base)', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],
      catalisadorEmbalagens: [emb(180, 0.9)],
      proporcaoPct: 0,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.valorLitroPreparado).toBe(100);
  });
});
