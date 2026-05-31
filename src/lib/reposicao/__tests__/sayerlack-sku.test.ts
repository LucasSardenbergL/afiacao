import { describe, it, expect } from 'vitest';
import {
  extrairCodigosSayerlack,
  sufixoSayerlack,
  resolverSayerlack,
  compararComGabarito,
  validarGabarito,
  sugerirMapeamentos,
  ehProdutoFracionado,
} from '../sayerlack-sku';

// GABARITO REAL — mapeamentos que o founder já fez na mão (descricao Omie → sku_portal salvo).
// O parser DEVE reproduzir cada sku_portal a partir da descrição (prova de segurança do gate).
const GABARITO: Array<[descricao: string, skuPortal: string]> = [
  ['BASE FUNDO ACAB PU TRANSP WFOT.6529QT', 'WFOT.6529QT'],
  ['TINTA MORDENTE TAB CURU TM.3610.3557FG', 'TM.3610.3557FG'],
  ['BASE P/VIDRO BRANC WFOB.6863QT', 'WFOB.6863QT'],
  ['SAYERMASSA CEREJEIRA YL.1424.226QT', 'YL.1424.226QT'],
  ['BASE PU METALLIC PEARL MULT TOTAL WFOB.6736GL', 'WFOB.6736GL'],
  ['PRIMER PU FL.6269.02GL', 'FL.6269.02GL'],
  ['BASE BRILH INTER PU WFBI.6045GL', 'WFBI.6045GL'],
  ['TINTA MORDENTE TAB CURU TM.3610.3557BB', 'TM.3610.3557BB'],
  ['POLIULACK BRILHANTE SB.2300.00GL', 'SB.2300.00GL'],
  ['BASE BRILH BRANC PU WFBB.6045GL', 'WFBB.6045GL'],
  ['SAYERMASSA BRANCA YL.1424.02GL', 'YL.1424.02GL'],
  ['WP12.3900QT CONCENTRADO PRETO', 'WP12.3900QT'], // código no COMEÇO
  ['BASE ACRIL MULT MET FOSCO INTER WJOI.7666QT', 'WJOI.7666QT'],
  ['WP07.3900QT CONCENTRADO AMARELO LIMAO', 'WP07.3900QT'], // começo
  ['SOLUCAO VERMELHA 1351 XT.1803.03FG', 'XT.1803.03FG'], // "1351" solto não confunde
  ['WP04.3900QT CONCENTRADO AZUL', 'WP04.3900QT'], // começo
  ['F ACAB FL20.6468.00LT', 'FL20.6468.00LT'],
  ['EXTERMINADOR DE CUPIM GT.3954LT', 'GT.3954LT'],
  ['BASE BRILH BRANC PU WFBB.6045BH', 'WFBB.6045BH'],
  ['TINGIDOR CONCENTRADO MOGNO TE.3550.62FG', 'TE.3550.62FG'],
  ['SELADORA NLO.9525.00L5', 'NLO.9525.00L5'], // sufixo L5 (letra+dígito)
  ['SELADORA SEMI-BRILHO NLO.9506.00L5', 'NLO.9506.00L5'],
  ['SAYERGLAZE CAFE TM.3600.4698QT', 'TM.3600.4698QT'],
  ['WP01.3900GL CONCENTRADO PRETO INTENSO', 'WP01.3900GL'], // começo
  ['POLIULACK ACETINADO SO.2301.00QT', 'SO.2301.00QT'],
  ['TINGIDOR IMBUIA TE.3550.42FG', 'TE.3550.42FG'],
  ['SELADORA NLO.9525.00QT', 'NLO.9525.00QT'],
  ['BASE ACRIL MULT MET FOSCO INTER WJOI.7666GL', 'WJOI.7666GL'],
  ['CATALISADOR FC.6902QT', 'FC.6902QT'],
  ['BASE BRILH TRANSP PU WFBT.6045QT', 'WFBT.6045QT'],
  ['BASE FUNDO ACAB PU INTER WFOI.6529GL', 'WFOI.6529GL'],
  ['BASE TEXT INTER GOLF30 WFOI.6857QT', 'WFOI.6857QT'], // "GOLF30" (letras+díg sem ponto) não confunde
  ['BASE TRANSP PU WFBT.6188GL', 'WFBT.6188GL'],
  ['BASE MICROTEX TRANSP WFOT.6861QT', 'WFOT.6861QT'],
  ['BASE BRILH TRANSP PU WFBT.6045GL', 'WFBT.6045GL'],
  ['BASE P/VIDRO TRANSP WFOT.6863QT', 'WFOT.6863QT'],
  ['BASE TEXT TRANSP GOLF30 WFOT.6857QT', 'WFOT.6857QT'],
];

