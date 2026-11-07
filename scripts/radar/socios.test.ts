import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { digestSocios, emChunks, NOME_DE, NOME_PARA, nomeNorm, type LinhaSocio } from "./socios";

const MIG = readFileSync("supabase/migrations/20261107040000_radar_socios_cpf_mascarado.sql", "utf-8");

describe("radar_socios — a carga normaliza como o banco", () => {
  it("os mapas de acento são os de private.radar_nome_norm (a regra casa QSA × titular de MEI)", () => {
    const m = MIG.match(/translate\(p,\s*'([^']+)',\s*'([^']+)'\)/);
    expect(m, "translate() de radar_nome_norm não achado na migration").not.toBeNull();
    expect([m![1], m![2]]).toEqual([NOME_DE, NOME_PARA]);
    expect([...NOME_DE].length).toBe([...NOME_PARA].length);
  });

  it('TODO translate() da migration (helper, ramo MEI da base, índice) usa o mesmo mapa', () => {
    const pares = [...MIG.matchAll(/translate\([^;]*?,\s*'([^']+)',\s*'([^']+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(pares.length).toBeGreaterThanOrEqual(3);
    for (const par of pares) expect(par).toEqual([NOME_DE, NOME_PARA]);
  });

  it("nomeNorm: tira acento, sobe a caixa, colapsa espaço; vazio = null", () => {
    expect(nomeNorm("  João   da Conceição ")).toBe("JOAO DA CONCEICAO");
    expect(nomeNorm("MARIA SOUZA LIMA")).toBe("MARIA SOUZA LIMA");
    expect(nomeNorm("   ")).toBeNull();
  });
});

describe("radar_socios — manifesto", () => {
  const l = (over: Partial<LinhaSocio> = {}): LinhaSocio => ({
    raiz: "31000001", nome_normalizado: "MARIA SOUZA LIMA", cpf_mascarado: "***111111**", qualificacao: "49",
    data_entrada: null, n_raizes_pais: 2, ...over,
  });
  it("digest é do conteúdo: mesma lista → mesmo digest; qualquer campo mudado → outro", () => {
    expect(digestSocios([l()])).toMatch(/^[0-9a-f]{64}$/);
    expect(digestSocios([l()])).toBe(digestSocios([l()]));
    expect(digestSocios([l({ n_raizes_pais: 3 })])).not.toBe(digestSocios([l()]));
    expect(digestSocios([l({ data_entrada: "2026-01-10" })])).not.toBe(digestSocios([l()]));
  });
  it("emChunks fatia sem perder nem repetir; tamanho inválido lança com a marca", () => {
    expect(emChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(emChunks([], 5)).toEqual([]);
    expect(() => emChunks([1], 0)).toThrow(/emChunks: tamanho inválido/);
  });
});
