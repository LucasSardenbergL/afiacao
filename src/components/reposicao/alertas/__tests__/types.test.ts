import { describe, it, expect } from "vitest";
import { tipoLabel, fmt, PAGE_SIZE } from "../types";

describe("tipoLabel", () => {
  it("mapeia os tipos conhecidos e faz passthrough do desconhecido", () => {
    expect(tipoLabel("venda_atipica")).toBe("Venda atípica");
    expect(tipoLabel("lt_atipico")).toBe("LT atípico");
    expect(tipoLabel("sku_sem_grupo")).toBe("SKU sem grupo");
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