describe('sayerlack-sku parser — gabarito real (gate de segurança)', () => {
  it.each(GABARITO)('extrai %s → %s', (descricao, esperado) => {
    const r = resolverSayerlack(descricao);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.codigo).toBe(esperado);
  });

  it('reproduz 100% do gabarito (compararComGabarito = bate em todos)', () => {
    const naoBatem = GABARITO.filter(
      ([d, sku]) => compararComGabarito(d, sku).resultado !== 'bate',
    );
    expect(naoBatem).toEqual([]);
  });
});

describe('sayerlack-sku parser — casos especiais', () => {
  it('SINALIZA divergência sem corrigir (FC.6902L5 na descrição vs FC.6902L salvo)', () => {
    const c = compararComGabarito('CATALISADOR FC.6902L5', 'FC.6902L');
    expect(c.resultado).toBe('diverge');
    expect(c.extraido).toBe('FC.6902L5'); // o parser extrai o código completo da descrição
  });

  it('código no começo da descrição (concentrados)', () => {
    expect(extrairCodigosSayerlack('WP12.3900QT CONCENTRADO PRETO')).toEqual(['WP12.3900QT']);
  });

  it('"GOLF30" e números soltos não viram falso-positivo', () => {
    expect(extrairCodigosSayerlack('BASE TEXT INTER GOLF30 WFOI.6857QT')).toEqual(['WFOI.6857QT']);
    expect(extrairCodigosSayerlack('SOLUCAO VERMELHA 1351 XT.1803.03FG')).toEqual(['XT.1803.03FG']);
  });

  it('extrai o sufixo/embalagem correto', () => {
    expect(sufixoSayerlack('WFOT.6529QT')).toBe('QT');
    expect(sufixoSayerlack('FL20.6468.00LT')).toBe('LT');
    expect(sufixoSayerlack('NLO.9525.00L5')).toBe('L5');
    expect(sufixoSayerlack('GT.3954LT')).toBe('LT');
    expect(sufixoSayerlack('SB.2300.00GL')).toBe('GL');
  });

  it('0 código → sem_codigo (revisão humana)', () => {
    expect(resolverSayerlack('PRODUTO SEM CODIGO NA DESCRICAO')).toEqual({
      status: 'sem_codigo',
      candidatos: [],
    });
    expect(resolverSayerlack(null)).toEqual({ status: 'sem_codigo', candidatos: [] });
    expect(resolverSayerlack('')).toEqual({ status: 'sem_codigo', candidatos: [] });
  });

  it('>1 código → multiplos (revisão OBRIGATÓRIA, nunca escolher sozinho)', () => {
    const r = resolverSayerlack('KIT WFOT.6529QT + FC.6902QT');
    expect(r.status).toBe('multiplos');
    if (r.status === 'multiplos') {
      expect(r.candidatos).toContain('WFOT.6529QT');
      expect(r.candidatos).toContain('FC.6902QT');
    }
  });

  it('normaliza (case/espaços) na comparação do gabarito', () => {
    expect(compararComGabarito('base ... wfot.6529qt', '  WFOT.6529QT ').resultado).toBe('bate');
  });
});

