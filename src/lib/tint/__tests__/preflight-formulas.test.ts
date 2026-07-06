import { describe, it, expect } from 'vitest';
import { preflightFormulaRows, summarizePreflight } from '../preflight-formulas';
import { formulaColumnLayout } from '../formula-layout';

// Monta uma linha de fórmula posicionando os campos nos índices reais do layout.
// `corantes`/`qtds` são pares (id do corante, quantidade crua). `extra` sobrescreve
// células por índice. Preenche os metadados obrigatórios (cor_id, nome_cor) p/ não
// poluir com falsos negativos — o preflight só olha os DECIMAIS.
function makeRow(
  personalizada: boolean,
  opts: {
    corantes?: Array<[string, string]>; // [idCorante, qtdRaw]
    volumeFinal?: string;
    precoFinal?: string;
  } = {},
): string[] {
  const layout = formulaColumnLayout(personalizada);
  const width = layout.dataGeracao + 1;
  const row = new Array<string>(width).fill('');
  row[1] = 'COR1';       // cor_id
  row[2] = 'Branco Gelo'; // nome_cor
  const corantes = opts.corantes ?? [];
  corantes.forEach(([id, qtd], i) => {
    if (i > 5) return;
    row[layout.corante[i]] = id;
    row[layout.qtd[i]] = qtd;
  });
  if (opts.volumeFinal !== undefined) row[layout.volumeFinal] = opts.volumeFinal;
  if (opts.precoFinal !== undefined) row[layout.precoFinal] = opts.precoFinal;
  return row;
}

