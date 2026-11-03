import { describe, it, expect } from "vitest";
import { formatPrecoOuAusente } from "@/lib/format";
import { diferencaConciliacao } from "../conciliacao-diferenca";

describe("diferencaConciliacao — a coluna gerada faz COALESCE(…, 0)", () => {
  it("sem título (sem match) → null, não o valor cheio do movimento", () => {
    expect(diferencaConciliacao({ mov_valor: 100, titulo_valor: null, diferenca: 100 })).toBeNull();
  });
  it("sem os dois operandos → null, não R$ 0,00 'conciliado'", () => {
    expect(diferencaConciliacao({ mov_valor: null, titulo_valor: null, diferenca: 0 })).toBeNull();
  });
  it("zero REAL com os dois presentes → 0", () => {
    expect(diferencaConciliacao({ mov_valor: 100, titulo_valor: 100, diferenca: 0 })).toBe(0);
  });
  it("na tela: ausente → '—'; zero real → R$ 0,00", () => {
    expect(formatPrecoOuAusente(diferencaConciliacao({ mov_valor: null, titulo_valor: 5, diferenca: -5 }))).toBe("—");
    expect(
      formatPrecoOuAusente(diferencaConciliacao({ mov_valor: 0, titulo_valor: 0, diferenca: 0 })).replace(/\s/g, " "),
    ).toBe("R$ 0,00");
  });
});
