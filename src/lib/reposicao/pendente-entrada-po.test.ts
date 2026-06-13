import { describe, it, expect } from "vitest";
import {
  quantidadesValidas,
  parseQtd,
  parseRecebido,
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

describe("parseQtd [P2 round6] — Number('')/Number(false)→0 mascarava dado torto", () => {
  it("número finito passa; numérico-string passa", () => {
    expect(parseQtd(5)).toBe(5);
    expect(parseQtd(0)).toBe(0);
    expect(parseQtd("5")).toBe(5);
    expect(parseQtd("5.5")).toBe(5.5);
  });
  it("'' / ' ' / false / array / objeto / não-numérico → NaN (não 0/coerção)", () => {
    expect(Number.isNaN(parseQtd(""))).toBe(true);
    expect(Number.isNaN(parseQtd(" "))).toBe(true);
    expect(Number.isNaN(parseQtd(false as unknown))).toBe(true);
    expect(Number.isNaN(parseQtd("abc"))).toBe(true);
    expect(Number.isNaN(parseQtd(Infinity))).toBe(true);
    expect(Number.isNaN(parseQtd(NaN))).toBe(true);
    expect(Number.isNaN(parseQtd([] as unknown))).toBe(true); // Number([])=0 mascararia
    expect(Number.isNaN(parseQtd([5] as unknown))).toBe(true); // Number([5])=5 mascararia
    expect(Number.isNaN(parseQtd({} as unknown))).toBe(true);
  });
  it("[P2 round7] rejeita hex/binário/científico (Number() aceitaria)", () => {
    expect(Number.isNaN(parseQtd("0x10"))).toBe(true); // Number=16
    expect(Number.isNaN(parseQtd("0b10"))).toBe(true); // Number=2
    expect(Number.isNaN(parseQtd("1e3"))).toBe(true);  // Number=1000
  });
});

describe("parseRecebido [P1 round7] — undefined(ausente)→0; null/inválido→NaN→flag", () => {
  it("undefined (ausente = nada recebido) → 0", () => {
    expect(parseRecebido(undefined)).toBe(0);
  });
  it("null EXPLÍCITO → NaN (não 0 — null num parcial contaria saldo cheio = ruptura)", () => {
    expect(Number.isNaN(parseRecebido(null))).toBe(true);
    expect(Number.isNaN(parseRecebido(""))).toBe(true);
    expect(Number.isNaN(parseRecebido("xx" as unknown))).toBe(true);
  });
  it("valor válido passa", () => {
    expect(parseRecebido(5)).toBe(5);
    expect(parseRecebido(0)).toBe(0);
  });
});

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
  nCodPed?: string; cNumero?: string; cCodIntPed?: string; cEtapa?: string;
  itens?: Array<{ nCodProd?: number | string; nQtde?: number; nQtdeRec?: number | null }>;
  usarCabecalhoLegado?: boolean;
} = {}): OmiePedConsultaRaw {
  const cab = { nCodPed: over.nCodPed, cNumero: over.cNumero ?? "1054", cCodIntPed: over.cCodIntPed ?? "", cEtapa: over.cEtapa ?? APROVADO };
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
    // 1ª PO: 1 item sem nCodProd JÁ RECEBIDO (saldo 0 → não dispara o novo check de saldo-omitido) → só o
    // problema "sem item com SKU". 2ª PO: cabeçalho sem itens → idem. Total = 2 (isola o caso P1.1).
    const r = coletarDaPagina(
      [po({ itens: [{ nQtde: 2, nQtdeRec: 2 }] }), { cabecalho_consulta: { cNumero: "200", cEtapa: APROVADO, cCodIntPed: "AFI-x" } }],
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

  it("[P1-E] nQtde AUSENTE vira NaN (fail-closed), mas nQtdeRec ausente vira 0 (normal)", () => {
    const r = coletarDaPagina([po({ itens: [{ nCodProd: "A" }] })], copts()); // sem nQtde nem nQtdeRec
    expect(Number.isNaN(r.items[0].qtde)).toBe(true); // ausente → NaN → computeOnOrder marca problema
    expect(r.items[0].recebido).toBe(0); // recebido ausente é normal → 0
    // e computeOnOrder transforma o NaN em PROBLEMA (abort apply)
    const onOrder = computeOnOrder(r.items, opts());
    expect(onOrder.problemas.length).toBe(1);
    expect(onOrder.porSku.size).toBe(0);
  });

  it("[novo furo] PO aprovada com item SEM nCodProd e saldo>0 → PROBLEMA (saldo seria omitido)", () => {
    // PO aprovada: 1 item bom (SKU A) + 1 item sem nCodProd com saldo 5 → fail-closed (saldo do 2º omitido)
    const r = coletarDaPagina(
      [po({ cCodIntPed: "AFI-z", itens: [{ nCodProd: "A", nQtde: 3 }, { nQtde: 5, nQtdeRec: 0 }] })],
      copts(),
    );
    expect(r.problemas.length).toBe(1);
    expect(r.problemas[0]).toMatch(/SEM nCodProd/);
    expect(r.items.map((i) => i.sku)).toEqual(["A"]); // o item bom foi coletado, mas o problema aborta o apply
  });

  it("[novo furo] item SEM nCodProd com saldo 0 (já recebido) NÃO vira problema", () => {
    const r = coletarDaPagina(
      [po({ itens: [{ nCodProd: "A", nQtde: 3 }, { nQtde: 5, nQtdeRec: 5 }] })], // 2º item: saldo 0
      copts(),
    );
    expect(r.problemas).toEqual([]);
  });

  it("[novo furo] item SEM nCodProd com saldo>0 numa etapa EM APROVAÇÃO (não conta) NÃO vira problema", () => {
    const r = coletarDaPagina(
      [po({ cEtapa: EM_APROVACAO, itens: [{ nQtde: 9, nQtdeRec: 0 }] })], // só item sem SKU, etapa-10
      copts(),
    );
    expect(r.problemas).toEqual([]);
  });

  it("[P2 round4] item SEM nCodProd com nQtde AUSENTE (saldo desconhecido) em etapa aprovada → PROBLEMA", () => {
    // PO aprovada: 1 item bom + 1 item sem nCodProd E sem nQtde (truncado?) → fail-closed (não trata como saldo 0)
    const r = coletarDaPagina(
      [po({ cCodIntPed: "AFI-w", itens: [{ nCodProd: "A", nQtde: 3 }, { nQtdeRec: 0 }] })], // 2º item: sem SKU, sem nQtde
      copts(),
    );
    expect(r.problemas.length).toBe(1);
    expect(r.problemas[0]).toMatch(/SEM nCodProd/);
  });

  it("[P2 round5] item SEM nCodProd com nQtde negativa OU nQtdeRec inválida → PROBLEMA (quantidadesValidas)", () => {
    // q < 0 (saldo q-r ≤ 0 não pegaria, mas quantidadesValidas pega)
    const rNeg = coletarDaPagina([po({ itens: [{ nQtde: -5 as unknown as number, nQtdeRec: 0 }] })], copts());
    expect(rNeg.problemas.length).toBeGreaterThanOrEqual(1);
    expect(rNeg.problemas.some((p) => /SEM nCodProd/.test(p))).toBe(true);
    // nQtdeRec presente-inválido (NaN via string) com nQtde válida → r=NaN → quantidadesValidas false → flag
    const rRecInval = coletarDaPagina(
      [po({ itens: [{ nCodProd: "A", nQtde: 3 }, { nQtde: 5, nQtdeRec: "xx" as unknown as number }] })],
      copts(),
    );
    expect(rRecInval.problemas.some((p) => /SEM nCodProd/.test(p))).toBe(true);
  });

  it("[P2 round6] item SEM nCodProd com nQtde='' (Number('')→0 mascarava) → PROBLEMA via parseQtd", () => {
    const r = coletarDaPagina([po({ itens: [{ nQtde: "" as unknown as number }] })], copts());
    expect(r.problemas.some((p) => /SEM nCodProd/.test(p))).toBe(true);
  });

  it("[round6] item COM SKU mas nQtde='' → NaN → computeOnOrder marca problema (não vira saldo 0)", () => {
    const r = coletarDaPagina([po({ itens: [{ nCodProd: "A", nQtde: "" as unknown as number }] })], copts());
    expect(Number.isNaN(r.items[0].qtde)).toBe(true);
    const onOrder = computeOnOrder(r.items, opts());
    expect(onOrder.problemas.length).toBe(1);
  });

  it("[P1 round7] item COM SKU com nQtdeRec=null (≠ ausente) → recebido NaN → computeOnOrder problema", () => {
    const r = coletarDaPagina([po({ itens: [{ nCodProd: "A", nQtde: 5, nQtdeRec: null as unknown as number }] })], copts());
    expect(Number.isNaN(r.items[0].recebido)).toBe(true);
    expect(computeOnOrder(r.items, opts()).problemas.length).toBe(1);
  });

  it("[P1 round7] item COM SKU SEM nQtdeRec (ausente) → recebido 0 (normal, nada recebido)", () => {
    const r = coletarDaPagina([po({ itens: [{ nCodProd: "A", nQtde: 5 }] })], copts());
    expect(r.items[0].recebido).toBe(0);
    expect(computeOnOrder(r.items, opts()).problemas).toEqual([]);
  });

  it("[P1 round8/9] identidade da PO = AMBAS as aliases prefixadas (id:<nCodPed> E numero:<cNumero>)", () => {
    const r = coletarDaPagina(
      [po({ nCodPed: "9001", cNumero: "100" }), po({ cNumero: "101" })], // 1ª tem as duas; 2ª só cNumero
      copts(),
    );
    expect(r.numerosVistos).toEqual(["id:9001", "numero:100", "numero:101"]);
  });

  it("[P1 round8] PO SEM nCodPed E SEM cNumero → PROBLEMA (não escapa do de-dup)", () => {
    const r = coletarDaPagina([po({ cNumero: "" })], copts()); // sem nCodPed, cNumero vazio
    expect(r.numerosVistos).toEqual([]);
    expect(r.problemas.some((p) => /sem identidade/.test(p))).toBe(true);
  });

  it("[P1 round8] PO com só nCodPed (cNumero vazio) → alias id:", () => {
    const r1 = coletarDaPagina([po({ nCodPed: "555", cNumero: "" })], copts());
    expect(r1.numerosVistos).toEqual(["id:555"]); // entra via nCodPed
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
    // [P2-D] "Não há registros" (com á) e "Não existe registro" incluídos: o `\b` após h[áa] falhava antes.
    for (const fim of [
      "Não foram encontrados registros", "Não existem registros para a página 3", "SEM REGISTROS",
      "Não há registros", "Não há registros para a página informada", "Não existe registro", "Nenhum registro encontrado",
    ]) {
      const r = await varrerPedidos(fetcher([{ pedidos: [po({ cNumero: "1" })] }, { faultstring: fim }]), vopts);
      expect(r.paginasLidas).toBe(1);
    }
  });

  it("[P1.7] FATAL: fault de ERRO (incl. 'not found' SOLTO) NÃO é fim → lança (anti-falso-positivo)", async () => {
    for (const erro of ["Não foi possível conectar ao servidor", "Erro ao gravar registro no banco", "App Key inválida", "Produto not found"]) {
      await expect(varrerPedidos(fetcher([{ faultstring: erro }]), vopts)).rejects.toThrow(/fault/);
    }
  });

  it("[P1-D] FATAL: 'Não foi possível retornar registros' (verbo 'foi') NÃO é fim → lança (anti-double-buy)", async () => {
    // o verbo genérico 'foi' foi removido do regex de fim; este erro tem que parar o sync (não truncar a paginação)
    for (const erro of [
      "Não foi possível retornar registros",
      "Não foi possível processar a lista de registros",
      "Falha ao retornar registros: timeout",
      "O serviço não retornou registros válidos por indisponibilidade",
      // [P2-D round3] over-match fechado: palavras entre o verbo e "registros" = ERRO, não fim
      "Não há permissão para acessar registros",
      "Não existem credenciais válidas para listar registros",
    ]) {
      await expect(varrerPedidos(fetcher([{ pedidos: [po({ cNumero: "1" })] }, { faultstring: erro }]), vopts)).rejects.toThrow(/fault/);
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

  it("[P1 round7] FATAL: PO SOBREPOSTA entre páginas DISTINTAS (shift de paginação) → lança (overcount)", async () => {
    // páginas diferentes (fingerprints distintos → o anti-loop de página NÃO pega), mas a PO '2' aparece nas duas
    const pag1 = { pedidos: [po({ cNumero: "1" }), po({ cNumero: "2" })] };
    const pag2 = { pedidos: [po({ cNumero: "2" }), po({ cNumero: "3" })] }; // '2' repetida
    await expect(varrerPedidos(fetcher([pag1, pag2, { pedidos: [] }]), vopts)).rejects.toThrow(/PO REPETIDA/);
  });

  it("[P1 round9] FATAL: PO com identidade ASSIMÉTRICA entre páginas (nCodPed numa, só cNumero noutra) → lança", async () => {
    // pág1: a PO "100" tem nCodPed E cNumero; pág2: a MESMA PO "100" vem só com cNumero (nCodPed ausente). A alias
    // `numero:100` bate nas duas → o de-dup pega (com "só a 1ª identidade" as chaves divergiriam e o overcount
    // passaria). 2ª PO distinta em cada página (501/502) só p/ os FINGERPRINTS diferirem (isola o de-dup do anti-loop).
    const pag1 = { pedidos: [po({ nCodPed: "9001", cNumero: "100" }), po({ cNumero: "501" })] };
    const pag2 = { pedidos: [po({ cNumero: "100" }), po({ cNumero: "502" })] }; // mesma PO "100", sem nCodPed
    await expect(varrerPedidos(fetcher([pag1, pag2, { pedidos: [] }]), vopts)).rejects.toThrow(/PO REPETIDA/);
  });

  it("[P1.1/P1.2] propaga problemas (PO aprovada sem item) e codintsEmAprovacao (etapa-10) das páginas", async () => {
    const r = await varrerPedidos(
      fetcher([
        { pedidos: [po({ cNumero: "1", cCodIntPed: "AFI-10", cEtapa: EM_APROVACAO })] }, // etapa-10
        { pedidos: [{ cabecalho_consulta: { cNumero: "300", cEtapa: APROVADO, cCodIntPed: "AFI-bad" } }] }, // aprovada sem item
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