describe('validarGabarito (gate de segurança)', () => {
  it('reproduz 100% do gabarito real (batem === total, zero divergências)', () => {
    const rows = GABARITO.map(([descricao, sku_portal]) => ({ sku_omie: sku_portal, sku_portal, descricao }));
    const r = validarGabarito(rows);
    expect(r.batem).toBe(GABARITO.length);
    expect(r.divergem).toEqual([]);
    expect(r.naoValidavel).toBe(0);
  });

  it('acusa divergência (FC.6902L5 desc vs FC.6902L salvo) sem corromper o resto', () => {
    const r = validarGabarito([
      { sku_omie: 'A', sku_portal: 'WFOT.6529QT', descricao: 'BASE ... WFOT.6529QT' },
      { sku_omie: 'B', sku_portal: 'FC.6902L', descricao: 'CATALISADOR FC.6902L5' },
    ]);
    expect(r.batem).toBe(1);
    expect(r.divergem).toEqual([{ sku_omie: 'B', salvo: 'FC.6902L', extraido: 'FC.6902L5' }]);
  });

  it('conta como naoValidavel quando a descrição não tem código extraível', () => {
    const r = validarGabarito([{ sku_omie: 'X', sku_portal: 'SB.2300.00GL', descricao: null }]);
    expect(r.naoValidavel).toBe(1);
    expect(r.batem).toBe(0);
  });
});

describe('sugerirMapeamentos (auto-preenchimento dos faltantes)', () => {
  it('classifica seguro / sem_codigo / multiplos', () => {
    const r = sugerirMapeamentos([
      { sku_codigo_omie: '8689775154', sku_descricao: 'POLIULACK BRILHANTE SB.2300.00GL' },
      { sku_codigo_omie: '999', sku_descricao: 'PRODUTO SEM CODIGO' },
      { sku_codigo_omie: '888', sku_descricao: 'KIT WFOT.6529QT + FC.6902QT' },
    ]);
    expect(r.seguros).toEqual([
      { sku_omie: '8689775154', descricao: 'POLIULACK BRILHANTE SB.2300.00GL', sku_portal: 'SB.2300.00GL', sufixo: 'GL' },
    ]);
    expect(r.semCodigo.map((s) => s.sku_codigo_omie)).toEqual(['999']);
    expect(r.multiplos.map((m) => m.sku_omie)).toEqual(['888']);
  });

  it('extrai código no começo da descrição (concentrados)', () => {
    const r = sugerirMapeamentos([{ sku_codigo_omie: '1', sku_descricao: 'WP12.3900QT CONCENTRADO PRETO' }]);
    expect(r.seguros[0].sku_portal).toBe('WP12.3900QT');
    expect(r.seguros[0].sufixo).toBe('QT');
  });
});

describe('ehProdutoFracionado (não-comprado pelo portal)', () => {
  it('true pra descrição terminando em 450ML / 405ML (case/espaço-insensível)', () => {
    expect(ehProdutoFracionado('BASE PU METALLIC PEARL MULT INTER WFOI.6736 450ML')).toBe(true);
    expect(ehProdutoFracionado('BASE PU ACRI FOSCO INTER WJOI.7585 405ML')).toBe(true);
    expect(ehProdutoFracionado('  base microtex transp wfot.6861 450ml  ')).toBe(true);
  });

  it('false pra produto comprado normal (sufixo de embalagem como GL/QT)', () => {
    expect(ehProdutoFracionado('POLIULACK BRILHANTE SB.2300.00GL')).toBe(false);
    expect(ehProdutoFracionado('CATALISADOR FC.6902QT')).toBe(false);
    expect(ehProdutoFracionado(null)).toBe(false);
    expect(ehProdutoFracionado('')).toBe(false);
  });
});

