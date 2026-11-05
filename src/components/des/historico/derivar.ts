// Derivação PURA dos cards do histórico do DES (money-path: o julgamento do trimestre decide
// o desconto do trimestre seguinte). Três invariantes — cada uma tem teste que falsifica:
//
//  1. NULIDADE — ausente ≠ zero. Trimestre sem snapshot/posição não tem faturado `0`: tem `null`
//     ("—"). Idem meta e faixa de estrelas. `Number(x ?? 0)` era fabricação.
//  2. PROCEDÊNCIA TEMPORAL — a meta de um trimestre é a do PRÓPRIO trimestre. A posição ao vivo
//     (`v_des_posicao_trimestre_ao_vivo`) é filtrada pelo trimestre ATUAL; usá-la como fallback de
//     um trimestre passado transportava a meta de hoje para o passado.
//  3. JULGAMENTO — sem meta ou sem faturado não há "não atingida": há "sem dado".
import { faixaDeJson } from "../faixa-json";
import { quarterDates } from "./format";
import type {
  ChartDatum,
  CheckinDescontoRow,
  JulgamentoTrimestre,
  MetaRow,
  QuarterCard,
  SnapshotRow,
} from "./types";
import type { Json } from "@/integrations/supabase/types";

/** Linha da posição ao vivo (só do trimestre atual) — subconjunto lido pelo hook. */
export interface PosicaoAoVivo {
  ano: number | null;
  trimestre: number | null;
  posicao_ao_vivo_conservadora: number | null;
  faixa_conservadora: Json | null;
  meta_pessoal: number | null;
  inicio_trimestre: string | null;
  fim_trimestre: string | null;
}

/** `null` para ausente ou não-finito — nunca 0. */
export function numOuNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Veredito do trimestre. `sem_dado` quando não há meta positiva ou não há faturado: julgar
 * contra meta ausente (ou zero, que não é meta cadastrável com sentido) ou contra faturado
 * ausente fabrica o veredito.
 */
export function julgarTrimestre(c: Pick<QuarterCard, "isAtual" | "meta" | "faturado">): JulgamentoTrimestre {
  if (c.isAtual) return "em_andamento";
  if (c.meta === null || c.meta <= 0 || c.faturado === null) return "sem_dado";
  return c.faturado >= c.meta ? "atingida" : "nao_atingida";
}

/** % da meta (0–100) ou `null` quando não há meta positiva ou faturado. */
export function progressoDaMeta(c: Pick<QuarterCard, "meta" | "faturado">): number | null {
  if (c.meta === null || c.meta <= 0 || c.faturado === null) return null;
  return Math.min((c.faturado / c.meta) * 100, 100);
}

export interface EntradaCards {
  metas: MetaRow[];
  snapshots: SnapshotRow[];
  checkins: CheckinDescontoRow[];
  live: PosicaoAoVivo | null | undefined;
  anoAtual: number;
  trimestreAtual: number;
}

export function montarCards({ metas, snapshots, checkins, live, anoAtual, trimestreAtual }: EntradaCards): QuarterCard[] {
  const keys = new Set<string>();
  metas.forEach((m) => keys.add(`${m.ano}-${m.trimestre}`));
  snapshots.forEach((s) => keys.add(`${s.ano}-${s.trimestre}`));
  checkins.forEach((c) => keys.add(`${c.ano}-${c.trimestre}`));
  keys.add(`${anoAtual}-${trimestreAtual}`);

  // A posição ao vivo só vale para o trimestre que ela declara ser (e que o hook pediu).
  const liveDoAtual = live && live.ano === anoAtual && live.trimestre === trimestreAtual ? live : null;

  const list: QuarterCard[] = Array.from(keys).map((k) => {
    const [a, t] = k.split("-").map(Number);
    const isAtual = a === anoAtual && t === trimestreAtual;
    const liveDoTri = isAtual ? liveDoAtual : null;
    const meta = metas.find((m) => m.ano === a && m.trimestre === t);
    const snapsTri = snapshots
      .filter((s) => s.ano === a && s.trimestre === t)
      .sort((x, y) => (x.data_referencia < y.data_referencia ? 1 : x.data_referencia > y.data_referencia ? -1 : 0));
    const ultimoSnap = snapsTri[0];

    // Trimestre corrente: posição ao vivo conservadora; senão o último snapshot DO trimestre.
    const faturado =
      numOuNull(liveDoTri?.posicao_ao_vivo_conservadora) ?? numOuNull(ultimoSnap?.fat_bruto_valor);

    // Último checkin: confirmacao_andre tem prioridade, senão o mais recente.
    const checkinsTri = checkins.filter((c) => c.ano === a && c.trimestre === t);
    const ultimoCheckin =
      checkinsTri.find((c) => c.tipo === "confirmacao_andre") ?? checkinsTri[0] ?? null;

    const faixaEstrelas =
      numOuNull(faixaDeJson(liveDoTri?.faixa_conservadora)?.estrelas) ?? numOuNull(ultimoCheckin?.estrelas);

    const dates = quarterDates(a, t);
    return {
      ano: a,
      trimestre: t,
      isAtual,
      // Meta do PRÓPRIO trimestre; a do ao vivo só cobre o atual (mesma fonte: des_meta_empresa).
      meta: numOuNull(meta?.meta_faturamento) ?? numOuNull(liveDoTri?.meta_pessoal),
      faturado,
      faixaEstrelas,
      inicio: liveDoTri?.inicio_trimestre ?? dates.inicio,
      fim: liveDoTri?.fim_trimestre ?? dates.fim,
      ultimoCheckin,
      snapshots: snapsTri,
    };
  });

  list.sort((a, b) => (b.ano - a.ano) || (b.trimestre - a.trimestre));
  return list;
}

export function montarChartData(cards: QuarterCard[]): ChartDatum[] {
  return [...cards]
    .sort((a, b) => (a.ano - b.ano) || (a.trimestre - b.trimestre))
    .map((c) => ({
      label: `T${c.trimestre}/${String(c.ano).slice(2)}`,
      faturado: c.faturado,
      meta: c.meta,
      isAtual: c.isAtual,
      julgamento: julgarTrimestre(c),
    }));
}

/** Média das metas POSITIVAS conhecidas; `null` quando nenhuma (sem linha de referência). */
export function mediaDasMetas(chart: ChartDatum[]): number | null {
  const metas = chart.map((d) => d.meta).filter((m): m is number => m !== null && m > 0);
  if (!metas.length) return null;
  return metas.reduce((a, b) => a + b, 0) / metas.length;
}
