// Parser da OS — ausente ≠ zero (money-path). `assertEquals` local: `test:edges` roda com `--no-remote`.
import { dataOmie, parseOS, prazoMaxDias, simNao, valorMonetario } from "./os-parse.ts";

function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}

const OS = (over: Record<string, unknown> = {}) => ({
  Cabecalho: { nCodOS: 9001, cNumOS: "461", cCodIntOS: "X", nCodCli: 3545104666, cEtapa: "20", nValorTotal: 132, ...(over.cab as object ?? {}) },
  InfoCadastro: { cFaturada: "N", cCancelada: "N", dDtInc: "10/11/2026", cHrInc: "09:15:00", dDtAlt: "12/11/2026", cHrAlt: "10:00:00", ...(over.info as object ?? {}) },
  Parcelas: "parcelas" in over ? over.parcelas : [{ nParcela: 1, nDias: 28 }, { nParcela: 2, nDias: 42 }],
});

Deno.test("OS completa: identidade, valor, prazo = max(nDias), flags e datas com fuso -03:00", () => {
  const p = parseOS(OS());
  if (!p.ok) throw new Error(p.motivo);
  assertEquals([p.linha.n_cod_os, p.linha.c_num_os, p.linha.n_cod_cli, p.linha.valor_total, p.linha.prazo_max_dias],
    [9001, "461", 3545104666, 132, 42]);
  assertEquals([p.linha.faturada, p.linha.cancelada], [false, false]);
  assertEquals(p.linha.data_inclusao, "2026-11-10T09:15:00-03:00");
});

Deno.test("valor ausente/nulo/vazio NÃO vira 0 (Number(null)/Number('') fabricariam)", () => {
  for (const v of [null, "", "  ", undefined, "abc", NaN, -1, Infinity]) {
    const p = parseOS(OS({ cab: { nValorTotal: v } }));
    if (!p.ok) throw new Error(p.motivo);
    assertEquals(p.linha.valor_total, null);
  }
  assertEquals(valorMonetario(0), 0);          // zero LEGÍTIMO continua zero (quem consome trata como tentativa)
  assertEquals(valorMonetario("1234.50"), 1234.5);
});

Deno.test("parcela sem nDias (ou nDias vazio) deixa o prazo NULL; sem parcelas também", () => {
  assertEquals(prazoMaxDias([{ nDias: 28 }, { nParcela: 2 }]), null);
  assertEquals(prazoMaxDias([{ nDias: "" }]), null);
  assertEquals(prazoMaxDias([{ nDias: null }]), null);
  assertEquals(prazoMaxDias([{ nDias: 2.5 }]), null);
  assertEquals(prazoMaxDias([]), null);
  assertEquals(prazoMaxDias(null), null);
  assertEquals(prazoMaxDias([{ nDias: 0 }]), 0);   // à vista declarado é 0 de verdade
  const p = parseOS(OS({ parcelas: undefined }));
  if (!p.ok) throw new Error(p.motivo);
  assertEquals([p.linha.prazo_max_dias, p.linha.n_parcelas], [null, null]);
  const um = parseOS(OS({ parcelas: { nDias: 30 } }));   // objeto único normalizado
  if (!um.ok) throw new Error(um.motivo);
  assertEquals(um.linha.prazo_max_dias, 30);
});

Deno.test("flags: só 'S'/'N' afirmam algo; ausente ou outro → null", () => {
  assertEquals([simNao("S"), simNao(" n "), simNao(""), simNao(undefined), simNao("X"), simNao(1)], [true, false, null, null, null, null]);
});

Deno.test("datas: dd/mm/aaaa estrito; inválida ou ausente → null", () => {
  assertEquals(dataOmie("31/02/2026"), null);
  assertEquals(dataOmie("2026-11-10"), null);
  assertEquals(dataOmie(""), null);
  assertEquals(dataOmie(undefined), null);
  assertEquals(dataOmie("10/11/2026", "25:00:00"), null);
  assertEquals(dataOmie("10/11/2026", ""), "2026-11-10T00:00:00-03:00");
});

Deno.test("sem nCodOS inteiro positivo → não é OS (shape_err), nunca id inventado", () => {
  for (const v of [null, "", 0, -3, 1.5, "abc", undefined]) {
    assertEquals(parseOS(OS({ cab: { nCodOS: v } })).ok, false);
  }
  assertEquals(parseOS(null).ok, false);
  assertEquals(parseOS({ InfoCadastro: {} }).ok, false);
});

Deno.test("cliente ilegível → null (não 0)", () => {
  const p = parseOS(OS({ cab: { nCodCli: "" } }));
  if (!p.ok) throw new Error(p.motivo);
  assertEquals(p.linha.n_cod_cli, null);
});