// ─── Variante separador-ESPAÇO (tingidores "TEH 3505.211FG") ───────────────────
// Descoberta (gap de mapeamento Sayerlack OBEN, 2026-05-30): ~26 tingidores trazem o
// código na descrição com ESPAÇO no lugar do 1º ponto ("TEH 3505.211FG") em vez do
// formato pontuado ("TEH.3505.211FG"). O gabarito provou que o sku_portal CORRETO é
// PONTUADO (4/4 já mapeados usam ponto, manuais e auto), então normalizamos espaço→ponto.
// A variante é ESTREITA de propósito: EXIGE a 2ª parte pontuada (.\d{2,4}). É isso que
// rejeita o falso-positivo "PU 6611A" (apontado pelo codex) e o degenerado "TEH 3505.TG5BB".
describe('sayerlack-sku parser — variante separador-espaço (tingidores)', () => {
  it.each([
    ['TINGIDOR CARAMELO TEH 3505.211FG', 'TEH.3505.211FG'],
    ['TINGIDOR NOGAL MEDIO TEH 3505.110FG', 'TEH.3505.110FG'],
    ['TINGIDOR LUCIANO 02 TEH 3505.00BB', 'TEH.3505.00BB'],
    ['TINGIDOR MEL TEH 3505.1210FG', 'TEH.3505.1210FG'],
    ['TINGIDOR NOGUEIRA CLARO TEH 3505.308BB', 'TEH.3505.308BB'],
  ])('normaliza espaço→ponto (formato do portal): %s → %s', (desc, esperado) => {
    const r = resolverSayerlack(desc);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.codigo).toBe(esperado);
  });

  it('NÃO cria falso-positivo "PU 6611A" (sem 2ª parte pontuada) — codex', () => {
    expect(resolverSayerlack('VERNIZ05 PU 6611A BH').status).toBe('sem_codigo');
  });

  it('NÃO casa o degenerado TG5 (2ª parte não-numérica)', () => {
    expect(resolverSayerlack('TINGIDOR DETTAGLI TEH 3505.TG5BB').status).toBe('sem_codigo');
    expect(resolverSayerlack('TINGIDOR DETTAGLI TEH 3505.TG5FG').status).toBe('sem_codigo');
  });

  // codex challenge: a 2ª parte pontuada NÃO basta — "PU 6611.22BH" / "RAL 9010.20BR" têm a
  // forma "PALAVRA NNNN.NN+sufixo" mas o prefixo NÃO é de tingidor → seria de-para inventado
  // (PO errado). A variante-espaço só vale pros prefixos de tingidor observados (TEH/TE/TM/TY).
  it('NÃO casa "PALAVRA NNNN.NN+sufixo" com prefixo fora da família tingidor', () => {
    expect(resolverSayerlack('VERNIZ05 PU 6611.22BH').status).toBe('sem_codigo');
    expect(resolverSayerlack('COR RAL 9010.20BR').status).toBe('sem_codigo');
    expect(resolverSayerlack('CAIXA AB 1234.56CD').status).toBe('sem_codigo');
  });

  it('a variante-espaço cobre os prefixos de tingidor (TEH/TE/TM/TY)', () => {
    expect(resolverSayerlack('TINGIDOR CARAMELO TEH 3505.211FG')).toMatchObject({ status: 'ok', codigo: 'TEH.3505.211FG' });
    expect(resolverSayerlack('TINGIDOR CONCENTRADO MOGNO TE 3550.62FG')).toMatchObject({ status: 'ok', codigo: 'TE.3550.62FG' });
    expect(resolverSayerlack('TINTA MORDENTE TM 3610.503FG')).toMatchObject({ status: 'ok', codigo: 'TM.3610.503FG' });
    expect(resolverSayerlack('ACQUACOLOR TY 1480.7191BG')).toMatchObject({ status: 'ok', codigo: 'TY.1480.7191BG' });
  });

  it('NÃO casa quando o sufixo está destacado por espaço ("...325 500ML")', () => {
    expect(resolverSayerlack('TINGIDOR NOGAL ANTIGO TEH 3505.325 500ML').status).toBe('sem_codigo');
  });

  it('o formato pontuado pré-existente segue intacto (sem dupla-contagem)', () => {
    expect(extrairCodigosSayerlack('TINGIDOR AMARELO TEH.3550.07FG')).toEqual(['TEH.3550.07FG']);
  });

  it('sugerirMapeamentos classifica o tingidor-espaço como seguro com sku_portal pontuado', () => {
    const r = sugerirMapeamentos([
      { sku_codigo_omie: '8689783786', sku_descricao: 'TINGIDOR CARAMELO TEH 3505.211FG' },
    ]);
    expect(r.seguros).toEqual([
      { sku_omie: '8689783786', descricao: 'TINGIDOR CARAMELO TEH 3505.211FG', sku_portal: 'TEH.3505.211FG', sufixo: 'FG' },
    ]);
  });
});
