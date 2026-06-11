import { describe, it, expect } from "vitest";
import {
  quantidadesValidas,
  saldoAReceber,
  computeOnOrder,
  type PoItemOmie,
  type ComputeOnOrderOpts,
} from "./pendente-entrada-po";

const APROVADO = "15"; // OBEN: etapa 15 = Aprovado
const EM_APROVACAO = "10";

function opts(over: Partial<ComputeOnOrderOpts> = {}): ComputeOnOrderOpts {
  return { etapasAprovadas: new Set([APROVADO]), etapasIgnoradas: new Set([EM_APROVACAO]), ...over };
}
function item(over: Partial<PoItemOmie> = {}): PoItemOmie {
  return { sku: "8689734299", poNumero: "1054", etapa: APROVADO, qtde: 3, recebido: 0, ...over };
}

describe("quantidadesValidas", () => {
  it("válido", () => expect(quantidadesValidas(3, 0)).toBe(true));
  it("recebido parcial válido", () => expect(quantidadesValidas(4, 1)).toBe(true));
  it("NaN qtde inválido", () => expect(quantidadesValidas(NaN, 0)).toBe(false));
  it("NaN recebido inválido", () => expect(quantidadesValidas(3, NaN)).toBe(false));
  it("qtde negativa inválida", () => expect(quantidadesValidas(-1, 0)).toBe(false));
  it("recebido negativo inválido", () => expect(quantidadesValidas(3, -2)).toBe(false));
  it("Infinity inválido", () => expect(quantidadesValidas(Infinity, 0)).toBe(false));
});

describe("saldoAReceber", () => {
  it("qtde - recebido", () => expect(saldoAReceber(3, 0)).toBe(3));
  it("parcial", () => expect(saldoAReceber(4, 1)).toBe(3));
  it("recebido total = 0", () => expect(saldoAReceber(3, 3)).toBe(0));
});

describe("computeOnOrder — caminho feliz", () => {
  it("caso FUNDO PU/1054: PO aprovada futura entra (era o bug)", () => {
    const r = computeOnOrder([item()], opts());
    expect(r.problemas).toEqual([]);
    expect(r.porSku.get("8689734299")).toBe(3);
  });

  it("em aprovação (10) é ignorado SEM problema", () => {
    const r = computeOnOrder([item({ etapa: EM_APROVACAO })], opts());
    expect(r.problemas).toEqual([]);
    expect(r.porSku.size).toBe(0);
  });

  it("recebimento parcial: conta só o saldo", () => {
    const r = computeOnOrder([item({ qtde: 4, recebido: 1 })], opts());
    expect(r.porSku.get("8689734299")).toBe(3);
  });

  it("totalmente recebido: saldo 0, não entra (virou físico)", () => {
    const r = computeOnOrder([item({ qtde: 3, recebido: 3 })], opts());
    expect(r.problemas).toEqual([]);
    expect(r.porSku.size).toBe(0);
  });

  it("FONTE ÚNICA: app + manual contam (sem de-dup)", () => {
    const r = computeOnOrder(
      [item({ poNumero: "9000", qtde: 5 }), item({ poNumero: "1054", qtde: 3 })],
      opts(),
    );
    expect(r.porSku.get("8689734299")).toBe(8); // 5 (app) + 3 (manual), os dois contam
  });

  it("soma múltiplas POs e vários SKUs", () => {
    const r = computeOnOrder(
      [
        item({ sku: "A", poNumero: "1", qtde: 2 }),
        item({ sku: "B", poNumero: "2", qtde: 5, recebido: 1 }),
        item({ sku: "A", poNumero: "3", qtde: 1 }),
      ],
      opts(),
    );
    expect(r.porSku.get("A")).toBe(3);
    expect(r.porSku.get("B")).toBe(4);
    expect(r.problemas).toEqual([]);
  });

  it("entrada vazia → vazio, sem problema", () => {
    const r = computeOnOrder([], opts());
    expect(r.porSku.size).toBe(0);
    expect(r.problemas).toEqual([]);
  });
});

describe("computeOnOrder — FAIL-CLOSED (problemas abortam o apply)", () => {
  it("etapa aberta desconhecida COM saldo → problema", () => {
    const r = computeOnOrder([item({ etapa: "16" })], opts());
    expect(r.problemas.length).toBe(1);
    expect(r.problemas[0]).toContain("etapa aberta desconhecida");
  });

  it("etapa desconhecida SEM saldo (tudo recebido) → NÃO é problema (não contribui)", () => {
    const r = computeOnOrder([item({ etapa: "16", qtde: 2, recebido: 2 })], opts());
    expect(r.problemas).toEqual([]);
    expect(r.porSku.size).toBe(0);
  });

  it("recebido > qtde (dado torto, saldo negativo evitado) NÃO é problema mas não conta", () => {
    // quantidadesValidas: ambos >=0 e finitos → válido; saldo = max(0, 3-5)=0 → não entra
    const r = computeOnOrder([item({ qtde: 3, recebido: 5 })], opts());
    expect(r.problemas).toEqual([]);
    expect(r.porSku.size).toBe(0);
  });

  it("NaN em qtde/recebido → problema (não conta a quantidade inteira)", () => {
    expect(computeOnOrder([item({ qtde: NaN })], opts()).problemas.length).toBe(1);
    expect(computeOnOrder([item({ recebido: NaN })], opts()).problemas.length).toBe(1);
  });

  it("recebido negativo → problema (senão saldo = qtde + |neg| = overcount)", () => {
    const r = computeOnOrder([item({ qtde: 3, recebido: -2 })], opts());
    expect(r.problemas.length).toBe(1);
    expect(r.porSku.size).toBe(0);
  });

  it("um item problemático coexiste com bons: problema é reportado (a edge aborta o apply inteiro)", () => {
    const r = computeOnOrder(
      [item({ sku: "BOM", poNumero: "1", qtde: 2 }), item({ sku: "RUIM", poNumero: "2", etapa: "77" })],
      opts(),
    );
    expect(r.problemas.length).toBe(1);
    expect(r.porSku.get("BOM")).toBe(2); // calculado, mas a edge descarta tudo se problemas != []
  });
});
