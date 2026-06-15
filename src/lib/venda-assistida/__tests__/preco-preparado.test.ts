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
    expect(litrosDaEmbalagem('gl', 'base fundo wfot gl')).toBe(3.24);
    expect(litrosDaEmbalagem('Qt', 'BASE algo')).toBe(0.81);
  });
  it('"base" é palavra, não substring (não casa "baseado")', () => {
    expect(litrosDaEmbalagem('GL', 'PRODUTO BASEADO EM AGUA GL')).toBe(3.6);
  });
  it('🔴 Codex P1: separador não-letra (_/dígito/pontuação) conta como base — NÃO subprecificar 10%', () => {
    expect(litrosDaEmbalagem('GL', 'PRODUTO BASE_GL')).toBe(3.24); // _ é word-char no JS → \b falharia
    expect(litrosDaEmbalagem('GL', 'WFOB-BASE-6736 GL')).toBe(3.24);
  });
  it('🔴 Codex P1: acento adjacente NÃO vira falso-positivo de base', () => {
    expect(litrosDaEmbalagem('GL', 'ábase qualquer GL')).toBe(3.6); // "ábase" não é a palavra "base"
    expect(litrosDaEmbalagem('GL', 'baseável GL')).toBe(3.6);
  });
});

const emb = (valor: number, litros: number | null): EmbalagemPreco => ({ valor, litros });

describe('precoLitroPreparado (catalisado, % da base, (B+rC)/(1+r))', () => {
  it('escolhe a MAIOR embalagem de base com litros conhecidos', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(81, 0.81), emb(324, 3.24)], // ambas R$100/L; maior = 3,24
      temCatalisador: false,
      catalisadorEmbalagens: null,
      proporcaoPct: null,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.litrosBaseUsada).toBe(3.24);
      expect(r.precoLitroBase).toBe(100);
    }
  });

  it('produto 1-componente (temCatalisador=false) → preparado = a própria base', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],
      temCatalisador: false,
      catalisadorEmbalagens: null,
      proporcaoPct: null,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.valorLitroPreparado).toBe(100);
      expect(r.precoLitroCatalisador).toBeNull();
    }
  });

  it('catalisado 10%: (B + 0,1·C)/1,1 — B=100, C=200 → (100+20)/1,1', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],          // B = 100/L
      temCatalisador: true,
      catalisadorEmbalagens: [emb(180, 0.9)],   // C = 200/L
      proporcaoPct: 10,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.valorLitroPreparado).toBeCloseTo((100 + 0.1 * 200) / 1.1, 4);
      expect(r.precoLitroCatalisador).toBe(200);
      expect(r.litrosCatalisadorUsada).toBe(0.9);
    }
  });

  it('🔴 Codex P0: temCatalisador + proporção ausente/inválida → incomplete (NÃO vira preço só-da-base)', () => {
    for (const pct of [null, 0, -5, NaN, Infinity]) {
      const r = precoLitroPreparado({
        baseEmbalagens: [emb(360, 3.6)],
        temCatalisador: true,
        catalisadorEmbalagens: [emb(180, 0.9)],
        proporcaoPct: pct as number,
      });
      expect(r.status, `pct=${pct}`).toBe('incomplete');
    }
  });

  it('🔴 catalisador OBRIGATÓRIO ausente → incomplete, NUNCA soma como zero', () => {
    const semCat = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],
      temCatalisador: true,
      catalisadorEmbalagens: null,
      proporcaoPct: 10,
    });
    expect(semCat.status).toBe('incomplete');
    if (semCat.status === 'ok') throw new Error('catalisador ausente virou preço — bug money-path');

    const catSemLitros = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],
      temCatalisador: true,
      catalisadorEmbalagens: [emb(180, null)],
      proporcaoPct: 10,
    });
    expect(catSemLitros.status).toBe('incomplete');
  });

  it('🔴 Codex P1: empate de litros → menor valor vence (determinístico, independe da ordem)', () => {
    const a = precoLitroPreparado({ baseEmbalagens: [emb(360, 3.6), emb(720, 3.6)], temCatalisador: false, catalisadorEmbalagens: null, proporcaoPct: null });
    const b = precoLitroPreparado({ baseEmbalagens: [emb(720, 3.6), emb(360, 3.6)], temCatalisador: false, catalisadorEmbalagens: null, proporcaoPct: null });
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    if (a.status === 'ok' && b.status === 'ok') {
      expect(a.precoLitroBase).toBe(100); // 360/3,6
      expect(a.precoLitroBase).toBe(b.precoLitroBase); // mesma resposta nas duas ordens
    }
  });

  it('🔴 Codex P1: MAIOR embalagem sem preço → incomplete (não substitui por uma menor)', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(0, 18), emb(324, 3.24)], // a maior (18 L) não tem preço
      temCatalisador: false,
      catalisadorEmbalagens: null,
      proporcaoPct: null,
    });
    expect(r.status).toBe('incomplete');
  });

  it('base sem litros / vazia → incomplete', () => {
    expect(precoLitroPreparado({ baseEmbalagens: [emb(360, null)], temCatalisador: false, catalisadorEmbalagens: null, proporcaoPct: null }).status).toBe('incomplete');
    expect(precoLitroPreparado({ baseEmbalagens: [], temCatalisador: false, catalisadorEmbalagens: null, proporcaoPct: null }).status).toBe('incomplete');
  });

  it('guards: valor/litros <=0 → embalagem ignorada', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(0, 3.6), emb(-10, 3.6), emb(NaN, 3.6), emb(360, 0)],
      temCatalisador: false,
      catalisadorEmbalagens: null,
      proporcaoPct: null,
    });
    expect(r.status).toBe('incomplete');
  });

  it('🔴 Codex P2: quociente Infinity (litros minúsculos) → incomplete, não preço Infinity', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(1e300, 1e-300)],
      temCatalisador: false,
      catalisadorEmbalagens: null,
      proporcaoPct: null,
    });
    expect(r.status).toBe('incomplete');
  });

  it('temCatalisador=false ignora a proporção (mesmo pct preenchido → base)', () => {
    const r = precoLitroPreparado({
      baseEmbalagens: [emb(360, 3.6)],
      temCatalisador: false,
      catalisadorEmbalagens: [emb(180, 0.9)],
      proporcaoPct: 10,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.valorLitroPreparado).toBe(100);
  });
});
