import { describe, it, expect } from "vitest";
import {
  julgarTrimestre,
  mediaDasMetas,
  montarCards,
  montarChartData,
  numOuNull,
  progressoDaMeta,
  rotuloFaturado,
  temHistorico,
  type EntradaCards,
  type PosicaoAoVivo,
} from "../derivar";
import type { CheckinDescontoRow, MetaRow, SnapshotRow } from "../types";

// Cenário próximo da prod em 2026-11 (OBEN): T4/26 é o atual; T3/26 e T1/26 têm meta mas NENHUM
// snapshot; T2/26 tem snapshot de FECHAMENTO (30/06) aqui — na prod o único é PARCIAL (18/04), ver
// o describe de fechamento. O trimestre T4/25 não tem meta cadastrada (só checkin).
const META_ATUAL = 500_000;
const META_PASSADA = 400_840.02;

const metas: MetaRow[] = [
  { ano: 2026, trimestre: 4, meta_faturamento: META_ATUAL, faixa_des_objetivo: null },
  { ano: 2026, trimestre: 3, meta_faturamento: META_PASSADA, faixa_des_objetivo: null },
  { ano: 2026, trimestre: 2, meta_faturamento: META_PASSADA, faixa_des_objetivo: null },
  { ano: 2026, trimestre: 1, meta_faturamento: META_PASSADA, faixa_des_objetivo: null },
];

const snapshots: SnapshotRow[] = [
  { ano: 2026, trimestre: 2, data_referencia: "2026-06-30", fat_bruto_valor: 410_000, pedidos_abertos_valor: null, objetivo_valor: 999_999 },
];

const checkin = (ano: number, trimestre: number, estrelas: number | null): CheckinDescontoRow =>
  ({ checkin_id: `${ano}-${trimestre}`, ano, trimestre, data_avaliacao: `${ano}-12-01`, tipo: "projecao", estrelas }) as unknown as CheckinDescontoRow;

const live: PosicaoAoVivo = {
  ano: 2026,
  trimestre: 4,
  posicao_ao_vivo_conservadora: 120_000,
  fat_bruto_confirmado: 80_000,
  gooddata_data_referencia: "2026-10-31",
  faixa_conservadora: { estrelas: 2 },
  meta_pessoal: META_ATUAL,
  inicio_trimestre: "2026-10-01",
  fim_trimestre: "2026-12-31",
};

function entrada(over: Partial<EntradaCards> = {}): EntradaCards {
  return { metas, snapshots, checkins: [checkin(2025, 4, 3)], live, anoAtual: 2026, trimestreAtual: 4, ...over };
}

const card = (cards: ReturnType<typeof montarCards>, ano: number, trimestre: number) => {
  const c = cards.find((x) => x.ano === ano && x.trimestre === trimestre);
  if (!c) throw new Error(`card T${trimestre}/${ano} ausente`);
  return c;
};

describe("montarCards — nulidade (ausente ≠ zero)", () => {
  it("trimestre passado SEM snapshot tem faturado null, não 0", () => {
    const cards = montarCards(entrada());
    expect(card(cards, 2026, 3).faturado).toBeNull();
    expect(card(cards, 2026, 1).faturado).toBeNull();
    expect(card(cards, 2026, 2).faturado).toBe(410_000);
  });

  it("snapshot existente com fat_bruto_valor null continua null (não 0)", () => {
    const s: SnapshotRow = { ...snapshots[0], fat_bruto_valor: null };
    expect(card(montarCards(entrada({ snapshots: [s] })), 2026, 2).faturado).toBeNull();
  });

  it("trimestre atual sem posição ao vivo nem snapshot tem faturado null", () => {
    expect(card(montarCards(entrada({ live: null })), 2026, 4).faturado).toBeNull();
  });

  it("sem faixa ao vivo nem checkin, faixaEstrelas é null (não 0★)", () => {
    const cards = montarCards(entrada());
    expect(card(cards, 2026, 3).faixaEstrelas).toBeNull();
    expect(card(cards, 2025, 4).faixaEstrelas).toBe(3);
    expect(card(cards, 2026, 4).faixaEstrelas).toBe(2);
  });

  it("zero REAL de snapshot é preservado (não vira null) e é julgado", () => {
    const s: SnapshotRow = { ...snapshots[0], fat_bruto_valor: 0 };
    const c = card(montarCards(entrada({ snapshots: [s] })), 2026, 2);
    expect(c.faturado).toBe(0);
    expect(julgarTrimestre(c)).toBe("nao_atingida");
  });

  it("último snapshot com faturado null NÃO cai para um anterior preenchido", () => {
    const anterior: SnapshotRow = { ...snapshots[0], data_referencia: "2026-05-15", fat_bruto_valor: 200_000 };
    const ultimo: SnapshotRow = { ...snapshots[0], data_referencia: "2026-07-02", fat_bruto_valor: null };
    const c = card(montarCards(entrada({ snapshots: [anterior, ultimo] })), 2026, 2);
    expect(c.faturado).toBeNull();
    expect(julgarTrimestre(c)).toBe("sem_dado");
  });

  it("numOuNull nunca fabrica 0", () => {
    expect(numOuNull(null)).toBeNull();
    expect(numOuNull(undefined)).toBeNull();
    expect(numOuNull("")).toBeNull();
    expect(numOuNull("   ")).toBeNull();
    expect(numOuNull(false)).toBeNull();
    expect(numOuNull([])).toBeNull();
    expect(numOuNull(Number.POSITIVE_INFINITY)).toBeNull();
    expect(numOuNull(Number.NaN)).toBeNull();
    expect(numOuNull("abc")).toBeNull();
    expect(numOuNull(0)).toBe(0);
    expect(numOuNull("12.5")).toBe(12.5);
  });
});

