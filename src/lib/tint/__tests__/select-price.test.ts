import { describe, it, expect } from 'vitest';
import { selectTintPrice, selectAltPrice } from '../select-price';
import type { TintPriceBreakdown } from '../compute-price';

// Helper: monta um breakdown do motor honesto (get_tint_price) para os testes.
const pricing = (over: Partial<TintPriceBreakdown>): TintPriceBreakdown => ({
  custoBase: 100,
  baseDisponivel: true,
  itensCorantes: [],
  custoCorantes: 50,
  corantesCompletos: true,
  precoFinal: 150,
  ...over,
});

describe('selectTintPrice — seleção honesta da fonte de preço (Passo 2, money-path)', () => {
  it('base ausente/zero (PRD03657) → sem preço, ignora CSV e cliente (não confiar no importado)', () => {
    // A base não tem preço no Omie: o CSV também subfatura aqui. Não fabricar.
    const r = selectTintPrice({
      lastPracticedPrice: 101.7,
      precoCsv: 101.7,
      pricing: pricing({ baseDisponivel: false, custoBase: null, precoFinal: null }),
    });
    expect(r.source).toBeNull();
    expect(r.precoSemDesconto).toBeNull();
    expect(r.motivoSemPreco).toBe('base');
  });

  it('preço do cliente (negociado) vence quando existe e a base tem preço', () => {
    const r = selectTintPrice({
      lastPracticedPrice: 200,
      precoCsv: 180,
      pricing: pricing({ precoFinal: 190 }),
    });
    expect(r.source).toBe('cliente');
    expect(r.precoSemDesconto).toBe(200);
    expect(r.recalculado).toBe(false);
  });

  it('Grupo B (calc > CSV): usa o calc e marca recalculado, guardando o importado anterior', () => {
    // CSV esqueceu a base; calc inclui. Sobe → aviso no balcão.
    const r = selectTintPrice({
      lastPracticedPrice: null,
      precoCsv: 13.68,
      pricing: pricing({ custoBase: 152.1, custoCorantes: 18.06, precoFinal: 170.16 }),
    });
    expect(r.source).toBe('calculado');
    expect(r.precoSemDesconto).toBe(170.2); // arredonda pra cima R$0,10 (paridade CSV)
    expect(r.recalculado).toBe(true);
    expect(r.precoImportadoAnterior).toBe(13.7); // CSV arredondado, para o "antes R$X"
  });

  it('Grupo A (calc ≈ CSV, dentro da tolerância): usa o calc, sem aviso (mesmo preço)', () => {
    const r = selectTintPrice({
      lastPracticedPrice: null,
      precoCsv: 563.44,
      pricing: pricing({ precoFinal: 563.44 }),
    });
    expect(r.source).toBe('calculado');
    expect(r.precoSemDesconto).toBe(563.5); // 563.44 → ceil → 563.5
    expect(r.recalculado).toBe(false);
    expect(r.precoImportadoAnterior).toBeNull();
  });

  it('calc < CSV (acima da tolerância): mantém o importado, NÃO baixa o preço', () => {
    const r = selectTintPrice({
      lastPracticedPrice: null,
      precoCsv: 200,
      pricing: pricing({ precoFinal: 150 }),
    });
    expect(r.source).toBe('tabela');
    expect(r.precoSemDesconto).toBe(200);
    expect(r.recalculado).toBe(false);
  });

  it('só calc (sem CSV) → usa o calc', () => {
    const r = selectTintPrice({
      lastPracticedPrice: null,
      precoCsv: null,
      pricing: pricing({ precoFinal: 150 }),
    });
    expect(r.source).toBe('calculado');
    expect(r.precoSemDesconto).toBe(150);
  });

  it('corante incompleto (base OK) + CSV → sem preço, NÃO cai no CSV (fail-closed money-path)', () => {
    // Se o motor não sabe o custo de um corante, o CSV pode estar velho/errado → não vender.
    const r = selectTintPrice({
      lastPracticedPrice: null,
      precoCsv: 180,
      pricing: pricing({ corantesCompletos: false, precoFinal: null }),
    });
    expect(r.source).toBeNull();
    expect(r.precoSemDesconto).toBeNull();
    expect(r.motivoSemPreco).toBe('corante');
  });

  it('corante incompleto + preço de cliente antigo → sem preço (não perpetua subfaturamento)', () => {
    const r = selectTintPrice({
      lastPracticedPrice: 999,
      precoCsv: 180,
      pricing: pricing({ corantesCompletos: false, precoFinal: null }),
    });
    expect(r.source).toBeNull();
    expect(r.motivoSemPreco).toBe('corante');
  });

  it('calc null por corante incompleto e SEM CSV → sem preço, motivo corante', () => {
    const r = selectTintPrice({
      lastPracticedPrice: null,
      precoCsv: null,
      pricing: pricing({ corantesCompletos: false, precoFinal: null }),
    });
    expect(r.source).toBeNull();
    expect(r.precoSemDesconto).toBeNull();
    expect(r.motivoSemPreco).toBe('corante');
  });

  it('pricing ainda carregando (null) + CSV → usa o importado (não afirma sem preço no loading)', () => {
    const r = selectTintPrice({ lastPracticedPrice: null, precoCsv: 180, pricing: null });
    expect(r.source).toBe('tabela');
    expect(r.precoSemDesconto).toBe(180);
  });

  it('CSV <= 0 é tratado como ausente', () => {
    const r = selectTintPrice({
      lastPracticedPrice: null,
      precoCsv: 0,
      pricing: pricing({ precoFinal: 150 }),
    });
    expect(r.source).toBe('calculado');
    expect(r.precoSemDesconto).toBe(150);
  });

  it('nem calc nem CSV nem cliente → sem preço', () => {
    const r = selectTintPrice({ lastPracticedPrice: null, precoCsv: null, pricing: null });
    expect(r.source).toBeNull();
    expect(r.precoSemDesconto).toBeNull();
  });
});

describe('selectAltPrice — preço de embalagem alternativa (1b)', () => {
  it('Grupo B (calc > CSV): usa o calc, marca recalculado e traz o custoCorantes DA fórmula', () => {
    const r = selectAltPrice(13.68, pricing({ custoBase: 152.1, custoCorantes: 18.06, precoFinal: 170.16 }));
    expect(r.preco).toBe(170.2);
    expect(r.fonte).toBe('calculado');
    expect(r.recalculado).toBe(true);
    expect(r.custoCorantes).toBe(18.06); // da própria alternativa, não da cor selecionada
  });

  it('base ausente → sem preço (preco null), não vende', () => {
    const r = selectAltPrice(101.7, pricing({ baseDisponivel: false, custoBase: null, precoFinal: null }));
    expect(r.preco).toBeNull();
    expect(r.fonte).toBeNull();
  });

  it('sem breakdown (batch carregando/erro/RPC ausente) → sem preço, NÃO cai no CSV (fail-closed)', () => {
    const r = selectAltPrice(200, null);
    expect(r.preco).toBeNull();
    expect(r.fonte).toBeNull();
    expect(r.custoCorantes).toBe(0);
  });

  it('calc < CSV → mantém o importado (não baixa)', () => {
    const r = selectAltPrice(200, pricing({ precoFinal: 150 }));
    expect(r.preco).toBe(200);
    expect(r.fonte).toBe('tabela');
  });

  it('só base (sem CSV) e cálculo disponível → usa o calc', () => {
    const r = selectAltPrice(null, pricing({ precoFinal: 150 }));
    expect(r.preco).toBe(150);
    expect(r.fonte).toBe('calculado');
  });
});
