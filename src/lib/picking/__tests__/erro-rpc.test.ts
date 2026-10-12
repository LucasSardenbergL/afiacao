import { describe, expect, it } from "vitest";
import { classificarErro } from "../erro-rpc";

describe("classificarErro (fila de leituras)", () => {
  it("SQLSTATE de comando inválido/sem permissão/inexistente é permanente", () => {
    for (const code of ["22023", "42501", "P0002"]) {
      expect(classificarErro({ message: "x", code })).toEqual({ tipo: "permanente", erro: `${code}: x` });
    }
  });
  it("falha de rede, timeout, lock e JWT vencido são transitórios (a fila tenta de novo)", () => {
    expect(classificarErro(new TypeError("Failed to fetch")).tipo).toBe("transitorio");
    for (const code of ["57014", "55P03", "40001", "PGRST301"]) expect(classificarErro({ message: "x", code }).tipo).toBe("transitorio");
  });
  it("erro sem código conhecido é transitório (não marca falhou à toa)", () => {
    expect(classificarErro({ message: "erro estranho" })).toEqual({ tipo: "transitorio", erro: "erro estranho" });
  });
});
