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

  it("PMR/PMP = null quando volume zero (sem base pra ponderar)", () => {
    const c = buildConsolidated([mk({ total_cr_aberto: 0, pmr: 99, total_cp_aberto: 0, pmp: 99 })])!;
    expect(c.pmr).toBeNull();
    expect(c.pmp).toBeNull();
    expect(c.ciclo_financeiro).toBeNull();
  });

  it("PMR/PMP = null quando nenhuma empresa tem prazo (degradação honesta, não 0 falso)", () => {
    const c = buildConsolidated([
      mk({ total_cr_aberto: 100, pmr: null, total_cp_aberto: 50, pmp: null }),
      mk({ total_cr_aberto: 300, pmr: null, total_cp_aberto: 150, pmp: null }),
    ])!;
    expect(c.pmr).toBeNull();
    expect(c.pmp).toBeNull();
    expect(c.ciclo_financeiro).toBeNull();
    expect(c.total_cr_aberto).toBe(400); // o resto continua somando
  });

  it("pondera só as empresas COM prazo, ignorando as null", () => {
    const c = buildConsolidated([
      mk({ total_cr_aberto: 100, pmr: 10, total_cp_aberto: 50, pmp: 20 }),
      mk({ total_cr_aberto: 300, pmr: null, total_cp_aberto: 150, pmp: null }), // sem dado → não dilui
    ])!;
    expect(c.pmr).toBe(10); // só a 1ª empresa pondera (a 2ª é null)
    expect(c.pmp).toBe(20);
    expect(c.ciclo_financeiro).toBe(-10);
  });
});