describe("montarCards — procedência temporal (meta do próprio trimestre)", () => {
  it("trimestre passado sem meta NÃO herda a meta atual da posição ao vivo", () => {
    const cards = montarCards(entrada());
    expect(card(cards, 2025, 4).meta).toBeNull();
  });

  it("trimestre passado sem meta própria não herda mesmo sem nenhuma linha de meta", () => {
    const cards = montarCards(entrada({ metas: [], checkins: [checkin(2026, 3, 4)] }));
    expect(card(cards, 2026, 3).meta).toBeNull();
    expect(card(cards, 2026, 4).meta).toBe(META_ATUAL);
  });

  it("trimestre passado com meta usa a dele, não a atual", () => {
    expect(card(montarCards(entrada()), 2026, 3).meta).toBe(META_PASSADA);
  });

  it("trimestre atual sem linha em des_meta_empresa usa a meta da posição ao vivo DO atual", () => {
    const semMetaAtual = metas.filter((m) => !(m.ano === 2026 && m.trimestre === 4));
    expect(card(montarCards(entrada({ metas: semMetaAtual })), 2026, 4).meta).toBe(META_ATUAL);
  });

  it("posição ao vivo de OUTRO trimestre é ignorada (não vaza meta/faturado)", () => {
    const vivoErrado: PosicaoAoVivo = { ...live, trimestre: 3 };
    const semMetaAtual = metas.filter((m) => !(m.ano === 2026 && m.trimestre === 4));
    const atual = card(montarCards(entrada({ live: vivoErrado, metas: semMetaAtual })), 2026, 4);
    expect(atual.meta).toBeNull();
    expect(atual.faturado).toBeNull();
  });

  it("meta própria ZERO do atual não é substituída pela da posição ao vivo", () => {
    const comZero = metas.map((m) => (m.ano === 2026 && m.trimestre === 4 ? { ...m, meta_faturamento: 0 } : m));
    expect(card(montarCards(entrada({ metas: comZero })), 2026, 4).meta).toBe(0);
  });

  it("mesmo trimestre de OUTRO ano não herda a posição ao vivo", () => {
    const cards = montarCards(entrada({ checkins: [checkin(2025, 4, 3)] }));
    const t4_25 = card(cards, 2025, 4);
    expect(t4_25.meta).toBeNull();
    expect(t4_25.faturado).toBeNull();
  });

  it("objetivo_valor do snapshot (objetivo do fornecedor) não vira meta", () => {
    const sem = metas.filter((m) => !(m.ano === 2026 && m.trimestre === 2));
    expect(card(montarCards(entrada({ metas: sem })), 2026, 2).meta).toBeNull();
  });
});

describe("posição ao vivo ≠ faturado (view faz COALESCE(fat_bruto,0) + trânsito)", () => {
  it("sem fat_bruto_confirmado a posição é só trânsito: faturado e faixa ao vivo viram null", () => {
    // prod 2026-11-05, T4/26: fat_bruto_confirmado NULL, posição 264.175,21 = trânsito, 3★ dela.
    const soTransito: PosicaoAoVivo = { ...live, fat_bruto_confirmado: null, gooddata_data_referencia: null, posicao_ao_vivo_conservadora: 264_175.21, faixa_conservadora: { estrelas: 3 } };
    const atual = card(montarCards(entrada({ live: soTransito })), 2026, 4);
    expect(atual.faturado).toBeNull();
    expect(atual.faixaEstrelas).toBeNull();
    expect(atual.meta).toBe(META_ATUAL);
  });

  it("com fat_bruto_confirmado a posição vale e é rotulada como posição, não faturado", () => {
    const atual = card(montarCards(entrada()), 2026, 4);
    expect(atual.faturado).toBe(120_000);
    expect(atual.faturadoOrigem).toBe("ao_vivo");
    expect(rotuloFaturado(atual)).toBe("Posição ao vivo (faturado + pedidos)");
  });
});

