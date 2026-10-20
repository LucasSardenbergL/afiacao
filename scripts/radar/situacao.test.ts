import { describe, expect, it } from "vitest";
import {
  SITUACOES, SITUACOES_IRREGULARES, decisaoSituacao, mapaDeMotivos, normalizarCodigoMotivo, normalizarSituacao,
} from "./situacao";

const motivos = mapaDeMotivos([{ c: "00", d: "SEM MOTIVO" }, { c: "1", d: " EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA " }, { c: "63", d: "OMISSAO DE DECLARACOES" }, { c: "", d: "lixo" }]);

describe("vocabulário RFB", () => {
  it("5 situações, 3 irregulares (03 suspensa, 04 inapta, 08 baixada); 02 ativa não é irregular", () => {
    expect([...SITUACOES].sort()).toEqual(["01", "02", "03", "04", "08"]);
    expect([...SITUACOES_IRREGULARES].sort()).toEqual(["03", "04", "08"]);
    expect(SITUACOES_IRREGULARES.has("02")).toBe(false);
  });
  it("catálogo de motivos normaliza o código (1 → 01) e ignora linha sem código", () => {
    expect([...motivos.keys()].sort()).toEqual(["00", "01", "63"]);
    expect(motivos.get("01")).toBe("EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA");
    expect(normalizarCodigoMotivo(" 7 ")).toBe("07");
    expect(normalizarCodigoMotivo("")).toBeNull();
    expect(normalizarCodigoMotivo("x1")).toBeNull();
  });
});

describe("normalizarSituacao (linha do dump → chunk_situacao)", () => {
  it("monta o CNPJ (DV validado, alfanumérico aceito), data ISO e motivo com descrição", () => {
    expect(normalizarSituacao({ b: "12ABC345", o: "01DE", dv: "35", situacao: "08", dt_sit: "20260315", motivo: "1" }, motivos)).toEqual({
      ok: true,
      linha: { cnpj: "12ABC34501DE35", situacao: "08", data_situacao: "2026-03-15", motivo_codigo: "01", motivo_descricao: "EXTINCAO POR ENCERRAMENTO LIQUIDACAO VOLUNTARIA" },
    });
    expect(normalizarSituacao({ b: "1", o: "1", dv: "36", situacao: "02", dt_sit: "00000000", motivo: "00" }, motivos)).toEqual({
      ok: true, linha: { cnpj: "00000001000136", situacao: "02", data_situacao: null, motivo_codigo: "00", motivo_descricao: "SEM MOTIVO" },
    });
  });
  it("ausente ≠ zero: código fora do catálogo fica com descrição null; motivo vazio fica null", () => {
    expect(normalizarSituacao({ b: "11111111", o: "0001", dv: "91", situacao: "04", dt_sit: "20251231", motivo: "99" }, motivos)).toMatchObject({
      ok: true, linha: { motivo_codigo: "99", motivo_descricao: null },
    });
    expect(normalizarSituacao({ b: "11111111", o: "0001", dv: "91", situacao: "04", dt_sit: "", motivo: "" }, motivos)).toMatchObject({
      ok: true, linha: { motivo_codigo: null, motivo_descricao: null, data_situacao: null },
    });
  });
  it("rejeita por motivo: CNPJ com DV errado ou minúscula; situação fora do vocabulário", () => {
    expect(normalizarSituacao({ b: "12ABC345", o: "01DE", dv: "36", situacao: "08" }, motivos)).toEqual({ ok: false, motivo: "cnpj" });
    expect(normalizarSituacao({ b: "12abc345", o: "01DE", dv: "35", situacao: "08" }, motivos)).toEqual({ ok: false, motivo: "cnpj" });
    expect(normalizarSituacao({ b: "11111111", o: "0001", dv: "91", situacao: "05" }, motivos)).toEqual({ ok: false, motivo: "situacao" });
    expect(normalizarSituacao({}, motivos)).toEqual({ ok: false, motivo: "cnpj" });
  });
});

describe("decisaoSituacao (espelho legível de radar_aplicar_situacao)", () => {
  it("lead na fila com 03/04/08 → descartar; já descartado/virou_cliente → nada", () => {
    expect(decisaoSituacao({ situacao: "08", cliente: false, prospeccao_status: "a_contatar" })).toBe("descartar");
    expect(decisaoSituacao({ situacao: "03", cliente: false, prospeccao_status: "em_conversa" })).toBe("descartar");
    expect(decisaoSituacao({ situacao: "04", cliente: false, prospeccao_status: "descartado" })).toBe("nada");
    expect(decisaoSituacao({ situacao: "08", cliente: false, prospeccao_status: "virou_cliente" })).toBe("nada");
  });
  it("cliente (flag ou documento) com 03/04/08 → alertar, nunca descartar — inclusive fora do radar", () => {
    expect(decisaoSituacao({ situacao: "08", cliente: true, prospeccao_status: "a_contatar" })).toBe("alertar");
    expect(decisaoSituacao({ situacao: "04", cliente: true, prospeccao_status: null })).toBe("alertar");
  });
  it("situação 02/01 não faz nada; lote mais velho que a foto conhecida não faz nada; não-cliente fora do radar não faz nada", () => {
    expect(decisaoSituacao({ situacao: "02", cliente: true, prospeccao_status: "a_contatar" })).toBe("nada");
    expect(decisaoSituacao({ situacao: "01", cliente: false, prospeccao_status: "a_contatar" })).toBe("nada");
    expect(decisaoSituacao({ situacao: "08", cliente: false, prospeccao_status: "a_contatar", vigente: false })).toBe("nada");
    expect(decisaoSituacao({ situacao: "08", cliente: false, prospeccao_status: null })).toBe("nada");
  });
});
