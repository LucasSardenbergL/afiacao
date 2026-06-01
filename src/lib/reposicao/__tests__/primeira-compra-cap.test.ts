import { describe, it, expect } from "vitest";
import { capDiasPorClasse, calcularParametrosPrimeiraCompra } from "../primeira-compra-cap";

describe("capDiasPorClasse", () => {
  it("A=30, B=21, C=14, default 14", () => {
    expect(capDiasPorClasse("A")).toBe(30);
    expect(capDiasPorClasse("B")).toBe(21);
    expect(capDiasPorClasse("C")).toBe(14);
    expect(capDiasPorClasse(null)).toBe(14);
    expect(capDiasPorClasse("Z")).toBe(14);
  });
});

describe("calcularParametrosPrimeiraCompra", () => {
  it("capa lote E ponto pela cobertura; max = ponto + lote", () => {
    // d=2, B(21)→cap_cob=42; lt=8→dem_lt=16; qcEoq=100
    const r = calcularParametrosPrimeiraCompra({ qcEoq: 100, demandaDiaria: 2, leadTime: 8, classe: "B" });
    expect(r.lote).toBe(42);
    expect(r.pontoPedido).toBe(16);
    expect(r.estoqueMaximo).toBe(58);
    expect(r.capDias).toBe(21);
  });

  it("usa qc_eoq quando menor que a cobertura", () => {
    // d=2, A(30)→cap_cob=60; lt=5→dem_lt=10; qcEoq=10
    const r = calcularParametrosPrimeiraCompra({ qcEoq: 10, demandaDiaria: 2, leadTime: 5, classe: "A" });
    expect(r.lote).toBe(10);
    expect(r.pontoPedido).toBe(10);
    expect(r.estoqueMaximo).toBe(20);
  });

  it("LT longo: ponto é capado pela cobertura (não estoura)", () => {
    // d=1, C(14)→cap_cob=14; lt=20→dem_lt=20 → ponto = min(20,14)=14
    const r = calcularParametrosPrimeiraCompra({ qcEoq: 50, demandaDiaria: 1, leadTime: 20, classe: "C" });
    expect(r.lote).toBe(14);
    expect(r.pontoPedido).toBe(14);
    expect(r.estoqueMaximo).toBe(28);
  });

  it("d=0 → pisos de 1; max sempre > ponto", () => {
    const r = calcularParametrosPrimeiraCompra({ qcEoq: 1, demandaDiaria: 0, leadTime: 0, classe: "C" });
    expect(r.lote).toBe(1);
    expect(r.pontoPedido).toBe(1);
    expect(r.estoqueMaximo).toBe(2);
  });

  it("demanda fracionária pequena ainda gera lote >= 1", () => {
    // d=0.05, C(14)→cap_cob=ceil(0.7)=1; lt=8→dem_lt=ceil(0.4)=1
    const r = calcularParametrosPrimeiraCompra({ qcEoq: 5, demandaDiaria: 0.05, leadTime: 8, classe: "C" });
    expect(r.lote).toBe(1);
    expect(r.pontoPedido).toBe(1);
    expect(r.estoqueMaximo).toBe(2);
  });
});
