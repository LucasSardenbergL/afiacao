import { describe, it, expect } from 'vitest';
import { montarBaseEmbalagens, type ProdutoLinhaOmie } from '../montar-embalagens';

const prod = (omie_codigo_produto: number, descricao: string, valor_unitario: number, estoque: number): ProdutoLinhaOmie =>
  ({ omie_codigo_produto, descricao, valor_unitario, estoque });

describe('montarBaseEmbalagens', () => {
  it('extrai sufixo Sayerlack → litros (base GL = 3,24) e passa estoque', () => {
    const [emb] = montarBaseEmbalagens([prod(1, 'BASE PU METALLIC WFOB.6736GL', 324, 7)], {});
    expect(emb.litros).toBe(3.24);
    expect(emb.estoque).toBe(7);
    expect(emb.valor).toBe(324); // sem preço-do-cliente → tabela
  });

  it('QT não-base = 0,9; fracionado 405ML = 0,405 (descrição manda)', () => {
    const [qt] = montarBaseEmbalagens([prod(2, 'WP12.3900QT CONCENTRADO PRETO', 90, 3)], {});
    expect(qt.litros).toBe(0.9);
    const [frac] = montarBaseEmbalagens([prod(3, 'ISOLANTE PU FI.6197 405ML', 40, 1)], {});
    expect(frac.litros).toBe(0.405);
  });

  it('preço-do-cliente (>0) vence a tabela; 0/ausente → tabela', () => {
    const rows = [prod(10, 'PRIMER PU FL.6269.02GL', 300, 5)];
    expect(montarBaseEmbalagens(rows, { 10: 270 })[0].valor).toBe(270); // último praticado
    expect(montarBaseEmbalagens(rows, { 10: 0 })[0].valor).toBe(300);   // 0 → tabela
    expect(montarBaseEmbalagens(rows, {})[0].valor).toBe(300);          // ausente → tabela
  });

  it('SKU sem código Sayerlack reconhecível → litros null (sob consulta)', () => {
    const [emb] = montarBaseEmbalagens([prod(4, 'PRODUTO GENERICO SEM CODIGO', 50, 2)], {});
    expect(emb.litros).toBeNull();
  });

  it('estoque inválido (NaN) → 0', () => {
    const [emb] = montarBaseEmbalagens([prod(5, 'PRIMER PU FL.6269.02GL', 300, NaN)], {});
    expect(emb.estoque).toBe(0);
  });

  it('lista vazia → []', () => {
    expect(montarBaseEmbalagens([], {})).toEqual([]);
  });
});
