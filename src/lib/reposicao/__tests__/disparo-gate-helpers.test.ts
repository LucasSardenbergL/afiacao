import { describe, expect, it } from "vitest";
import {
  deveBloquearPorMinimoFaturamento,
  type GateConfig,
} from "../disparo-gate-helpers";

const cfg: GateConfig = { valorMinimo: 3000, fornecedorPattern: "%SAYERLACK%" };

const base = {
  fornecedor_nome: "SAYERLACK DO BRASIL LTDA",
  valor_total: 2000,
  split_parent_id: null,
  portal_protocolo: null,
  status_envio_portal: null,
};

describe("deveBloquearPorMinimoFaturamento", () => {
  it("barra pedido Sayerlack abaixo da régua, com motivo legível", () => {
    const r = deveBloquearPorMinimoFaturamento(base, cfg);
    expect(r.bloquear).toBe(true);
    expect(r.motivo).toContain("mínimo de faturamento");
    expect(r.motivo).toContain("3000");
  });

  it("passa pedido exatamente NA régua (>= passa)", () => {
    expect(
      deveBloquearPorMinimoFaturamento({ ...base, valor_total: 3000 }, cfg)
        .bloquear,
    ).toBe(false);
  });

  it("passa pedido acima da régua", () => {
    expect(
      deveBloquearPorMinimoFaturamento({ ...base, valor_total: 3500.5 }, cfg)
        .bloquear,
    ).toBe(false);
  });

  it("isenta filho de split (herda a aprovação do pai)", () => {
    expect(
      deveBloquearPorMinimoFaturamento({ ...base, split_parent_id: 99 }, cfg)
        .bloquear,
    ).toBe(false);
  });

  it("isenta fornecedor fora do pattern", () => {
    expect(
      deveBloquearPorMinimoFaturamento(
        { ...base, fornecedor_nome: "ACRE CAXIAS" },
        cfg,
      ).bloquear,
    ).toBe(false);
  });

  it("casa o pattern sem case-sensitivity", () => {
    expect(
      deveBloquearPorMinimoFaturamento(
        { ...base, fornecedor_nome: "Sayerlack do Brasil" },
        cfg,
      ).bloquear,
    ).toBe(true);
  });

  it("isenta pedido que já tocou o portal (protocolo)", () => {
    expect(
      deveBloquearPorMinimoFaturamento(
        { ...base, portal_protocolo: "2100743" },
        cfg,
      ).bloquear,
    ).toBe(false);
  });

  it.each([
    "sucesso_portal",
    "enviado_portal",
    "aceito_portal_sem_protocolo",
    "indeterminado_requer_conciliacao",
  ])("isenta status_envio_portal pós-envio: %s", (s) => {
    expect(
      deveBloquearPorMinimoFaturamento(
        { ...base, status_envio_portal: s },
        cfg,
      ).bloquear,
    ).toBe(false);
  });

  it.each(["pendente_envio_portal", "erro_retentavel", "falha_envio_portal"])(
    "NÃO isenta portal que não chegou ao fornecedor: %s",
    (s) => {
      expect(
        deveBloquearPorMinimoFaturamento(
          { ...base, status_envio_portal: s },
          cfg,
        ).bloquear,
      ).toBe(true);
    },
  );

  it("barra valor_total nulo/NaN (pedido Sayerlack sem valor não fatura)", () => {
    expect(
      deveBloquearPorMinimoFaturamento({ ...base, valor_total: null }, cfg)
        .bloquear,
    ).toBe(true);
  });

  it("gate desligado quando a régua está ausente/inválida", () => {
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: null,
        fornecedorPattern: "%SAYERLACK%",
      }).bloquear,
    ).toBe(false);
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: 0,
        fornecedorPattern: "%SAYERLACK%",
      }).bloquear,
    ).toBe(false);
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: Number.NaN,
        fornecedorPattern: "%SAYERLACK%",
      }).bloquear,
    ).toBe(false);
  });

  it("gate desligado quando o pattern está ausente/vazio (incl. só %)", () => {
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: 3000,
        fornecedorPattern: null,
      }).bloquear,
    ).toBe(false);
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: 3000,
        fornecedorPattern: "  ",
      }).bloquear,
    ).toBe(false);
    expect(
      deveBloquearPorMinimoFaturamento(base, {
        valorMinimo: 3000,
        fornecedorPattern: "%%",
      }).bloquear,
    ).toBe(false);
  });
});
