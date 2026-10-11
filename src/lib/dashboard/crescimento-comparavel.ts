/**
 * Crescimento na BASE COMPARÁVEL (o "same store" do varejo, por cliente). Puro e testável.
 *
 * A receita total mistura três coisas que pedem ação diferente: o cliente que comprou nos dois
 * períodos (a base), o que só comprou no atual (entrou) e o que só comprou no anterior (saiu).
 * Medido na prod em 2026-10-10: Colacor set/ago caiu −11% no total com a base em +0,6% (giro de
 * avulso), e o trimestre jul–set caiu −22% com a base em −29% (a base é que encolheu). O número
 * de cima sozinho conta a história errada nos dois casos.
 *
 * Identidade (testada): totalAtual − totalBase = Δcomparável + entraram − saíram + ΔsemCliente.
 */
import { variacaoPct } from './team-kpis';

export interface PedidoCliente {
  customer_user_id: string | null;
  total: number | null;
}

export interface DecomposicaoCrescimento {
  totalAtual: number;
  totalBase: number;
  /** Clientes com pedido válido nos DOIS períodos (presença, não soma positiva). */
  comparavel: { atual: number; base: number; clientes: number };
  /** Pedido no atual e nenhum no base. Inclui quem voltou depois de sumir: NÃO é "cliente novo". */
  entraram: { receita: number; clientes: number };
  /** Pedido no base e nenhum no atual. */
  sairam: { receita: number; clientes: number };
  /** Pedido sem cliente não pode ser comparado: fica fora da base, em balde próprio. */
  semCliente: { atual: number; base: number };
  /** Pedidos com `total` nulo: somam 0 (como no tile de receita), mas a contagem fica à vista. */
  pedidosSemValor: { atual: number; base: number };
  /** Fração. `null` sem base (crescimento a partir de zero é indefinido). */
  variacaoTotal: number | null;
  variacaoComparavel: number | null;
  /**
   * Cobertura da coorte: quanto da receita de cada período a base comparável explica. Mostrar
   * junto do percentual — "+0,6%" sobre 28% da receita é ruído, sobre 90% é sinal. `null` sem receita.
   */
  participacaoComparavel: { atual: number | null; base: number | null };
}

interface Somatorio {
  porCliente: Map<string, number>;
  semCliente: number;
  semValor: number;
}

function somarPorCliente(pedidos: PedidoCliente[]): Somatorio {
  const porCliente = new Map<string, number>();
  let semCliente = 0;
  let semValor = 0;
  for (const p of pedidos) {
    if (p.total == null) semValor++;
    const valor = p.total ?? 0;
    if (p.customer_user_id == null) {
      semCliente += valor;
      continue;
    }
    porCliente.set(p.customer_user_id, (porCliente.get(p.customer_user_id) ?? 0) + valor);
  }
  return { porCliente, semCliente, semValor };
}

export function decomporCrescimento(
  atual: PedidoCliente[],
  base: PedidoCliente[],
): DecomposicaoCrescimento {
  const a = somarPorCliente(atual);
  const b = somarPorCliente(base);

  const comparavel = { atual: 0, base: 0, clientes: 0 };
  const entraram = { receita: 0, clientes: 0 };
  const sairam = { receita: 0, clientes: 0 };

  const clientes = new Set([...a.porCliente.keys(), ...b.porCliente.keys()]);
  for (const c of clientes) {
    const ra = a.porCliente.get(c);
    const rb = b.porCliente.get(c);
    if (ra !== undefined && rb !== undefined) {
      comparavel.atual += ra;
      comparavel.base += rb;
      comparavel.clientes++;
    } else if (ra !== undefined) {
      entraram.receita += ra;
      entraram.clientes++;
    } else if (rb !== undefined) {
      sairam.receita += rb;
      sairam.clientes++;
    }
  }

  const totalAtual = comparavel.atual + entraram.receita + a.semCliente;
  const totalBase = comparavel.base + sairam.receita + b.semCliente;

  return {
    totalAtual,
    totalBase,
    comparavel,
    entraram,
    sairam,
    semCliente: { atual: a.semCliente, base: b.semCliente },
    pedidosSemValor: { atual: a.semValor, base: b.semValor },
    variacaoTotal: variacaoPct(totalAtual, totalBase),
    variacaoComparavel: variacaoPct(comparavel.atual, comparavel.base),
    participacaoComparavel: {
      atual: totalAtual > 0 ? comparavel.atual / totalAtual : null,
      base: totalBase > 0 ? comparavel.base / totalBase : null,
    },
  };
}

export interface Janela {
  de: string;
  ate: string;
}

/** 'YYYY-MM-01' deslocado `n` meses. Puro. */
function somarMeses(primeiroDoMes: string, n: number): string {
  const y = parseInt(primeiroDoMes.slice(0, 4), 10);
  const m = parseInt(primeiroDoMes.slice(5, 7), 10) - 1 + n;
  const ano = y + Math.floor(m / 12);
  const mes = ((m % 12) + 12) % 12;
  return `${ano}-${String(mes + 1).padStart(2, '0')}-01`;
}

/**
 * Os 3 últimos meses FECHADOS em SP (o mês de `hoje` fica fora), o trimestre imediatamente
 * anterior e os mesmos 3 meses do ano anterior. Janelas [de, ate) em 'YYYY-MM-DD'. Puro.
 * Mês fechado dá número estável; o ano anterior anula a sazonalidade.
 */
export function janelasTrimestreFechado(hoje: string): {
  atual: Janela;
  anterior: Janela;
  anoAnterior: Janela;
} {
  const fim = `${hoje.slice(0, 7)}-01`;
  const inicio = somarMeses(fim, -3);
  return {
    atual: { de: inicio, ate: fim },
    anterior: { de: somarMeses(inicio, -3), ate: inicio },
    anoAnterior: { de: somarMeses(inicio, -12), ate: somarMeses(fim, -12) },
  };
}
