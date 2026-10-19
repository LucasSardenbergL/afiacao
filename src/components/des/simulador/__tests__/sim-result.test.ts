import { describe, expect, it } from "vitest";
import { simResultDeJson } from "../sim-result";

describe("simResultDeJson (borda do Json da RPC simular_puxar_volume_trimestre)", () => {
  it("lê os blocos aninhados na forma de SimResult", () => {
    const r = simResultDeJson({
      posicao: { base: 100, com_extra: 150, mudou_faixa: true, faixa_atual: { faixa_numero: 2, estrelas: 1 } },
      perdas_pedido_atual: { total_rs: 12.5 },
      descontos: { delta_perc: 0.5 },
      saldo_liquido_rs: -3,
      recomendacao: "compensa",
      parametros: { p_valor_extra: 50 },
    });
    expect(r.posicao).toEqual({
      base: 100, com_extra: 150, nominal_adicional_na_nf: undefined, fator_inflacao: undefined, mudou_faixa: true,
      faixa_atual: { faixa_numero: 2, estrelas: 1 }, faixa_nova: undefined,
    });
    expect(r.perdas_pedido_atual?.total_rs).toBe(12.5);
    expect(r.descontos?.delta_perc).toBe(0.5);
    expect(r.saldo_liquido_rs).toBe(-3);
    expect(r.recomendacao).toBe("compensa");
    expect(r.parametros).toEqual({ p_valor_extra: 50 });
    expect(r.projecao).toBeUndefined();
  });

  it("campo com tipo errado vira undefined — número em texto não é coagido a 0", () => {
    const r = simResultDeJson({ saldo_liquido_rs: "10", posicao: [1] });
    expect(r.saldo_liquido_rs).toBeUndefined();
    expect(r.posicao).toBeUndefined();
  });

  it("retorno que não é objeto lança", () => {
    expect(() => simResultDeJson(null)).toThrow(/não é um objeto/);
    expect(() => simResultDeJson([])).toThrow(/não é um objeto/);
  });
});
