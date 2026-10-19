import { describe, expect, it } from "vitest";
import { faixaDeJson } from "../faixa-json";

describe("faixaDeJson (borda do jsonb de faixa da v_des_posicao_trimestre_ao_vivo)", () => {
  it("lê a forma que a prod devolve", () => {
    expect(
      faixaDeJson({ faixa_id: 5, faixa_numero: 5, estrelas: 2, desconto_padrao_perc: 3.94, volume_min: 102266, volume_max: 204425 }),
    ).toEqual({ faixa_id: 5, faixa_numero: 5, estrelas: 2, desconto_padrao_perc: 3.94, volume_min: 102266, volume_max: 204425 });
  });

  it("sem faixa (NULL da view) ou jsonb que não é objeto → null, não 0", () => {
    expect(faixaDeJson(null)).toBeNull();
    expect(faixaDeJson(undefined)).toBeNull();
    expect(faixaDeJson([5])).toBeNull();
    expect(faixaDeJson("5")).toBeNull();
  });

  it("campo fora da forma vira null — número em texto NÃO é coagido", () => {
    expect(faixaDeJson({ faixa_numero: "5", estrelas: null })).toMatchObject({ faixa_numero: null, estrelas: null, volume_max: null });
  });
});
