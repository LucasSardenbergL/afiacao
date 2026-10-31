import { describe, it, expect } from "vitest";
import { tipoLabel, fmt, PAGE_SIZE, idadeDias, podeAceitarEmLote, tiposDaVisao } from "../types";

describe("tipoLabel", () => {
  it("mapeia os tipos conhecidos e faz passthrough do desconhecido", () => {
    expect(tipoLabel("venda_atipica")).toBe("Venda atípica");
    expect(tipoLabel("lt_atipico")).toBe("LT atípico");
    expect(tipoLabel("sku_sem_grupo")).toBe("SKU sem grupo");
    expect(tipoLabel("sku_inativado_omie")).toBe("Inativado no Omie");
    expect(tipoLabel("sku_reativado_omie")).toBe("Reativado no Omie");
    expect(tipoLabel("outro")).toBe("outro");
  });
});

describe("fmt", () => {
  it("formata número com casas decimais e usa — para null/undefined", () => {
    expect(fmt(null)).toBe("—");
    expect(fmt(undefined)).toBe("—");
    expect(fmt(1234.5, 1)).toBe("1.234,5");
    expect(fmt(10, 0)).toBe("10");
  });
});

describe("PAGE_SIZE", () => {
  it("é 25", () => {
    expect(PAGE_SIZE).toBe(25);
  });
});

describe("idadeDias", () => {
  const agora = new Date("2026-10-31T12:00:00Z");
  it("dias inteiros desde a detecção", () => {
    expect(idadeDias("2026-05-14T09:00:00Z", agora)).toBe(170);
    expect(idadeDias("2026-10-31T11:00:00Z", agora)).toBe(0);
  });
  it("sem data ou data inválida → null (não '0 dias')", () => {
    expect(idadeDias(null, agora)).toBeNull();
    expect(idadeDias("lixo", agora)).toBeNull();
  });
  it("relógio adiantado no servidor não vira idade negativa", () => {
    expect(idadeDias("2026-11-01T12:00:00Z", agora)).toBe(0);
  });
});

describe("tiposDaVisao", () => {
  it("fila = o que muda dado do motor; registro = venda e Omie; sem sobreposição", () => {
    expect(tiposDaVisao("fila")).toEqual(["sku_sem_grupo", "lt_atipico"]);
    expect(tiposDaVisao("registro")).toEqual(["venda_atipica", "sku_inativado_omie", "sku_reativado_omie"]);
    expect(tiposDaVisao("fila").some((t) => tiposDaVisao("registro").includes(t))).toBe(false);
  });
});

describe("podeAceitarEmLote", () => {
  const base = { status: "pendente", severidade: "info", tipo: "venda_atipica" };
  it("pendente não crítico de venda/LT/inativado → sim", () => {
    expect(podeAceitarEmLote(base)).toBe(true);
    expect(podeAceitarEmLote({ ...base, tipo: "lt_atipico" })).toBe(true);
    expect(podeAceitarEmLote({ ...base, tipo: "sku_inativado_omie" })).toBe(true);
  });
  it("crítico, já decidido, sem grupo e reativado (decisão própria) → não", () => {
    expect(podeAceitarEmLote({ ...base, severidade: "critico" })).toBe(false);
    expect(podeAceitarEmLote({ ...base, status: "aceito" })).toBe(false);
    expect(podeAceitarEmLote({ ...base, tipo: "sku_sem_grupo" })).toBe(false);
    expect(podeAceitarEmLote({ ...base, tipo: "sku_reativado_omie" })).toBe(false);
  });
});
