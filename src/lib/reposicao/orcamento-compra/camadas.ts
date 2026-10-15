// src/lib/reposicao/orcamento-compra/camadas.ts
// Camadas que completam a projeção (spec §6.2, §6.3, §6.5).
import { addDias, ehDiaUtil, type DataISO } from './datas';
import type { Fluxo } from './caixa';

export interface PedidoDisparado { pedidoId: number; valorTotal: number; dataPedido: DataISO; nfs: string[] }
export interface TituloCp { nf: string; valor: number }

export function normalizarNf(nf: string): string {
  return nf.trim().replace(/^0+/, '');
}

/** Componentes conexos pedido↔NF; resíduo = Σ pedidos − Σ títulos das NFs do componente. */
export function conciliarCompromissos(
  pedidos: PedidoDisparado[],
  titulos: TituloCp[],
  inicio: DataISO,
  lagDias: number,
): { fluxos: Fluxo[]; naoConciliado: number } {
  const titulosPorNf = new Map<string, number>();
  for (const t of titulos) {
    const k = normalizarNf(t.nf);
    if (k === '') continue; // NF vazia/zero não identifica nada (coringa fail-open)
    titulosPorNf.set(k, (titulosPorNf.get(k) ?? 0) + t.valor);
  }
  const pai = new Map<string, string>();
  const achar = (x: string): string => {
    while (pai.get(x) !== x) x = pai.get(x)!;
    return x;
  };
  const unir = (a: string, b: string) => pai.set(achar(a), achar(b));
  const nosPedido = pedidos.map((p) => `p:${p.pedidoId}`);
  nosPedido.forEach((n) => pai.set(n, n));
  pedidos.forEach((p, i) => {
    for (const nf of p.nfs.map(normalizarNf).filter((x) => x !== '')) {
      const n = `n:${nf}`;
      if (!pai.has(n)) pai.set(n, n);
      unir(nosPedido[i], n);
    }
  });
  const componentes = new Map<string, { valor: number; data: DataISO; nfs: Set<string>; semNf: boolean }>();
  pedidos.forEach((p, i) => {
    const raiz = achar(nosPedido[i]);
    const c = componentes.get(raiz) ?? { valor: 0, data: p.dataPedido, nfs: new Set<string>(), semNf: false };
    c.valor += p.valorTotal;
    if (p.dataPedido < c.data) c.data = p.dataPedido;
    p.nfs.map(normalizarNf).filter((x) => x !== '').forEach((nf) => c.nfs.add(nf));
    componentes.set(raiz, c);
  });
  const fluxos: Fluxo[] = [];
  let naoConciliado = 0;
  for (const c of componentes.values()) {
    const titulado = [...c.nfs].reduce((s, nf) => s + (titulosPorNf.get(nf) ?? 0), 0);
    const residuo = c.valor - titulado;
    // Sem NF válida, ou NF sem nenhum título casado: nada comprova o faturamento → não conciliado (spec §6.2).
    const semNf = c.nfs.size === 0 || titulado === 0;
    if (residuo <= 0) continue;
    const dataPrevista = addDias(c.data, lagDias);
    const data = dataPrevista < inicio ? inicio : dataPrevista;
    if (semNf) naoConciliado += residuo;
    fluxos.push({ data, valor: -residuo, camada: semNf ? 'compromisso_nao_conciliado' : 'compromisso_conciliado' });
  }
  return { fluxos, naoConciliado };
}

export function ritmoPorDiaDoMes(pagamentos: { data: DataISO; valor: number }[], meses: number): number[] {
  if (!(meses > 0)) throw new Error('meses deve ser > 0');
  const ritmo = new Array<number>(32).fill(0);
  for (const p of pagamentos) ritmo[Number(p.data.slice(8, 10))] += p.valor / meses;
  return ritmo;
}

const ultimoDiaDoMes = (d: DataISO) => {
  const [a, m] = d.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
};

/**
 * `jaTituladoPorMes[mes]` deve conter APENAS títulos em aberto (não-Sayerlack) com vencimento
 * dentro de [inicio, inicio+dias) daquele mês; o desconto é aplicado sobre o total da janela.
 */
export function projetarRitmo(inicio: DataISO, dias: number, ritmo: number[], jaTituladoPorMes: Record<string, number>): Fluxo[] {
  const porMes = new Map<string, { data: DataISO; bruto: number }[]>();
  for (let i = 0; i < dias; i++) {
    const data = addDias(inicio, i);
    const dia = Number(data.slice(8, 10));
    const ult = ultimoDiaDoMes(data);
    let bruto = ritmo[dia] ?? 0;
    if (dia === ult) for (let extra = ult + 1; extra <= 31; extra++) bruto += ritmo[extra] ?? 0;
    const mes = data.slice(0, 7);
    if (!porMes.has(mes)) porMes.set(mes, []);
    porMes.get(mes)!.push({ data, bruto });
  }
  const out: Fluxo[] = [];
  for (const [mes, diasMes] of porMes) {
    const total = diasMes.reduce((s, x) => s + x.bruto, 0);
    if (total <= 0) continue;
    const fator = Math.max(total - (jaTituladoPorMes[mes] ?? 0), 0) / total;
    for (const x of diasMes) if (x.bruto * fator > 0) out.push({ data: x.data, valor: -x.bruto * fator, camada: 'saida_nao_sayerlack' });
  }
  return out;
}

export function provisaoContinuidade(inicio: DataISO, dias: number, porDiaUtil: number, lagDias: number, compraAceita: number): Fluxo[] {
  let aConsumir = compraAceita;
  const out: Fluxo[] = [];
  for (let i = lagDias + 1; i < dias; i++) {
    const data = addDias(inicio, i);
    if (!ehDiaUtil(data)) continue;
    const consumo = Math.min(aConsumir, porDiaUtil);
    aConsumir -= consumo;
    const valor = porDiaUtil - consumo;
    if (valor > 0) out.push({ data, valor: -valor, camada: 'continuidade_motor' });
  }
  return out;
}
