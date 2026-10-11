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

/**
 * No grupo, o mesmo cliente tem um cadastro por empresa (CNPJs distintos): a unidade é o
 * VÍNCULO empresa × cliente, não o cliente único. Quem migrou de CNPJ aparece como saiu + entrou.
 */
export function porEmpresaCliente(
  pedidos: { account: string; customer_user_id: string | null; total: number | null }[],
): PedidoCliente[] {
  return pedidos.map((p) => ({
    customer_user_id: p.customer_user_id == null ? null : `${p.account}:${p.customer_user_id}`,
    total: p.total,
  }));
}

/** Teto da razão entre as coberturas das duas janelas (medido em 2026-10-10: comparáveis 1,08–1,12×; sync incompleto 1,86×). */
const RAZAO_MAXIMA_COBERTURA = 1.2;

export interface CoberturaEmpresa {
  account: string;
  /** Receita de pedidos ÷ receita por competência (DRE) da janela. `null` = sem DRE para comparar. */
  atual: number | null;
  base: number | null;
}

export type Comparabilidade =
  | { estado: 'comparavel' }
  | { estado: 'nao_verificada' }
  | { estado: 'incomparavel'; account: string; atual: number; base: number };

/**
 * Os pedidos do app não cobrem a receita contábil na mesma proporção em todo período (a Colacor
 * cobria ~49% em jul–set/25 e ~91% em jul–set/26). Se a cobertura muda entre as janelas, a
 * variação mede o sync, não o negócio, e cliente "entrou" pode ser só pedido que antes não vinha.
 * Ausente ≠ zero: cobertura que não deu para medir é "não verificada", nunca "comparável".
 */
export function avaliarComparabilidade(coberturas: CoberturaEmpresa[]): Comparabilidade {
  let pior: { account: string; atual: number; base: number; razao: number } | null = null;
  let semDado = coberturas.length === 0;
  for (const c of coberturas) {
    if (c.atual == null || c.base == null) {
      semDado = true;
      continue;
    }
    // Cobertura 0 com DRE positivo = o sync não trouxe a janela: razão infinita, não "sem dado".
    const menor = Math.min(c.atual, c.base);
    const razao = menor <= 0 ? Infinity : Math.max(c.atual, c.base) / menor;
    if (razao > RAZAO_MAXIMA_COBERTURA && (pior == null || razao > pior.razao)) {
      pior = { account: c.account, atual: c.atual, base: c.base, razao };
    }
  }
  if (pior) return { estado: 'incomparavel', account: pior.account, atual: pior.atual, base: pior.base };
  return semDado ? { estado: 'nao_verificada' } : { estado: 'comparavel' };
}

/** Os meses (ano, mês 1–12) cobertos por uma janela [de, ate) de meses inteiros. Puro. */
export function mesesDaJanela(janela: Janela): { ano: number; mes: number }[] {
  const out: { ano: number; mes: number }[] = [];
  for (let m = janela.de; m < janela.ate; m = somarMeses(m, 1)) {
    out.push({ ano: parseInt(m.slice(0, 4), 10), mes: parseInt(m.slice(5, 7), 10) });
  }
  return out;
}

/**
 * Cobertura por empresa que TEM pedido em alguma das janelas: receita de pedidos ÷ receita do
 * DRE. Empresa só de DRE (ex.: colacor_sc, serviços sem pedido) fica fora — não há o que cobrir.
 */
export function coberturasPorEmpresa(
  pedidosAtual: { account: string; total: number | null }[],
  pedidosBase: { account: string; total: number | null }[],
  dreAtual: Map<string, number> | null,
  dreBase: Map<string, number> | null,
): CoberturaEmpresa[] {
  const somar = (ps: { account: string; total: number | null }[]) => {
    const m = new Map<string, number>();
    for (const p of ps) m.set(p.account, (m.get(p.account) ?? 0) + (p.total ?? 0));
    return m;
  };
  const a = somar(pedidosAtual);
  const b = somar(pedidosBase);
  const razao = (pedidos: number | undefined, dre: number | undefined) =>
    pedidos == null || dre == null || dre <= 0 ? null : pedidos / dre;
  return [...new Set([...a.keys(), ...b.keys()])].sort().map((account) => ({
    account,
    atual: razao(a.get(account) ?? 0, dreAtual?.get(account)),
    base: razao(b.get(account) ?? 0, dreBase?.get(account)),
  }));
}

const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** "jul–set/26" para [2026-07-01, 2026-10-01); atravessando o ano, "nov/25–jan/26". Puro. */
export function rotuloJanela(janela: Janela): string {
  const meses = mesesDaJanela(janela);
  if (meses.length === 0) return '—';
  const ini = meses[0];
  const fim = meses[meses.length - 1];
  const nome = (m: { ano: number; mes: number }) => MESES_CURTOS[m.mes - 1];
  const aa = (m: { ano: number }) => String(m.ano).slice(2);
  if (meses.length === 1) return `${nome(ini)}/${aa(ini)}`;
  return ini.ano === fim.ano
    ? `${nome(ini)}–${nome(fim)}/${aa(fim)}`
    : `${nome(ini)}/${aa(ini)}–${nome(fim)}/${aa(fim)}`;
}
