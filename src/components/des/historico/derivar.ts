// Derivação PURA dos cards do histórico do DES (money-path: o julgamento do trimestre decide
// o desconto do trimestre seguinte). Invariantes — cada uma tem teste que falsifica:
//
//  1. NULIDADE — ausente ≠ zero. Trimestre sem snapshot/posição não tem faturado `0`: tem `null`
//     ("—"). Idem meta e faixa de estrelas. `Number(x ?? 0)` era fabricação.
//  2. PROCEDÊNCIA TEMPORAL — a meta de um trimestre é a do PRÓPRIO trimestre. A posição ao vivo
//     (`v_des_posicao_trimestre_ao_vivo`) é filtrada pelo trimestre ATUAL; usá-la como fallback de
//     um trimestre passado transportava a meta de hoje para o passado.
//  3. POSIÇÃO ≠ FATURADO — a posição conservadora da view é `COALESCE(fat_bruto,0) + trânsito`:
//     sem faturado GoodData (`fat_bruto_confirmado` NULL) ela é só pedido em trânsito, e a faixa
//     derivada dela também. Nesse caso a posição e a faixa ao vivo valem `null`.
//  4. FECHAMENTO — o último snapshot de um trimestre passado só é "faturado final" se foi tirado
//     no fim do trimestre ou depois (`data_referencia >= fim`). Antes disso é parcial: mostra o
//     valor com a data, mas NÃO julga (prod 2026-11: o único snapshot do T2/26 é de 18/04).
//  5. JULGAMENTO — sem meta, sem faturado, sem fechamento ou trimestre futuro não há
//     "não atingida": há "sem dado", "sem fechamento" ou "planejado".
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
  /** parcela FATURADA (GoodData) da posição; NULL = a posição é só trânsito. */
  fat_bruto_confirmado: number | null;
  gooddata_data_referencia: string | null;
  faixa_conservadora: Json | null;
  meta_pessoal: number | null;
  inicio_trimestre: string | null;
  fim_trimestre: string | null;
}

/** `null` para ausente, vazio ou não-finito — nunca 0. Só aceita number ou string numérica. */
export function numOuNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Veredito do trimestre. Só há atingida/não atingida com meta POSITIVA (o cadastro exige — ver
 * `configuracao/format.ts`), faturado conhecido e snapshot de fechamento.
 */
export function julgarTrimestre(
  c: Pick<QuarterCard, "isAtual" | "isFuturo" | "meta" | "faturado" | "fechado">,
): JulgamentoTrimestre {
  if (c.isAtual) return "em_andamento";
  if (c.isFuturo) return "planejado";
  if (c.meta === null || c.meta <= 0 || c.faturado === null) return "sem_dado";
  if (!c.fechado) return "sem_fechamento";
  return c.faturado >= c.meta ? "atingida" : "nao_atingida";
}

/** % da meta (0–100) ou `null` quando não há meta positiva ou faturado. */
export function progressoDaMeta(c: Pick<QuarterCard, "meta" | "faturado">): number | null {
  if (c.meta === null || c.meta <= 0 || c.faturado === null) return null;
  return Math.min((c.faturado / c.meta) * 100, 100);
}

const fmtDia = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("pt-BR");

