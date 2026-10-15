// src/lib/reposicao/orcamento-compra/corte.ts
// Corte do orçamento (spec §5.4). Heurística gulosa — NÃO é ótima (caso A/B/C); a saída se chama
// "score marginal da heurística", não preço-sombra.
import type { DataISO } from './datas';
import type { Embalagem } from './embalagens';
import { avaliarEstado, trajetoriaDiaria, type EstadoCaixa, type Fluxo } from './caixa';

export interface Candidata extends Embalagem {
  deltaV: number | null;
  protegida: boolean;
  motivoSemScore: string | null;
}
export type MotivoCorte = 'economico' | 'financeiro' | 'minimo' | 'sem_score';
export interface BaseCaixa { saldoInicial: number; inicio: DataISO; dias: number; fluxos: Fluxo[]; ausencias: string[] }
export interface ResultadoCorte {
  aceitas: Candidata[];
  cortadas: { c: Candidata; motivo: MotivoCorte }[];
  estado: EstadoCaixa;
  scoreMarginal: number | null;
  escassezCaixa: boolean;
  pedidosAbaixoMinimo: number[];
}

const fluxoDe = (c: Candidata): Fluxo => ({ data: c.dataPagamento, valor: -(c.desembolso as number), camada: 'candidato' });
const chaveSku = (c: Candidata) => `${c.pedidoRaizId}|${c.sku}`;

export function cortar(cands: Candidata[], base: BaseCaixa, reserva: number, minimoPedido: number): ResultadoCorte {
  const fluxos: Fluxo[] = [...base.fluxos];
  // Base de caixa com camada ausente: só o gate econômico decide; o estado final sai `indeterminado`
  // (nunca "aceito pelo orçamento" sobre saldo fabricado — spec §6).
  const semCaixa = base.ausencias.length > 0;
  const cabe = (extra: Fluxo[]) =>
    semCaixa ||
    avaliarEstado(trajetoriaDiaria(base.saldoInicial, base.inicio, base.dias, [...fluxos, ...extra]), reserva, []).tipo === 'viavel';

  const aceitas: Candidata[] = [];
  const cortadas: { c: Candidata; motivo: MotivoCorte }[] = [];
  const aceitaKs = new Set<string>();
  const marcar = (c: Candidata) => aceitaKs.add(`${chaveSku(c)}|${c.k}`);
  const temAnterior = (c: Candidata) => c.k === 1 || aceitaKs.has(`${chaveSku(c)}|${c.k - 1}`);

  // 1. protegidas
  for (const c of cands) {
    if (!c.protegida) continue;
    if (c.desembolso == null) { cortadas.push({ c, motivo: 'sem_score' }); continue; }
    aceitas.push(c); marcar(c); fluxos.push(fluxoDe(c));
  }
  const estadoProtegidas = avaliarEstado(trajetoriaDiaria(base.saldoInicial, base.inicio, base.dias, fluxos), reserva, []);
  if (!semCaixa && estadoProtegidas.tipo === 'inviavel') {
    for (const c of cands) if (!c.protegida) cortadas.push({ c, motivo: c.deltaV == null || c.desembolso == null ? 'sem_score' : 'financeiro' });
    return { aceitas, cortadas, estado: estadoProtegidas, scoreMarginal: null, escassezCaixa: true, pedidosAbaixoMinimo: [] };
  }

  // 2. score ajustado não-crescente por SKU (respeita o prefixo)
  const discricionarias = cands.filter((c) => !c.protegida);
  const ajustado = new Map<Candidata, number>();
  const porSku = new Map<string, Candidata[]>();
  for (const c of discricionarias) {
    if (c.deltaV == null || c.desembolso == null || c.desembolso <= 0) continue;
    const k = chaveSku(c);
    if (!porSku.has(k)) porSku.set(k, []);
    porSku.get(k)!.push(c);
  }
  for (const lista of porSku.values()) {
    lista.sort((a, b) => a.k - b.k);
    let teto = Infinity;
    for (const c of lista) {
      teto = Math.min(teto, (c.deltaV as number) / (c.desembolso as number));
      ajustado.set(c, teto);
    }
  }
  for (const c of discricionarias) if (!ajustado.has(c)) cortadas.push({ c, motivo: 'sem_score' });

  const ordem = [...ajustado.keys()].sort(
    (a, b) => ajustado.get(b)! - ajustado.get(a)! || a.sku.localeCompare(b.sku) || a.k - b.k,
  );
  let scoreMarginal: number | null = null;
  for (const c of ordem) {
    const s = ajustado.get(c)!;
    if (s <= 0) { cortadas.push({ c, motivo: 'economico' }); continue; }
    if (!temAnterior(c) || !cabe([fluxoDe(c)])) { cortadas.push({ c, motivo: 'financeiro' }); continue; }
    aceitas.push(c); marcar(c); fluxos.push(fluxoDe(c)); scoreMarginal = s;
  }

  // 3. mínimo por pedido
  const pedidosAbaixoMinimo: number[] = [];
  if (minimoPedido > 0) {
    const raizes = new Set(cands.map((c) => c.pedidoRaizId));
    for (const raiz of raizes) {
      const doPedido = () => aceitas.filter((c) => c.pedidoRaizId === raiz);
      const total = () => doPedido().reduce((s, c) => s + (c.desembolso as number), 0);
      if (total() === 0 || total() >= minimoPedido) continue;
      const candidatasAoMinimo = cortadas
        .filter((x) => x.c.pedidoRaizId === raiz && x.motivo !== 'sem_score' && ajustado.has(x.c))
        .sort((a, b) => ajustado.get(b.c)! - ajustado.get(a.c)! || a.c.k - b.c.k);
      const adicionadas: Candidata[] = [];
      for (const x of candidatasAoMinimo) {
        if (total() >= minimoPedido) break;
        if (!temAnterior(x.c) || !cabe([fluxoDe(x.c)])) continue;
        aceitas.push(x.c); marcar(x.c); fluxos.push(fluxoDe(x.c)); adicionadas.push(x.c);
      }
      const somaDeltaV = doPedido().reduce((s, c) => s + (c.deltaV ?? 0), 0);
      const temProtegida = doPedido().some((c) => c.protegida);
      if (total() >= minimoPedido && (somaDeltaV > 0 || temProtegida)) {
        for (const a of adicionadas) cortadas.splice(cortadas.findIndex((x) => x.c === a), 1);
        continue;
      }
      if (temProtegida) {
        for (const a of adicionadas) cortadas.splice(cortadas.findIndex((x) => x.c === a), 1);
        pedidosAbaixoMinimo.push(raiz);
        continue;
      }
      // zera o pedido: tira do aceito e dos fluxos
      for (const c of doPedido()) {
        aceitas.splice(aceitas.indexOf(c), 1);
        const iFluxo = fluxos.findIndex((f) => f.camada === 'candidato' && f.data === c.dataPagamento && f.valor === -(c.desembolso as number));
        fluxos.splice(iFluxo, 1);
        const jaCortada = cortadas.findIndex((x) => x.c === c);
        if (jaCortada >= 0) cortadas[jaCortada] = { c, motivo: 'minimo' };
        else cortadas.push({ c, motivo: 'minimo' });
      }
    }
  }

  const estado = avaliarEstado(trajetoriaDiaria(base.saldoInicial, base.inicio, base.dias, fluxos), reserva, base.ausencias);
  return {
    aceitas,
    cortadas,
    estado,
    scoreMarginal,
    escassezCaixa: cortadas.some((x) => x.motivo === 'financeiro'),
    pedidosAbaixoMinimo,
  };
}
