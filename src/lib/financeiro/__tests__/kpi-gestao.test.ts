import { describe, it, expect } from "vitest";
import {
  estadoDoKpi,
  formatarKpiBRL,
  formatarKpiPct,
  inadimplenciaPct,
  type AgingReceberValores,
} from "../kpi-gestao";

const linha = (p: Partial<AgingReceberValores> = {}): AgingReceberValores => ({
  a_vencer_valor: 900,
  vencido_1_30_valor: 50,
  vencido_31_60_valor: 30,
  vencido_61_90_valor: 15,
  vencido_90_plus_valor: 5,
  ...p,
});

describe("inadimplenciaPct — ausente ≠ zero", () => {
  it("calcula vencido / (vencido + a vencer)", () => {
    expect(inadimplenciaPct(linha())).toBeCloseTo(10, 10);
  });

  it("zero REAL: nada vencido com carteira aberta → 0 (não null)", () => {
    const r = inadimplenciaPct(
      linha({ vencido_1_30_valor: 0, vencido_31_60_valor: 0, vencido_61_90_valor: 0, vencido_90_plus_valor: 0 }),
    );
    expect(r).toBe(0);
  });

  it("sem linha para a empresa → null", () => {
    expect(inadimplenciaPct(null)).toBeNull();
    expect(inadimplenciaPct(undefined)).toBeNull();
  });

  it("faixa ausente → null (não soma 0 no lugar)", () => {
    expect(inadimplenciaPct(linha({ vencido_31_60_valor: null }))).toBeNull();
    expect(inadimplenciaPct(linha({ a_vencer_valor: null }))).toBeNull();
  });

  it("carteira zerada → null (0/0 não é 0%)", () => {
    expect(
      inadimplenciaPct({
        a_vencer_valor: 0,
        vencido_1_30_valor: 0,
        vencido_31_60_valor: 0,
        vencido_61_90_valor: 0,
        vencido_90_plus_valor: 0,
      }),
    ).toBeNull();
  });
});

describe("estadoDoKpi", () => {
  it("erro vence o data velho do refetch", () => {
    expect(estadoDoKpi({ isPending: false, isError: true, data: 12 })).toEqual({ tipo: "erro" });
  });
  it("carregando", () => {
    expect(estadoDoKpi({ isPending: true, isError: false, data: undefined })).toEqual({ tipo: "carregando" });
  });
  it("sucesso com null → ausente", () => {
    expect(estadoDoKpi({ isPending: false, isError: false, data: null })).toEqual({ tipo: "ausente" });
  });
  it("sucesso com 0 → ok 0 (zero observado)", () => {
    expect(estadoDoKpi({ isPending: false, isError: false, data: 0 })).toEqual({ tipo: "ok", valor: 0 });
  });
});

describe("formatadores (pt-BR explícito, independente do locale do processo)", () => {
  it("percentual com vírgula decimal", () => {
    expect(formatarKpiPct(0)).toBe("0,0%");
    expect(formatarKpiPct(12.345)).toBe("12,3%");
  });
  it("moeda", () => {
    expect(formatarKpiBRL(1234.5).replace(/\s/g, " ")).toBe("R$ 1.234,50");
  });
});
