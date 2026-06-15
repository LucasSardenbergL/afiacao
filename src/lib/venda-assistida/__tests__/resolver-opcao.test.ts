import { describe, it, expect } from 'vitest';
import { resolverOpcaoVenda, type EmbalagemComEstoque } from '../resolver-opcao';

const e = (valor: number, litros: number | null, estoque: number): EmbalagemComEstoque => ({ valor, litros, estoque });

describe('resolverOpcaoVenda (estado + preço coerentes — fecha P0.2 do Codex)', () => {
  it('sem SKU confirmado → TECHNICAL_ONLY, sem preço', () => {
    const r = resolverOpcaoVenda({
      temSkuConfirmado: false, temCatalisador: false, proporcaoPct: null,
      baseEmbalagens: [e(360, 3.6, 10)], catalisadorEmbalagens: [],
    });
    expect(r.estado).toBe('TECHNICAL_ONLY');
    expect(r.preco.status).toBe('incomplete');
  });

  it('base (1-componente) em estoque + precificada → SELLABLE_NOW', () => {
    const r = resolverOpcaoVenda({
      temSkuConfirmado: true, temCatalisador: false, proporcaoPct: null,
      baseEmbalagens: [e(360, 3.6, 5)], catalisadorEmbalagens: [],
    });
    expect(r.estado).toBe('SELLABLE_NOW');
    expect(r.preco.status).toBe('ok');
  });

  it('🔴 P0.2: SELLABLE_NOW usa o preço da embalagem EM ESTOQUE, não da maior fora de estoque', () => {
    // Maior (18 L, R$180 → R$10/L) SEM estoque; menor (0,9 L, R$180 → R$200/L) EM estoque.
    const r = resolverOpcaoVenda({
      temSkuConfirmado: true, temCatalisador: false, proporcaoPct: null,
      baseEmbalagens: [e(180, 18, 0), e(180, 0.9, 5)], catalisadorEmbalagens: [],
    });
    expect(r.estado).toBe('SELLABLE_NOW');
    // se pegasse a maior (fora de estoque) daria R$10/L — preço de algo indisponível (bug P0.2)
    if (r.preco.status === 'ok') {
      expect(r.preco.precoLitroBase).toBe(200); // veio da embalagem EM ESTOQUE
      expect(r.preco.litrosBaseUsada).toBe(0.9);
    }
  });

  it('nada em estoque → ORDERABLE com a estimativa de encomenda (maior embalagem geral)', () => {
    const r = resolverOpcaoVenda({
      temSkuConfirmado: true, temCatalisador: false, proporcaoPct: null,
      baseEmbalagens: [e(180, 18, 0), e(180, 0.9, 0)], catalisadorEmbalagens: [],
    });
    expect(r.estado).toBe('ORDERABLE');
    if (r.preco.status === 'ok') expect(r.preco.litrosBaseUsada).toBe(18); // maior (encomenda)
  });

  it('catalisado: base + catalisador em estoque → SELLABLE_NOW (preço sobre os dois em estoque)', () => {
    const r = resolverOpcaoVenda({
      temSkuConfirmado: true, temCatalisador: true, proporcaoPct: 10,
      baseEmbalagens: [e(360, 3.6, 5)], catalisadorEmbalagens: [e(180, 0.9, 5)],
    });
    expect(r.estado).toBe('SELLABLE_NOW');
    expect(r.preco.status).toBe('ok');
  });

  it('🔴 catalisador obrigatório fora de estoque → NÃO é SELLABLE_NOW (vira ORDERABLE)', () => {
    const r = resolverOpcaoVenda({
      temSkuConfirmado: true, temCatalisador: true, proporcaoPct: 10,
      baseEmbalagens: [e(360, 3.6, 5)], catalisadorEmbalagens: [e(180, 0.9, 0)],
    });
    expect(r.estado).toBe('ORDERABLE'); // base em estoque, mas catalisador não → encomenda
  });

  it('catalisador obrigatório NÃO mapeado ([]) → ORDERABLE com preço "sob consulta"', () => {
    const r = resolverOpcaoVenda({
      temSkuConfirmado: true, temCatalisador: true, proporcaoPct: 10,
      baseEmbalagens: [e(360, 3.6, 5)], catalisadorEmbalagens: [],
    });
    expect(r.estado).toBe('ORDERABLE');
    expect(r.preco.status).toBe('incomplete'); // catalisador obrigatório sem SKU
  });
});
