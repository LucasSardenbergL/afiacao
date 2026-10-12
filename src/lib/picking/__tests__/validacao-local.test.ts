import { describe, expect, it } from "vitest";
import { type CodigoCadastrado, type LinhaLocal, preverBipe, preverManual } from "../validacao-local";

function linha(p: Partial<LinhaLocal> & { id: string }): LinhaLocal {
  return {
    codigo_item: 1,
    omie_codigo_produto: 100,
    unidade: "UN",
    ean: "789",
    quantidade: 2,
    fracionaria: false,
    ativa: true,
    separada: 0,
    ...p,
  };
}

function cad(p: Partial<CodigoCadastrado> = {}): CodigoCadastrado {
  return { codigo: "CX6", omie_codigo_produto: 100, unidade: "UN", unidades_por_leitura: 1, status: "aprovado", ...p };
}

describe("preverBipe — espelho de picking_registrar_leitura", () => {
  it("EAN da linha aceita 1 unidade na 1ª linha com saldo, por codigo_item", () => {
    const ls = [linha({ id: "b", codigo_item: 2 }), linha({ id: "a", codigo_item: 1, separada: 2 })];
    expect(preverBipe("789", ls, null)).toEqual({ ok: true, linha_id: "b", unidades: 1 });
  });

  it("código cadastrado pendente → codigo_pendente_aprovacao (antes de tudo)", () => {
    expect(preverBipe("CX6", [linha({ id: "a" })], cad({ status: "pendente" }))).toMatchObject({ motivo: "codigo_pendente_aprovacao" });
  });

  it("código cadastrado que também é EAN de linha com outro fator → codigo_ambiguo", () => {
    expect(preverBipe("789", [linha({ id: "a" })], cad({ codigo: "789", unidades_por_leitura: 6 }))).toMatchObject({ motivo: "codigo_ambiguo" });
  });

  it("código que ninguém conhece → codigo_desconhecido", () => {
    expect(preverBipe("000", [linha({ id: "a" })], null)).toMatchObject({ motivo: "codigo_desconhecido" });
  });

  it("mesmo EAN em UN e CX do mesmo produto → codigo_ambiguo", () => {
    const ls = [linha({ id: "a" }), linha({ id: "b", codigo_item: 2, unidade: "CX" })];
    expect(preverBipe("789", ls, null)).toMatchObject({ motivo: "codigo_ambiguo" });
  });

  it("cadastro de produto que não está no pedido → codigo_fora_do_pedido", () => {
    expect(preverBipe("CX6", [linha({ id: "a" })], cad({ omie_codigo_produto: 999 }))).toMatchObject({ motivo: "codigo_fora_do_pedido" });
  });

  it("cadastro do produto em outra unidade → unidade_incompativel", () => {
    expect(preverBipe("CX6", [linha({ id: "a" })], cad({ unidade: "CX" }))).toMatchObject({ motivo: "unidade_incompativel" });
  });

  it("só linha fracionária casa → linha_fracionaria_exige_manual", () => {
    expect(preverBipe("789", [linha({ id: "a", fracionaria: true })], null)).toMatchObject({ motivo: "linha_fracionaria_exige_manual" });
  });

  it("sem saldo → excesso; fator maior que o saldo → excesso na linha", () => {
    expect(preverBipe("789", [linha({ id: "a", separada: 2 })], null)).toMatchObject({ motivo: "excesso", linha_id: null });
    expect(preverBipe("CX6", [linha({ id: "a", ean: null, quantidade: 4 })], cad({ unidades_por_leitura: 6 }))).toMatchObject({
      motivo: "excesso",
      linha_id: "a",
    });
  });

  it("cadastro com fator conta o fator", () => {
    expect(preverBipe("CX6", [linha({ id: "a", ean: null, quantidade: 12 })], cad({ unidades_por_leitura: 6 }))).toEqual({
      ok: true,
      linha_id: "a",
      unidades: 6,
    });
  });

  it("linha inativa não conta para nada", () => {
    expect(preverBipe("789", [linha({ id: "a", ativa: false })], null)).toMatchObject({ motivo: "codigo_desconhecido" });
  });
});

describe("preverManual", () => {
  it("linha inativa → linha_inativa", () => {
    expect(preverManual(linha({ id: "a", ativa: false }), 1, [])).toMatchObject({ motivo: "linha_inativa" });
  });
  it("linha inteira com EAN → manual_nao_permitido", () => {
    expect(preverManual(linha({ id: "a" }), 1, [])).toMatchObject({ motivo: "manual_nao_permitido" });
  });
  it("linha inteira com código aprovado na mesma unidade → manual_nao_permitido; em outra unidade, permitido", () => {
    expect(preverManual(linha({ id: "a", ean: null }), 1, [cad()])).toMatchObject({ motivo: "manual_nao_permitido" });
    expect(preverManual(linha({ id: "a", ean: null }), 1, [cad({ unidade: "CX" })])).toEqual({ ok: true, linha_id: "a", unidades: 1 });
  });
  it("linha inteira sem código com quantidade quebrada → quantidade_nao_inteira", () => {
    expect(preverManual(linha({ id: "a", ean: null }), 1.5, [])).toMatchObject({ motivo: "quantidade_nao_inteira" });
  });
  it("fracionária aceita decimal até o saldo; acima → excesso", () => {
    const l = linha({ id: "a", fracionaria: true, quantidade: 2.5, separada: 1 });
    expect(preverManual(l, 1.5, [])).toEqual({ ok: true, linha_id: "a", unidades: 1.5 });
    expect(preverManual(l, 1.6, [])).toMatchObject({ motivo: "excesso" });
  });
});
