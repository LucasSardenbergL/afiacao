import { describe, it, expect } from "vitest";
import { descricaoDoSku, skusDaLeitura, type ProdutoOmie } from "../descricaoSku";

// A descrição do SKU Omie de um item de promoção é LIDA do catálogo (sku_codigo_omie), nunca
// copiada para descricao_produto_fornecedor. Como é leitura, a tela precisa separar "não há" de
// "não consegui": "fora do catálogo" só depois de uma leitura bem-sucedida.

const THINNER_LT: ProdutoOmie = { omie_codigo_produto: 8689717792, descricao: "THINNER DR.4403LT", codigo: "PRD00411" };
const SEM_TEXTO: ProdutoOmie = { omie_codigo_produto: 8689744102, descricao: "", codigo: "PRD00412" };

describe("descricaoDoSku", () => {
  it("item sem SKU vinculado não depende da leitura", () => {
    expect(descricaoDoSku({ status: "error", fetchStatus: "idle", data: undefined }, null)).toStrictEqual({ estado: "sem_sku" });
  });

  it("1ª leitura em voo: carregando", () => {
    expect(descricaoDoSku({ status: "pending", fetchStatus: "fetching", data: undefined }, 8689717792)).toStrictEqual({
      estado: "carregando",
    });
  });

  it("1ª leitura falhou: indisponível por erro — nunca 'fora do catálogo'", () => {
    expect(descricaoDoSku({ status: "error", fetchStatus: "idle", data: undefined }, 8689717792)).toStrictEqual({
      estado: "indisponivel",
      motivo: "erro",
    });
  });

  it("sem rede (pending + paused): indisponível por falta de conexão", () => {
    expect(descricaoDoSku({ status: "pending", fetchStatus: "paused", data: undefined }, 8689717792)).toStrictEqual({
      estado: "indisponivel",
      motivo: "sem-rede",
    });
  });

  it("leitura boa com a linha: a descrição e o código do catálogo", () => {
    expect(descricaoDoSku({ status: "success", fetchStatus: "idle", data: [THINNER_LT] }, 8689717792)).toStrictEqual({
      estado: "ok",
      descricao: "THINNER DR.4403LT",
      codigo: "PRD00411",
      desatualizada: null,
    });
  });

  it("leitura boa SEM a linha: fora do catálogo da conta", () => {
    expect(descricaoDoSku({ status: "success", fetchStatus: "idle", data: [THINNER_LT] }, 12025181714)).toStrictEqual({
      estado: "fora_do_catalogo",
      desatualizada: null,
    });
  });

  it("linha achada com descrição vazia NÃO é fora do catálogo", () => {
    expect(descricaoDoSku({ status: "success", fetchStatus: "idle", data: [SEM_TEXTO] }, 8689744102)).toStrictEqual({
      estado: "ok",
      descricao: "",
      codigo: "PRD00412",
      desatualizada: null,
    });
  });

  it("refetch falhou com dado em mãos: mostra o dado E avisa que está desatualizado", () => {
    expect(descricaoDoSku({ status: "error", fetchStatus: "idle", data: [THINNER_LT] }, 8689717792)).toStrictEqual({
      estado: "ok",
      descricao: "THINNER DR.4403LT",
      codigo: "PRD00411",
      desatualizada: "erro",
    });
    expect(descricaoDoSku({ status: "error", fetchStatus: "idle", data: [THINNER_LT] }, 12025181714)).toStrictEqual({
      estado: "fora_do_catalogo",
      desatualizada: "erro",
    });
  });
});

describe("skusDaLeitura — a identidade da leitura", () => {
  it("distintos, sem nulos e em ordem: a mesma campanha com outro vínculo é OUTRA leitura", () => {
    expect(skusDaLeitura([8689744102, null, 8689717792, 8689744102])).toStrictEqual([8689717792, 8689744102]);
    expect(skusDaLeitura([null, null])).toStrictEqual([]);
  });
});
