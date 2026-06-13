import { describe, it, expect } from "vitest";
import {
  quantidadesValidas,
  saldoAReceber,
  computeOnOrder,
  coletarDaPagina,
  paginaVazia,
  fingerprintPagina,
  codintsFaltantes,
  varrerPedidos,
  type PoItemOmie,
  type ComputeOnOrderOpts,
  type ColetaPaginaOpts,
  type OmiePedConsultaRaw,
  type PaginaPedidos,
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

// ── Coleta / paginação (parsing puro espelhado na edge) ──

function copts(over: Partial<ColetaPaginaOpts> = {}): ColetaPaginaOpts {
  return { etapasAprovadas: new Set([APROVADO]), etapasEmAprovacao: new Set([EM_APROVACAO]), ...over };
}
function po(over: {
  cNumero?: string; cCodIntPed?: string; cEtapa?: string;
  itens?: Array<{ nCodProd?: number | string; nQtde?: number; nQtdeRec?: number }>;
  usarCabecalhoLegado?: boolean;
} = {}): OmiePedConsultaRaw {
  const cab = { cNumero: over.cNumero ?? "1054", cCodIntPed: over.cCodIntPed ?? "", cEtapa: over.cEtapa ?? APROVADO };
  const produtos = over.itens ?? [{ nCodProd: "8689734299", nQtde: 3, nQtdeRec: 0 }];
  return over.usarCabecalhoLegado
    ? { cabecalho: cab, produtos_consulta: produtos }
    : { cabecalho_consulta: cab, produtos_consulta: produtos };
}

describe("coletarDaPagina", () => {
  it("extrai item + poNumero + etapa (FUNDO PU)", () => {
    const r = coletarDaPagina([po()], copts());
    expect(r.items).toEqual([{ sku: "8689734299", poNumero: "1054", etapa: APROVADO, qtde: 3, recebido: 0 }]);
    expect(r.pedidosVistos).toBe(1);
  });

  it("codint de PO aprovada COM item (independe de saldo) → aprovados; etapa-10 → emAprovacao (barreira 3b)", () => {
    const r = coletarDaPagina(
      [
        po({ cCodIntPed: "AFI-aaa", itens: [{ nCodProd: "X", nQtde: 5, nQtdeRec: 5 }] }), // saldo 0, mas aprovada COM item
        po({ cCodIntPed: "AFI-bbb", cEtapa: EM_APROVACAO }), // etapa 10 → emAprovacao
      ],
      copts(),
    );
    expect(r.codintsAprovados).toEqual(["AFI-aaa"]);
    expect(r.codintsEmAprovacao).toEqual(["AFI-bbb"]);
    expect(r.problemas).toEqual([]);
  });

  it("codint vazio não entra; cabecalho legado funciona", () => {
    const r = coletarDaPagina([po({ cCodIntPed: "", usarCabecalhoLegado: true })], copts());
    expect(r.codintsAprovados).toEqual([]);
    expect(r.items.length).toBe(1);
  });

  it("filtra itens por skusHabilitados quando dado", () => {
    const r = coletarDaPagina(
      [po({ itens: [{ nCodProd: "HAB", nQtde: 2 }, { nCodProd: "FORA", nQtde: 9 }] })],
      copts({ skusHabilitados: new Set(["HAB"]) }),
    );
    expect(r.items.map((i) => i.sku)).toEqual(["HAB"]);
  });

  it("[P1.1] PO aprovada sem item com SKU → PROBLEMA (fail-closed) e NÃO coleta codint (senão barreira passa c/ saldo 0)", () => {
    const r = coletarDaPagina(
      [po({ itens: [{ nQtde: 2 }] }), { cabecalho_consulta: { cEtapa: APROVADO, cCodIntPed: "AFI-x" } }],
      copts(),
    );
    expect(r.items).toEqual([]);
    expect(r.codintsAprovados).toEqual([]); // AFI-x NÃO entra — PO sem item = resposta suspeita/truncada
    expect(r.problemas.length).toBe(2); // ambas as POs aprovadas sem item-com-SKU
  });

  it("[P1.1] PO aprovada COM item de SKU não-habilitado ainda coleta o codint (a PO veio íntegra)", () => {
    const r = coletarDaPagina(
      [po({ cCodIntPed: "AFI-y", itens: [{ nCodProd: "FORA", nQtde: 3 }] })],
      copts({ skusHabilitados: new Set(["HAB"]) }),
    );
    expect(r.items).toEqual([]); // FORA filtrado
    expect(r.codintsAprovados).toEqual(["AFI-y"]); // mas a PO tem item com SKU → não é suspeita
    expect(r.problemas).toEqual([]);
  });

  it("etapasVistas reúne as etapas distintas (diagnóstico)", () => {
    const r = coletarDaPagina([po(), po({ cEtapa: "10" }), po({ cEtapa: "99" })], copts());
    expect(r.etapasVistas.sort()).toEqual(["10", "15", "99"]);
  });

  it("string numérica em qtde/recebido é coagida; não-numérica vira NaN (computeOnOrder pega)", () => {
    const r = coletarDaPagina([po({ itens: [{ nCodProd: "A", nQtde: "abc" as unknown as number }] })], copts());
    expect(Number.isNaN(r.items[0].qtde)).toBe(true);
  });
});

describe("paginaVazia / fingerprintPagina (paginar até página vazia, anti-loop)", () => {
  it("vazia: [] e undefined → true; não-vazia → false", () => {
    expect(paginaVazia([])).toBe(true);
    expect(paginaVazia(undefined)).toBe(true);
    expect(paginaVazia([po()])).toBe(false);
  });
  it("fingerprint vazio é '' (não dispara loop)", () => {
    expect(fingerprintPagina([])).toBe("");
    expect(fingerprintPagina(undefined)).toBe("");
  });
  it("páginas diferentes → fingerprints diferentes; mesma página → igual (= loop)", () => {
    const pgA = [po({ cNumero: "1" }), po({ cNumero: "2" })];
    const pgB = [po({ cNumero: "3" }), po({ cNumero: "4" })];
    expect(fingerprintPagina(pgA)).not.toBe(fingerprintPagina(pgB));
    expect(fingerprintPagina(pgA)).toBe(fingerprintPagina([po({ cNumero: "1" }), po({ cNumero: "2" })]));
  });
});

describe("codintsFaltantes (esperar_codints do bump)", () => {
  it("todos vistos → []", () => {
    expect(codintsFaltantes(["AFI-1", "AFI-2"], ["AFI-2", "AFI-1", "AFI-9"])).toEqual([]);
  });
  it("retorna só os que faltam, dedup + trim", () => {
    expect(codintsFaltantes(["AFI-1", " AFI-2 ", "AFI-1"], ["AFI-2"])).toEqual(["AFI-1"]);
  });
  it("esperados vazios → []", () => {
    expect(codintsFaltantes([], ["AFI-1"])).toEqual([]);
  });
});

describe("varrerPedidos — loop de paginação (paginar até página vazia, anti-loop, anti-truncamento)", () => {
  // fetcher mock: serve as páginas dadas; além do array, devolve página vazia (fim natural).
  function fetcher(paginas: PaginaPedidos[]): (p: number) => Promise<PaginaPedidos> {
    return (p: number) => Promise.resolve(paginas[p - 1] ?? { pedidos: [] });
  }
  const vopts = { etapasAprovadas: new Set([APROVADO]), etapasEmAprovacao: new Set([EM_APROVACAO]), maxPaginas: 100 };

  it("para na página vazia e acumula as anteriores (não confia em nTotalPaginas)", async () => {
    const r = await varrerPedidos(
      fetcher([
        { pedidos: [po({ cNumero: "1", itens: [{ nCodProd: "A", nQtde: 2 }] })] },
        { pedidos: [po({ cNumero: "2", itens: [{ nCodProd: "B", nQtde: 5, nQtdeRec: 1 }] })] },
        { pedidos: [] }, // FIM
      ]),
      vopts,
    );
    expect(r.paginasLidas).toBe(2);
    expect(r.items.map((i) => i.sku).sort()).toEqual(["A", "B"]);
    expect(r.pedidosVistos).toBe(2);
  });

  it("para em fault 'sem registros' (fim legítimo), em variações", async () => {
    for (const fim of ["Não foram encontrados registros", "Não existem registros para a página 3", "SEM REGISTROS"]) {
      const r = await varrerPedidos(fetcher([{ pedidos: [po({ cNumero: "1" })] }, { faultstring: fim }]), vopts);
      expect(r.paginasLidas).toBe(1);
    }
  });

  it("[P1.7] FATAL: fault de ERRO (incl. 'not found' SOLTO) NÃO é fim → lança (anti-falso-positivo)", async () => {
    for (const erro of ["Não foi possível conectar ao servidor", "Erro ao gravar registro no banco", "App Key inválida", "Produto not found"]) {
      await expect(varrerPedidos(fetcher([{ faultstring: erro }]), vopts)).rejects.toThrow(/fault/);
    }
  });

  it("FATAL: página repetida CONSECUTIVA → lança", async () => {
    const pg = { pedidos: [po({ cNumero: "1" }), po({ cNumero: "2" })] };
    await expect(varrerPedidos(fetcher([pg, pg, { pedidos: [] }]), vopts)).rejects.toThrow(/REPETIÇÃO/);
  });

  it("[P1.7] FATAL: página repetida NÃO-consecutiva (A/B/A) → lança (overcount/double-buy)", async () => {
    const a = { pedidos: [po({ cNumero: "1" })] };
    const b = { pedidos: [po({ cNumero: "9" }), po({ cNumero: "8" })] };
    await expect(varrerPedidos(fetcher([a, b, a, { pedidos: [] }]), vopts)).rejects.toThrow(/REPETIÇÃO/);
  });

  it("[P1.1/P1.2] propaga problemas (PO aprovada sem item) e codintsEmAprovacao (etapa-10) das páginas", async () => {
    const r = await varrerPedidos(
      fetcher([
        { pedidos: [po({ cNumero: "1", cCodIntPed: "AFI-10", cEtapa: EM_APROVACAO })] }, // etapa-10
        { pedidos: [{ cabecalho_consulta: { cEtapa: APROVADO, cCodIntPed: "AFI-bad" } }] }, // aprovada sem item
        { pedidos: [] },
      ]),
      vopts,
    );
    expect(r.codintsEmAprovacao).toEqual(["AFI-10"]);
    expect(r.problemas.length).toBe(1); // a PO aprovada sem item
    expect(r.codintsAprovados).toEqual([]); // AFI-bad NÃO entra
  });

  it("FATAL: teto técnico sem ver fim → lança (anti-truncamento)", async () => {
    // fetcher que SEMPRE devolve página não-vazia e distinta (nunca vazia) → estoura maxPaginas
    const fetchInfinito = (p: number) => Promise.resolve({ pedidos: [po({ cNumero: String(p) })] });
    await expect(varrerPedidos(fetchInfinito, { ...vopts, maxPaginas: 5 })).rejects.toThrow(/anti-truncamento/);
  });

  it("FATAL: fault que não é 'sem registros' → lança", async () => {
    await expect(
      varrerPedidos(fetcher([{ faultstring: "Erro interno do servidor Omie" }]), vopts),
    ).rejects.toThrow(/fault/);
  });

  it("1ª página já vazia → fim imediato, paginasLidas=0", async () => {
    const r = await varrerPedidos(fetcher([{ pedidos: [] }]), vopts);
    expect(r.paginasLidas).toBe(0);
    expect(r.items).toEqual([]);
  });

  it("acumula codints (etapa-aprovada) e filtra itens por habilitado entre páginas", async () => {
    const r = await varrerPedidos(
      fetcher([
        { pedidos: [po({ cNumero: "1", cCodIntPed: "AFI-1", itens: [{ nCodProd: "HAB", nQtde: 2 }, { nCodProd: "X", nQtde: 9 }] })] },
        { pedidos: [po({ cNumero: "2", cCodIntPed: "AFI-2" })] },
        { pedidos: [] },
      ]),
      { ...vopts, skusHabilitados: new Set(["HAB", "8689734299"]) },
    );
    expect(r.codintsAprovados.sort()).toEqual(["AFI-1", "AFI-2"]);
    expect(r.items.map((i) => i.sku).sort()).toEqual(["8689734299", "HAB"]); // "X" filtrado fora
  });
});
