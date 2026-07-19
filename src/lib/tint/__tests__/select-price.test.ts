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

  it('motor falhou (RPC erro, ≠ carregando) → sem preço, ignora CSV E cliente (fail-closed, regra 0)', () => {
    // A RPC pode estar barrando base/corante inativo justamente quando falha → não cair no importado.
    const r = selectTintPrice({ lastPracticedPrice: 200, precoCsv: 180, pricing: null, motorFalhou: true });
    expect(r.source).toBeNull();
    expect(r.precoSemDesconto).toBeNull();
    expect(r.motivoSemPreco).toBe('indisponivel');
  });

  it('motorFalhou=false com pricing null + CSV → ainda usa o CSV (loading ≠ falha, não regride o Passo 2)', () => {
    const r = selectTintPrice({ lastPracticedPrice: null, precoCsv: 180, pricing: null, motorFalhou: false });
    expect(r.source).toBe('tabela');
    expect(r.precoSemDesconto).toBe(180);
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

  it('expõe precoCalc e precoTabela (arredondados) quando o motor confirmou preço', () => {
    // A UI monta o mini-seletor de fonte só quando AMBOS existem.
    const r = selectAltPrice(200, pricing({ precoFinal: 150.01 }));
    expect(r.precoCalc).toBe(150.1); // ceil R$0,10
    expect(r.precoTabela).toBe(200);
  });

  it('sem preço confiável → precoCalc e precoTabela nulos (a UI não oferece escolha do invendável)', () => {
    const r = selectAltPrice(200, pricing({ baseDisponivel: false, custoBase: null, precoFinal: null }));
    expect(r.precoCalc).toBeNull();
    expect(r.precoTabela).toBeNull();
  });
});

describe('selectAltPrice — override de fonte da vendedora (Fase 2b-fix, alternativas/busca global)', () => {
  it('override "calculado" quando o default é tabela (calc < CSV): baixar pro cálculo novo é escolha ativa', () => {
    const r = selectAltPrice(200, pricing({ precoFinal: 150 }), 'calculado');
    expect(r.preco).toBe(150);
    expect(r.fonte).toBe('calculado');
    expect(r.recalculado).toBe(false);
  });

  it('override "tabela" quando o default é calc (calc > CSV): mostra o CSV sem o aviso de recálculo', () => {
    const r = selectAltPrice(13.68, pricing({ custoBase: 152.1, custoCorantes: 18.06, precoFinal: 170.16 }), 'tabela');
    expect(r.preco).toBe(13.7);
    expect(r.fonte).toBe('tabela');
    expect(r.recalculado).toBe(false); // o preço exibido não é o recalculado
  });

  it('override "calculado" coincidindo com o default preserva o aviso de recálculo', () => {
    const r = selectAltPrice(13.68, pricing({ custoBase: 152.1, custoCorantes: 18.06, precoFinal: 170.16 }), 'calculado');
    expect(r.preco).toBe(170.2);
    expect(r.fonte).toBe('calculado');
    expect(r.recalculado).toBe(true);
  });

  it('override de fonte SEM valor (tabela sem CSV) é ignorado → segue o default', () => {
    const r = selectAltPrice(null, pricing({ precoFinal: 150 }), 'tabela');
    expect(r.preco).toBe(150);
    expect(r.fonte).toBe('calculado');
  });

  it('override NÃO fura o fail-closed: base ausente segue sem preço mesmo com override "tabela"', () => {
    // Money-path: quando o motor honesto não confirma, nenhuma escolha manual vende pelo CSV.
    const r = selectAltPrice(101.7, pricing({ baseDisponivel: false, custoBase: null, precoFinal: null }), 'tabela');
    expect(r.preco).toBeNull();
    expect(r.fonte).toBeNull();
  });

  it('override NÃO fura o fail-closed do loading: sem breakdown → sem preço', () => {
    const r = selectAltPrice(200, null, 'tabela');
    expect(r.preco).toBeNull();
    expect(r.fonte).toBeNull();
  });
});
