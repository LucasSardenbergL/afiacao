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
  const retirarFluxo = (c: Candidata) => {
    const i = fluxos.findIndex((f) => f.camada === 'candidato' && f.data === c.dataPagamento && f.valor === -(c.desembolso as number));
    if (i >= 0) fluxos.splice(i, 1);
  };
  const cortadas: { c: Candidata; motivo: MotivoCorte }[] = [];
  const aceitaKs = new Set<string>();
  const marcar = (c: Candidata) => aceitaKs.add(`${chaveSku(c)}|${c.k}`);
  const temAnterior = (c: Candidata) => c.k === 1 || aceitaKs.has(`${chaveSku(c)}|${c.k - 1}`);

  // 1. protegidas (protegida sem desembolso: caixa desconhecido → estado final indeterminado)
  let protegidoSemDesembolso = false;
  for (const c of cands) {
    if (!c.protegida) continue;
    if (c.desembolso == null) { cortadas.push({ c, motivo: 'sem_score' }); protegidoSemDesembolso = true; continue; }
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
  const todosPorSku = new Map<string, Candidata[]>();
  for (const c of discricionarias) {
    const k = chaveSku(c);
    if (!todosPorSku.has(k)) todosPorSku.set(k, []);
    todosPorSku.get(k)!.push(c);
  }
  // Prefixo: a 1ª embalagem sem score derruba ela e TODAS as seguintes do mesmo (pedido, SKU) — nunca entram no guloso.
  for (const lista of todosPorSku.values()) {
    lista.sort((a, b) => a.k - b.k);
    let teto = Infinity;
    let quebrou = false;
    for (const c of lista) {
      if (quebrou || c.deltaV == null || c.desembolso == null || !(c.desembolso > 0)) {
        quebrou = true;
        cortadas.push({ c, motivo: 'sem_score' });
        continue;
      }
      teto = Math.min(teto, c.deltaV / c.desembolso);
      ajustado.set(c, teto);
    }
  }

  const ordem = [...ajustado.keys()].sort(
    (a, b) => ajustado.get(b)! - ajustado.get(a)! || a.pedidoRaizId - b.pedidoRaizId || a.sku.localeCompare(b.sku) || a.k - b.k,
  );
  for (const c of ordem) {
    const s = ajustado.get(c)!;
    if (s <= 0) { cortadas.push({ c, motivo: 'economico' }); continue; }
    if (!temAnterior(c) || !cabe([fluxoDe(c)])) { cortadas.push({ c, motivo: 'financeiro' }); continue; }
    aceitas.push(c); marcar(c); fluxos.push(fluxoDe(c));
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
      const adicionadas: { c: Candidata; motivo: MotivoCorte }[] = [];
      for (const x of candidatasAoMinimo) {
        if (total() >= minimoPedido) break;
        if (!temAnterior(x.c) || !cabe([fluxoDe(x.c)])) continue;
        cortadas.splice(cortadas.indexOf(x), 1);
        aceitas.push(x.c); marcar(x.c); fluxos.push(fluxoDe(x.c)); adicionadas.push(x);
      }
      const somaDeltaV = doPedido().reduce((s, c) => s + (c.deltaV ?? 0), 0);
      const temProtegida = doPedido().some((c) => c.protegida);
      if (total() >= minimoPedido && (somaDeltaV > 0 || temProtegida)) continue;
      // não fechou o mínimo de forma útil: desfaz as adicionadas (aceitas, prefixo, fluxo) devolvendo o motivo original
      for (const a of adicionadas) {
        aceitas.splice(aceitas.indexOf(a.c), 1);
        aceitaKs.delete(`${chaveSku(a.c)}|${a.c.k}`);
        retirarFluxo(a.c);
        cortadas.push(a);
      }
      if (temProtegida) { pedidosAbaixoMinimo.push(raiz); continue; }
      // zera o pedido: tudo dele (aceito ou já cortado, qualquer motivo) vira 'minimo' e sai dos fluxos
      for (const c of doPedido()) {
        aceitas.splice(aceitas.indexOf(c), 1);
        retirarFluxo(c);
        cortadas.push({ c, motivo: 'minimo' });
      }
      for (const x of cortadas) if (x.c.pedidoRaizId === raiz) x.motivo = 'minimo';
    }
  }

  const aceitasDiscricionarias = aceitas.filter((c) => !c.protegida);
  const scoreMarginal = aceitasDiscricionarias.length === 0 ? null : Math.min(...aceitasDiscricionarias.map((c) => ajustado.get(c)!));

  const estado = avaliarEstado(trajetoriaDiaria(base.saldoInicial, base.inicio, base.dias, fluxos), reserva, protegidoSemDesembolso ? [...base.ausencias, 'protegido_sem_desembolso'] : base.ausencias);
  return {
    aceitas,
    cortadas,
    estado,
    scoreMarginal,
    escassezCaixa: cortadas.some((x) => x.motivo === 'financeiro'),
    pedidosAbaixoMinimo,
  };
}