/** Rótulo do valor de faturado — diz DE ONDE ele vem, nunca promete mais do que o dado. */
export function rotuloFaturado(c: Pick<QuarterCard, "faturadoOrigem" | "faturadoReferencia" | "fechado">): string {
  if (c.faturadoOrigem === "ao_vivo") return "Posição ao vivo (faturado + pedidos)";
  if (c.faturadoOrigem === "snapshot") {
    if (c.fechado) return "Faturado final";
    return c.faturadoReferencia ? `Faturado até ${fmtDia(c.faturadoReferencia)}` : "Faturado parcial";
  }
  return "Faturado";
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

  // A posição ao vivo só vale para o trimestre que ela declara ser (e que o hook pediu)...
  const liveDoAtual = live && live.ano === anoAtual && live.trimestre === trimestreAtual ? live : null;
  // ...e só é POSIÇÃO se tem a parcela faturada; sem ela é trânsito com cara de faturado.
  const liveComFaturado = liveDoAtual && numOuNull(liveDoAtual.fat_bruto_confirmado) !== null ? liveDoAtual : null;

  const list: QuarterCard[] = Array.from(keys).map((k) => {
    const [a, t] = k.split("-").map(Number);
    const isAtual = a === anoAtual && t === trimestreAtual;
    const isFuturo = a > anoAtual || (a === anoAtual && t > trimestreAtual);
    const liveDoTri = isAtual ? liveDoAtual : null;
    const posicaoDoTri = isAtual ? liveComFaturado : null;
    const meta = metas.find((m) => m.ano === a && m.trimestre === t);
    const snapsTri = snapshots
      .filter((s) => s.ano === a && s.trimestre === t)
      .sort((x, y) => (x.data_referencia < y.data_referencia ? 1 : x.data_referencia > y.data_referencia ? -1 : 0));
    // O ÚLTIMO snapshot decide: se ele não traz faturado, um anterior (menor, acumulado até
    // uma data mais antiga) não vira o "final".
    const ultimoSnap = snapsTri[0];
    const dates = quarterDates(a, t);
    const fim = isAtual ? (liveDoTri?.fim_trimestre ?? dates.fim) : dates.fim;

    const posicao = numOuNull(posicaoDoTri?.posicao_ao_vivo_conservadora);
    const fatSnap = numOuNull(ultimoSnap?.fat_bruto_valor);
    let faturado: number | null = null;
    let faturadoOrigem: QuarterCard["faturadoOrigem"] = null;
    let faturadoReferencia: string | null = null;
    if (posicao !== null) {
      faturado = posicao;
      faturadoOrigem = "ao_vivo";
      faturadoReferencia = posicaoDoTri?.gooddata_data_referencia ?? null;
    } else if (fatSnap !== null) {
      faturado = fatSnap;
      faturadoOrigem = "snapshot";
      faturadoReferencia = ultimoSnap.data_referencia;
    }
    const fechado = !isAtual && faturadoOrigem === "snapshot" && faturadoReferencia !== null && faturadoReferencia >= fim;

    // Último checkin: confirmacao_andre tem prioridade, senão o mais recente.
    const checkinsTri = checkins.filter((c) => c.ano === a && c.trimestre === t);
    const ultimoCheckin =
      checkinsTri.find((c) => c.tipo === "confirmacao_andre") ?? checkinsTri[0] ?? null;

    const faixaEstrelas =
      numOuNull(faixaDeJson(posicaoDoTri?.faixa_conservadora)?.estrelas) ?? numOuNull(ultimoCheckin?.estrelas);

    return {
      ano: a,
      trimestre: t,
      isAtual,
      isFuturo,
      // Meta do PRÓPRIO trimestre; a do ao vivo só cobre o atual (mesma fonte: des_meta_empresa).
      meta: numOuNull(meta?.meta_faturamento) ?? numOuNull(liveDoTri?.meta_pessoal),
      faturado,
      faturadoOrigem,
      faturadoReferencia,
      fechado,
      faixaEstrelas,
      inicio: liveDoTri?.inicio_trimestre ?? dates.inicio,
      fim,
      ultimoCheckin,
      snapshots: snapsTri,
    };
  });

  list.sort((a, b) => (b.ano - a.ano) || (b.trimestre - a.trimestre));
  return list;
}

/** Há algo a mostrar? Ausência de meta não é ausência de histórico (posição/snapshot/checkin). */
export function temHistorico(cards: QuarterCard[]): boolean {
  return cards.some((c) => c.meta !== null || c.faturado !== null || c.ultimoCheckin !== null || c.snapshots.length > 0);
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
