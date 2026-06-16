import { describe, it, expect } from "vitest";
import { computeStressRow, SCENARIOS } from "../stress";

const inputs = { saldoCC: 1000, entradas30: 500, saidas30: 300, pmr: 30 };

describe("posicaoAgora/stress", () => {
  it("SCENARIOS tem 6 cenários", () => {
    expect(SCENARIOS).toHaveLength(6);
  });

  it("base: sem ajuste, impacto zero, risco Baixo", () => {
    const r = computeStressRow({ label: "Base", delayDays: 0, defaultPct: 0, desc: "" }, inputs);
    expect(r.entradasAjust).toBe(500);
    expect(r.saldo).toBe(1200);
    expect(r.impacto).toBe(0);
    expect(r.risco).toBe("Baixo");
  });

  it("inadimplência reduz entradas e gera impacto negativo", () => {
    const r = computeStressRow({ label: "", delayDays: 0, defaultPct: 10, desc: "" }, inputs);
    expect(r.entradasAjust).toBeCloseTo(450);
    expect(r.impacto).toBeCloseTo(-50);
  });

  it("atraso aplica pctDelayed", () => {
    // pctDelayed = min(15 / (30+15), 0.8) = 0.3333; entradasAjust = 500*(1-0.3333) ≈ 333.3
    const r = computeStressRow({ label: "", delayDays: 15, defaultPct: 0, desc: "" }, inputs);
    expect(r.entradasAjust).toBeCloseTo(333.33, 1);
  });

  it("saldo negativo classifica como Crítico", () => {
    const r = computeStressRow(
      { label: "", delayDays: 0, defaultPct: 0, desc: "" },
      { saldoCC: 100, entradas30: 100, saidas30: 300, pmr: 30 },
    );
    expect(r.saldo).toBe(-100);
    expect(r.risco).toBe("Crítico");
  });
});
