import { describe, it, expect } from "vitest";
import { classificarCobertura, diferencaCobertura, type SubClasse } from "../onorder-probe-analise";

// hoje fixo p/ determinismo; datas em ISO yyyy-mm-dd. Janela [hoje-365, hoje+120].
const HOJE = "2026-06-26";

describe("classificarCobertura", () => {
  it("previsão dentro da janela → dentro_janela", () => {
    expect(classificarCobertura("2026-07-10", HOJE, 365, 120)).toBe<SubClasse>("dentro_janela");
    expect(classificarCobertura("2026-06-26", HOJE, 365, 120)).toBe<SubClasse>("dentro_janela"); // limite hoje
    expect(classificarCobertura("2025-06-26", HOJE, 365, 120)).toBe<SubClasse>("dentro_janela"); // limite -365
  });
  it("previsão nula → previsao_nula (escapa)", () => {
    expect(classificarCobertura(null, HOJE, 365, 120)).toBe<SubClasse>("previsao_nula");
  });
  it("previsão futura além de +120d → futura_alem_janela (escapa)", () => {
    expect(classificarCobertura("2026-10-25", HOJE, 365, 120)).toBe<SubClasse>("futura_alem_janela"); // +121d
  });
  it("previsão atrasada além de -365d → atrasada_alem_janela (escapa)", () => {
    expect(classificarCobertura("2025-06-25", HOJE, 365, 120)).toBe<SubClasse>("atrasada_alem_janela"); // -366d
  });
  it("data malformada → previsao_nula (fail-safe: tratamos como invisível)", () => {
    expect(classificarCobertura("lixo", HOJE, 365, 120)).toBe<SubClasse>("previsao_nula");
  });
});

describe("diferencaCobertura", () => {
  it("lista POs do conjunto independente AUSENTES da janela, com sub-classe e soma de unidades", () => {
    // janela vê só a PO 'A' (dentro). O canal independente conhece A, B (nula), C (futura+121d).
    const vistosJanela = new Set<string>(["A"]);
    const independente = new Map<string, { previsao: string | null; saldo: number }>([
      ["A", { previsao: "2026-07-01", saldo: 5 }],
      ["B", { previsao: null, saldo: 3 }],
      ["C", { previsao: "2026-10-25", saldo: 2 }],
    ]);
    const r = diferencaCobertura(vistosJanela, independente, HOJE, 365, 120);
    expect(r.escapam.map((e) => e.nCodPed).sort()).toEqual(["B", "C"]);
    expect(r.totalUnidadesEscapam).toBe(5); // 3 (B) + 2 (C)
    expect(r.porSubClasse.previsao_nula).toBe(1);
    expect(r.porSubClasse.futura_alem_janela).toBe(1);
  });
  it("conjunto independente ⊆ janela → nada escapa", () => {
    const r = diferencaCobertura(new Set(["A", "B"]),
      new Map([["A", { previsao: "2026-07-01", saldo: 1 }], ["B", { previsao: "2026-07-02", saldo: 1 }]]),
      HOJE, 365, 120);
    expect(r.escapam).toHaveLength(0);
    expect(r.totalUnidadesEscapam).toBe(0);
  });
});