describe('preflightFormulaRows', () => {
  it('CSV pt-BR válido (vírgula decimal, milhar) → ok, sem ofensas', () => {
    const rows = [
      makeRow(false, { corantes: [['CX1', '12,5'], ['CX2', '0,125']], volumeFinal: '900', precoFinal: '1.234,56' }),
      makeRow(false, { corantes: [['CX1', '3,0']], volumeFinal: '3600', precoFinal: '89,90' }),
    ];
    const res = preflightFormulaRows(rows, false);
    expect(res.ok).toBe(true);
    expect(res.offending).toHaveLength(0);
    expect(res.total).toBe(2);
  });

  it('en-US no preço ("1,234.56") → ok (parseDecimalBR aceita ambos)', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '10']], precoFinal: '1,234.56' })];
    expect(preflightFormulaRows(rows, false).ok).toBe(true);
  });

  it('qtd de corante ambígua "3.600" (=3600? 3.6?) → REPROVA (ausente≠fabricar)', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '3.600']] })];
    const res = preflightFormulaRows(rows, false);
    expect(res.ok).toBe(false);
    expect(res.offending).toHaveLength(1);
    expect(res.offending[0]).toMatchObject({ linha: 1, valor: '3.600' });
    expect(res.offending[0].campo).toMatch(/qtd/i);
  });

  it('preço com milhar mal-formado "1.2345,00" → REPROVA', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '10']], precoFinal: '1.2345,00' })];
    const res = preflightFormulaRows(rows, false);
    expect(res.ok).toBe(false);
    expect(res.offending[0].campo).toMatch(/preco/i);
  });

  it('volume final ilegível "12x3" → REPROVA', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '10']], volumeFinal: '12x3' })];
    const res = preflightFormulaRows(rows, false);
    expect(res.ok).toBe(false);
    expect(res.offending[0].campo).toMatch(/volume/i);
  });

  it('corante PRESENTE mas sem quantidade (qtd vazia) → REPROVA (item sem receita)', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '']] })];
    const res = preflightFormulaRows(rows, false);
    expect(res.ok).toBe(false);
    expect(res.offending[0].campo).toMatch(/qtd/i);
  });

  it('corante presente com qtd zero → REPROVA (0 não é uma quantidade de receita)', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '0']] })];
    expect(preflightFormulaRows(rows, false).ok).toBe(false);
  });

  it('volume/preço VAZIOS → ok (ausente é legítimo; vira null, não 0)', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '10']] })]; // sem volume/preço
    expect(preflightFormulaRows(rows, false).ok).toBe(true);
  });

  it('preço NEGATIVO → REPROVA (Codex [P2])', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '10']], precoFinal: '-5,00' })];
    const res = preflightFormulaRows(rows, false);
    expect(res.ok).toBe(false);
    expect(res.offending[0].campo).toMatch(/preco/i);
  });

  it('volume NEGATIVO → REPROVA', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '10']], volumeFinal: '-900' })];
    expect(preflightFormulaRows(rows, false).ok).toBe(false);
  });

  it('volume/preço ZERO → ok (0 pode ser legítimo; só negativo/ilegível reprova)', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '10']], volumeFinal: '0', precoFinal: '0,00' })];
    expect(preflightFormulaRows(rows, false).ok).toBe(true);
  });

  it('slot de corante vazio é ignorado (não exige qtd)', () => {
    // Só o 1º corante preenchido; os outros 5 vazios não geram ofensa.
    const rows = [makeRow(false, { corantes: [['CX1', '10']] })];
    expect(preflightFormulaRows(rows, false).offending).toHaveLength(0);
  });

  it('corante DUPLICADO na mesma fórmula → REPROVA (Codex R2 [P1])', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '10'], ['CX1', '5']] })];
    const res = preflightFormulaRows(rows, false);
    expect(res.ok).toBe(false);
    expect(res.offending.some(o => /corante/i.test(o.campo) && /duplicado/.test(o.valor))).toBe(true);
  });

  it('fórmula SEM nenhum corante → REPROVA (Codex R2 [P1])', () => {
    const rows = [makeRow(false, { volumeFinal: '900', precoFinal: '50,00' })]; // 0 corantes
    const res = preflightFormulaRows(rows, false);
    expect(res.ok).toBe(false);
    expect(res.offending.some(o => o.campo === 'corantes')).toBe(true);
  });

  it('dois corantes DISTINTOS válidos → ok', () => {
    const rows = [makeRow(false, { corantes: [['CX1', '10'], ['CX2', '5']] })];
    expect(preflightFormulaRows(rows, false).ok).toBe(true);
  });

  it('personalizada usa o layout com offset 0', () => {
    const good = [makeRow(true, { corantes: [['CX1', '12,5']], precoFinal: '10,00' })];
    expect(preflightFormulaRows(good, true).ok).toBe(true);
    const bad = [makeRow(true, { corantes: [['CX1', '3.600']] })];
    expect(preflightFormulaRows(bad, true).ok).toBe(false);
  });

  it('reporta TODAS as ofensas do arquivo, com nº de linha 1-based', () => {
    const rows = [
      makeRow(false, { corantes: [['CX1', '10']] }),      // linha 1 ok
      makeRow(false, { corantes: [['CX1', '3.600']] }),   // linha 2 ruim
      makeRow(false, { corantes: [['CX1', '10']], precoFinal: 'abc' }), // linha 3 ruim
    ];
    const res = preflightFormulaRows(rows, false);
    expect(res.ok).toBe(false);
    expect(res.offending).toHaveLength(2);
    expect(res.offending.map(o => o.linha)).toEqual([2, 3]);
  });
});

describe('summarizePreflight', () => {
  it('ok → string vazia', () => {
    expect(summarizePreflight({ ok: true, total: 3, offending: [] })).toBe('');
  });

  it('cita linha/campo/valor e trunca com "+N outras"', () => {
    const offending = Array.from({ length: 10 }, (_, i) => ({
      linha: i + 1, campo: 'qtd1ml', valor: '3.600',
    }));
    const msg = summarizePreflight({ ok: false, total: 10, offending }, 3);
    expect(msg).toContain('10 célula');
    expect(msg).toContain('linha 1, qtd1ml: "3.600"');
    expect(msg).toContain('+7 outras');
  });
});
