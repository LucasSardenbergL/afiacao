import { describe, expect, it } from "vitest";
import { CNAES_CONCORRENTES, montarPublicacao } from "./concorrentes";

describe("montarPublicacao — camada de concorrentes do mapa", () => {
  it("[C1] CNAEs são os de revenda de tinta e verniz conferidos no Cnaes.zip (não os de material de construção)", () => {
    expect([...CNAES_CONCORRENTES]).toEqual(["4679601", "4741500"]);
    expect(CNAES_CONCORRENTES).not.toContain("4679699");
    expect(CNAES_CONCORRENTES).not.toContain("4744005");
  });

  it("[C2] agrega por (município, CNAE) e o total é a soma do que vai na publicação", () => {
    const r = montarPublicacao([
      { mun: "8105", uf: "SC", cnae1: "4741500", n: 3 },
      { mun: "8105", uf: "SC", cnae1: "4741500", n: 2 }, // outro zip, mesmo município
      { mun: "8105", uf: "SC", cnae1: "4679601", n: 1 },
      { mun: "7107", uf: "SP", cnae1: "4741500", n: "4" }, // DuckDB pode serializar bigint como string
    ], CNAES_CONCORRENTES);
    expect(r.linhas).toEqual([
      { municipio_codigo: "7107", uf: "SP", cnae: "4741500", quantidade: 4 },
      { municipio_codigo: "8105", uf: "SC", cnae: "4679601", quantidade: 1 },
      { municipio_codigo: "8105", uf: "SC", cnae: "4741500", quantidade: 5 },
    ]);
    expect(r.estabelecimentos).toBe(10);
    expect(r.rejeitadas).toEqual({ municipio: 0, uf: 0, cnae: 0, quantidade: 0 });
  });

  it("[C3] rejeita e CONTA por motivo — nada vira zero nem some em silêncio", () => {
    const r = montarPublicacao([
      { mun: " ", uf: "SC", cnae1: "4741500", n: 1 },
      { mun: "8105", uf: "sc", cnae1: "4741500", n: 1 },
      { mun: "8105", uf: "SC", cnae1: "4744005", n: 1 },
      { mun: "8105", uf: "SC", cnae1: "4741500", n: 0 },
      { mun: "8105", uf: "SC", cnae1: "4741500", n: null },
      { mun: "8105", uf: "SC", cnae1: "4741500", n: 2 },
    ], CNAES_CONCORRENTES);
    expect(r.rejeitadas).toEqual({ municipio: 1, uf: 1, cnae: 1, quantidade: 2 });
    expect(r.linhas).toEqual([{ municipio_codigo: "8105", uf: "SC", cnae: "4741500", quantidade: 2 }]);
    expect(r.estabelecimentos).toBe(2);
  });

  it("[C4] recorte vazio dá total 0 (quem chama trata como defeito, não publica)", () => {
    expect(montarPublicacao([], CNAES_CONCORRENTES)).toEqual({
      linhas: [], estabelecimentos: 0, rejeitadas: { municipio: 0, uf: 0, cnae: 0, quantidade: 0 },
    });
  });
});
