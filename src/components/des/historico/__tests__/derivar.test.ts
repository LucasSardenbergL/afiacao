import { describe, it, expect } from "vitest";
import {
  julgarTrimestre,
  mediaDasMetas,
  montarCards,
  montarChartData,
  numOuNull,
  progressoDaMeta,
  type EntradaCards,
  type PosicaoAoVivo,
} from "../derivar";
import type { CheckinDescontoRow, MetaRow, SnapshotRow } from "../types";

// Cenário espelha a prod em 2026-11 (OBEN): T4/26 é o atual; T3/26 e T1/26 têm meta mas NENHUM
// snapshot; T2/26 tem snapshot. O trimestre T4/25 não tem meta cadastrada (só checkin).
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

  it("numOuNull nunca fabrica 0", () => {
    expect(numOuNull(null)).toBeNull();
    expect(numOuNull(undefined)).toBeNull();
    expect(numOuNull("")).toBeNull();
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

  it("objetivo_valor do snapshot (objetivo do fornecedor) não vira meta", () => {
    const sem = metas.filter((m) => !(m.ano === 2026 && m.trimestre === 2));
    expect(card(montarCards(entrada({ metas: sem })), 2026, 2).meta).toBeNull();
  });
});

describe("julgarTrimestre — sem meta/sem faturado é 'sem_dado', nunca 'não atingida'", () => {
  it("passado com meta e faturado null → sem_dado", () => {
    expect(julgarTrimestre({ isAtual: false, meta: META_PASSADA, faturado: null })).toBe("sem_dado");
  });
  it("passado sem meta → sem_dado (mesmo com faturado)", () => {
    expect(julgarTrimestre({ isAtual: false, meta: null, faturado: 10 })).toBe("sem_dado");
    expect(julgarTrimestre({ isAtual: false, meta: 0, faturado: 10 })).toBe("sem_dado");
  });
  it("passado com dados → atingida / nao_atingida", () => {
    expect(julgarTrimestre({ isAtual: false, meta: 100, faturado: 100 })).toBe("atingida");
    expect(julgarTrimestre({ isAtual: false, meta: 100, faturado: 99.99 })).toBe("nao_atingida");
    expect(julgarTrimestre({ isAtual: false, meta: 100, faturado: 0 })).toBe("nao_atingida");
  });
  it("atual → em_andamento", () => {
    expect(julgarTrimestre({ isAtual: true, meta: null, faturado: null })).toBe("em_andamento");
  });
  it("cenário prod: T1 e T3/26 viram sem_dado; T2/26 é julgado", () => {
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
