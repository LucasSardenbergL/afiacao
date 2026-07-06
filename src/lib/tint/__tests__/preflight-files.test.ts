import { describe, it, expect } from 'vitest';
import { preflightImportFiles } from '../preflight-files';
import { formulaColumnLayout } from '../formula-layout';

// Monta uma linha CSV (delimitador ';') com os campos nos índices reais do layout.
function csvLine(
  personalizada: boolean,
  opts: { corante1?: string; qtd1?: string; volume?: string; preco?: string },
): string {
  const layout = formulaColumnLayout(personalizada);
  const width = layout.dataGeracao + 1;
  const cols = new Array<string>(width).fill('');
  cols[1] = 'COR1';
  cols[2] = 'Branco';
  if (opts.corante1 !== undefined) cols[layout.corante[0]] = opts.corante1;
  if (opts.qtd1 !== undefined) cols[layout.qtd[0]] = opts.qtd1;
  if (opts.volume !== undefined) cols[layout.volumeFinal] = opts.volume;
  if (opts.preco !== undefined) cols[layout.precoFinal] = opts.preco;
  return cols.join(';');
}

function csv(personalizada: boolean, lines: Array<Parameters<typeof csvLine>[1]>): string {
  const header = 'id_seq;cor_id;nome_cor'; // conteúdo do header é irrelevante (é descartado)
  return [header, ...lines.map((l) => csvLine(personalizada, l))].join('\n');
}

describe('preflightImportFiles', () => {
  it('tipo não-fórmula → não checa (retorna [])', () => {
    const files = [{ name: 'corantes.csv', rawText: 'a;b;c\nx;y;z' }];
    expect(preflightImportFiles(files, 'dados_corantes')).toEqual([]);
  });

  it('CSV de fórmula válido → sem ofensores', () => {
    const rawText = csv(false, [
      { corante1: 'CX1', qtd1: '12,5', volume: '900', preco: '1.234,56' },
    ]);
    expect(preflightImportFiles([{ name: 'ok.csv', rawText }], 'formulas_padrao')).toEqual([]);
  });

  it('descarta o cabeçalho (linha 1 não vira ofensa)', () => {
    // Header tem "abc" na coluna de preço; se não fosse descartado, viraria ofensa.
    const rawText = csv(false, [{ corante1: 'CX1', qtd1: '10', preco: '50,00' }]);
    expect(preflightImportFiles([{ name: 'ok.csv', rawText }], 'formulas_padrao')).toEqual([]);
  });

  it('qtd ambígua "3.600" → 1 ofensor com fileName + mensagem', () => {
    const rawText = csv(false, [{ corante1: 'CX1', qtd1: '3.600' }]);
    const offenders = preflightImportFiles([{ name: 'ruim.csv', rawText }], 'formulas_padrao');
    expect(offenders).toHaveLength(1);
    expect(offenders[0].fileName).toBe('ruim.csv');
    expect(offenders[0].message).toContain('3.600');
    expect(offenders[0].result.ok).toBe(false);
  });

  it('múltiplos arquivos → só os ofensivos entram no resultado', () => {
    const bom = csv(false, [{ corante1: 'CX1', qtd1: '10' }]);
    const ruim = csv(false, [{ corante1: 'CX1', qtd1: '10' }, { corante1: 'CX2', qtd1: 'xx' }]);
    const offenders = preflightImportFiles(
      [{ name: 'bom.csv', rawText: bom }, { name: 'ruim.csv', rawText: ruim }],
      'formulas_padrao',
    );
    expect(offenders.map((o) => o.fileName)).toEqual(['ruim.csv']);
  });

  it('personalizada usa o layout com offset 0', () => {
    const rawText = csv(true, [{ corante1: 'CX1', qtd1: '3.600' }]);
    const offenders = preflightImportFiles([{ name: 'p.csv', rawText }], 'formulas_personalizadas');
    expect(offenders).toHaveLength(1);
  });
});