describe("fechamento — snapshot parcial não julga", () => {
  it("prod: único snapshot do T2/26 é de 18/04 → sem_fechamento, rótulo 'Faturado até 18/04/2026'", () => {
    const parcial: SnapshotRow = { ...snapshots[0], data_referencia: "2026-04-18", fat_bruto_valor: 103_068.74 };
    const c = card(montarCards(entrada({ snapshots: [parcial] })), 2026, 2);
    expect(c.faturado).toBe(103_068.74);
    expect(c.fechado).toBe(false);
    expect(julgarTrimestre(c)).toBe("sem_fechamento");
    expect(rotuloFaturado(c)).toBe("Faturado até 18/04/2026");
  });

  it("snapshot NO último dia do trimestre fecha; um dia antes não", () => {
    const noFim: SnapshotRow = { ...snapshots[0], data_referencia: "2026-06-30" };
    const vespera: SnapshotRow = { ...snapshots[0], data_referencia: "2026-06-29" };
    expect(card(montarCards(entrada({ snapshots: [noFim] })), 2026, 2).fechado).toBe(true);
    expect(card(montarCards(entrada({ snapshots: [vespera] })), 2026, 2).fechado).toBe(false);
  });

  it("snapshot do trimestre atual nunca 'fecha' (mesmo sem posição ao vivo)", () => {
    const s: SnapshotRow = { ...snapshots[0], ano: 2026, trimestre: 4, data_referencia: "2026-12-31" };
    const c = card(montarCards(entrada({ snapshots: [s], live: null })), 2026, 4);
    expect(c.fechado).toBe(false);
    expect(c.faturadoOrigem).toBe("snapshot");
  });
});

describe("julgarTrimestre — sem meta/faturado/fechamento nunca é 'não atingida'", () => {
  const base = { isAtual: false, isFuturo: false, fechado: true };
  it("passado com meta e faturado null → sem_dado", () => {
    expect(julgarTrimestre({ ...base, meta: META_PASSADA, faturado: null })).toBe("sem_dado");
  });
  it("passado sem meta → sem_dado (mesmo com faturado)", () => {
    expect(julgarTrimestre({ ...base, meta: null, faturado: 10 })).toBe("sem_dado");
    expect(julgarTrimestre({ ...base, meta: 0, faturado: 10 })).toBe("sem_dado");
  });
  it("passado sem fechamento → sem_fechamento", () => {
    expect(julgarTrimestre({ ...base, fechado: false, meta: 100, faturado: 1 })).toBe("sem_fechamento");
  });
  it("passado fechado → atingida / nao_atingida, no centavo", () => {
    expect(julgarTrimestre({ ...base, meta: 100, faturado: 100 })).toBe("atingida");
    expect(julgarTrimestre({ ...base, meta: 100, faturado: 100.01 })).toBe("atingida");
    expect(julgarTrimestre({ ...base, meta: 100, faturado: 99.99 })).toBe("nao_atingida");
  });
  it("atual → em_andamento; futuro → planejado", () => {
    expect(julgarTrimestre({ ...base, isAtual: true, meta: null, faturado: null })).toBe("em_andamento");
    expect(julgarTrimestre({ ...base, isFuturo: true, meta: 100, faturado: null })).toBe("planejado");
  });
  it("trimestre futuro com meta cadastrada vira card 'planejado', não 'não atingida'", () => {
    const comFuturo = [...metas, { ano: 2027, trimestre: 1, meta_faturamento: 450_000, faixa_des_objetivo: null }];
    const f = card(montarCards(entrada({ metas: comFuturo })), 2027, 1);
    expect(f.isFuturo).toBe(true);
    expect(julgarTrimestre(f)).toBe("planejado");
  });
  it("cenário prod: 5 cards preservados; só T2/26 (fechado) é julgado", () => {
    const chart = montarChartData(montarCards(entrada()));
    const por = Object.fromEntries(chart.map((d) => [d.label, d.julgamento]));
    expect(por).toEqual({
      "T4/25": "sem_dado",
      "T1/26": "sem_dado",
      "T2/26": "atingida",
      "T3/26": "sem_dado",
      "T4/26": "em_andamento",
    });
  });
});

describe("temHistorico — ausência de meta não é ausência de histórico", () => {
  it("só a posição ao vivo do atual (sem meta/snapshot/checkin) já é histórico", () => {
    expect(temHistorico(montarCards(entrada({ metas: [], snapshots: [], checkins: [] })))).toBe(true);
  });
  it("nada em fonte nenhuma → sem histórico", () => {
    expect(temHistorico(montarCards(entrada({ metas: [], snapshots: [], checkins: [], live: null })))).toBe(false);
  });
});

describe("progresso e meta média", () => {
  it("progresso null sem meta ou sem faturado", () => {
    expect(progressoDaMeta({ meta: null, faturado: 10 })).toBeNull();
    expect(progressoDaMeta({ meta: 100, faturado: null })).toBeNull();
    expect(progressoDaMeta({ meta: 200, faturado: 50 })).toBe(25);
  });
  it("meta média ignora trimestres sem meta e é null sem nenhuma", () => {
    const chart = montarChartData(montarCards(entrada()));
    expect(mediaDasMetas(chart)).toBeCloseTo((META_ATUAL + 3 * META_PASSADA) / 4, 2);
    expect(mediaDasMetas(montarChartData(montarCards(entrada({ metas: [], live: null }))))).toBeNull();
  });
});
