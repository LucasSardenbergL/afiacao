import { describe, it, expect } from "vitest";
import { buildConsolidated } from "../consolidate";
import type { CapitalDeGiro } from "@/services/financeiroService";

function mk(o: Partial<CapitalDeGiro>): CapitalDeGiro {
  return {
    company: "x",
    total_cr_aberto: 0,
    total_cp_aberto: 0,
    saldo_cc: 0,
    capital_giro: 0,
    capital_giro_liquido: 0,
    pmr: 0,
    pmp: 0,
    ciclo_financeiro: 0,
    top5_cr_pct: 0,
    top5_cp_pct: 0,
    entradas_30d: 0,
    saidas_30d: 0,
    saldo_projetado_30d: 0,
    ...o,
  };
}

describe("buildConsolidated", () => {
  it("retorna null para lista vazia", () => {
    expect(buildConsolidated([])).toBeNull();
  });

  it("pondera PMR/PMP por volume e soma o resto", () => {
    const c = buildConsolidated([
      mk({ total_cr_aberto: 100, pmr: 10, total_cp_aberto: 50, pmp: 20, saldo_cc: 1000, capital_giro: 50 }),
      mk({ total_cr_aberto: 300, pmr: 30, total_cp_aberto: 150, pmp: 40, saldo_cc: 2000, capital_giro: 150 }),
    ])!;
    expect(c.company).toBe("consolidado");
    expect(c.total_cr_aberto).toBe(400);
    expect(c.total_cp_aberto).toBe(200);
    expect(c.pmr).toBe(25); // round((10*100 + 30*300)/400)
    expect(c.pmp).toBe(35); // round((20*50 + 40*150)/200)
    expect(c.ciclo_financeiro).toBe(-10);
    expect(c.saldo_cc).toBe(3000);
    expect(c.capital_giro).toBe(200);
    expect(c.top5_cr_pct).toBe(0); // concentração não consolida
  });

  it("PMR/PMP = 0 quando volume zero (evita divisão por zero)", () => {
    const c = buildConsolidated([mk({ total_cr_aberto: 0, pmr: 99, total_cp_aberto: 0, pmp: 99 })])!;
    expect(c.pmr).toBe(0);
    expect(c.pmp).toBe(0);
  });
});
