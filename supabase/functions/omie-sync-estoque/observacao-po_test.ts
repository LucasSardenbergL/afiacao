import {
  criarColetorObservacao,
  observacaoBateComPendente,
  observarPedido,
  somarContribuicaoPorSku,
} from "./observacao-po.ts";

function igual<T>(real: T, esperado: T, msg: string): void {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a !== b) throw new Error(`${msg}\n  real:     ${a}\n  esperado: ${b}`);
}

// parse estrito equivalente ao da edge: string/number finita; resto → NaN
const parse = {
  parseQtd: (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) ? Number(v) : NaN,
  parseRecebido: (v: unknown) => (v === undefined ? 0 : (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) ? Number(v) : NaN),
};
const habilitados = new Set(["8689791246"]);
const has = (sku: string) => habilitados.has(sku);
const cab = { nCodPed: 12000000001, cNumero: "1205", cEtapa: "15" };

Deno.test("item contado: contribuição = saldo, sem exclusão", () => {
  const l = observarPedido(cab, [{ nCodItem: 5, nCodProd: 8689791246, nQtde: 6, nQtdeRec: 2 }], null, has, parse);
  igual(l.map((x) => [x.contribuicao, x.exclusao]), [[4, null]], "saldo 6 − 2");
});

Deno.test("PO do app (de-dup): todos os itens com contribuição 0 e motivo", () => {
  const l = observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 6 }, { nCodProd: 1, nQtde: 1 }], "dedup_app", has, parse);
  igual(l.map((x) => [x.contribuicao, x.exclusao]), [[0, "dedup_app"], [0, "dedup_app"]], "de-dup");
});

Deno.test("etapa não aberta e repetido na varredura propagam o motivo do pedido", () => {
  igual(observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 6 }], "etapa_nao_aberta", has, parse)[0].exclusao,
    "etapa_nao_aberta", "etapa");
  igual(observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 6 }], "repetido_na_varredura", has, parse)[0].exclusao,
    "repetido_na_varredura", "repetido");
});

Deno.test("motivos por item: sem SKU, SKU não habilitado, quantidade inválida", () => {
  const l = observarPedido(cab, [
    { nCodProd: "", nQtde: 1 },
    { nCodProd: 777, nQtde: 1 },
    { nCodProd: 8689791246, nQtde: "" },
  ], null, has, parse);
  igual(l.map((x) => x.exclusao), ["item_sem_sku", "sku_nao_habilitado", "quantidade_invalida"], "motivos");
  igual(l.map((x) => x.contribuicao), [0, 0, 0], "nenhum contribui");
});

Deno.test("recebido acima do pedido não gera contribuição negativa", () => {
  igual(observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 2, nQtdeRec: 5 }], null, has, parse)[0].contribuicao, 0, "max(0, …)");
});

Deno.test("seq_item é a posição do item no PO e os ids vêm como número", () => {
  const l = observarPedido(cab, [{ nCodItem: "12000000002", nCodProd: 8689791246, nQtde: 1 }, { nCodProd: 8689791246, nQtde: 1 }], null, has, parse);
  igual(l.map((x) => [x.seq_item, x.id_item, x.sku_codigo_omie, x.omie_codigo_pedido]),
    [[0, 12000000002, 8689791246, 12000000001], [1, null, 8689791246, 12000000001]], "ids");
});

Deno.test("invariante: soma por SKU bate com o pendente; diverge quando falta ou sobra", () => {
  const l = [
    ...observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 6, nQtdeRec: 2 }], null, has, parse),
    ...observarPedido({ ...cab, nCodPed: 2 }, [{ nCodProd: 8689791246, nQtde: 3 }], "dedup_app", has, parse),
  ];
  igual([...somarContribuicaoPorSku(l)], [["8689791246", 4]], "soma");
  igual(observacaoBateComPendente(l, new Map([["8689791246", 4]])), true, "bate");
  igual(observacaoBateComPendente(l, new Map([["8689791246", 7]])), false, "pendente maior");
  igual(observacaoBateComPendente(l, new Map([["8689791246", 4], ["1", 1]])), false, "SKU a mais no pendente");
  igual(observacaoBateComPendente(l, new Map()), false, "pendente vazio");
});

Deno.test("invariante: contribuições todas zero COM linhas observadas publicam; sem linha nenhuma, não", () => {
  const zerado = observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 6, nQtdeRec: 6 }], null, has, parse);
  igual(observacaoBateComPendente(zerado, new Map()), true, "PO todo recebido: pendente legitimamente zero");
  igual(observacaoBateComPendente(zerado, new Map([["8689791246", 0]])), true, "zero explícito no pendente");
  igual(observacaoBateComPendente([], new Map()), false, "nada observado não prova nada");
});

// ── Coletor do run: a PK do banco é (run_id, omie_codigo_pedido, seq_item) — um PO entra UMA vez ──

Deno.test("coletor: 1 registro por PO — a 1ª aparição vence (a reaparição colidiria na PK)", () => {
  const c = criarColetorObservacao(has, parse);
  igual(c.registrar(cab, [{ nCodProd: 8689791246, nQtde: 6 }], null), true, "1ª aparição");
  igual(c.registrar(cab, [{ nCodProd: 8689791246, nQtde: 9 }], "repetido_na_varredura"), false, "reaparição");
  igual(c.registrar(cab, [{ nCodProd: 8689791246, nQtde: 9 }], "dedup_app"), false, "reaparição com outro motivo");
  igual(c.linhas.map((x) => [x.omie_codigo_pedido, x.seq_item, x.contribuicao, x.exclusao]),
    [[12000000001, 0, 6, null]], "só a 1ª");
});

Deno.test("coletor: reaparição sob OUTRO nCodPed (alias por número/código) é registrada com o motivo", () => {
  const c = criarColetorObservacao(has, parse);
  c.registrar(cab, [{ nCodProd: 8689791246, nQtde: 6 }], null);
  igual(c.registrar({ ...cab, nCodPed: 12000000077 }, [{ nCodProd: 8689791246, nQtde: 6 }], "repetido_na_varredura"),
    true, "outro id");
  igual(c.linhas.map((x) => [x.omie_codigo_pedido, x.contribuicao, x.exclusao]),
    [[12000000001, 6, null], [12000000077, 0, "repetido_na_varredura"]], "ids");
});

Deno.test("coletor: nCodPed inválido não é registrado e a coleta perde a integridade (ausência não vira prova)", () => {
  for (const n of [0, NaN, -5, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    const c = criarColetorObservacao(has, parse);
    igual(c.registrar({ ...cab, nCodPed: n }, [{ nCodProd: 8689791246, nQtde: 1 }], "dedup_app"), false, `nCodPed ${n}`);
    igual([c.linhas.length, c.integra, c.perda], [0, false, "pedido_sem_ncodped"], `perda com nCodPed ${n}`);
  }
});

Deno.test("coletor: itens fora de array ou item que não é objeto perdem a integridade SEM lançar", () => {
  for (const itens of [{}, null, "x", [null], [1], [{ nCodProd: 8689791246, nQtde: 1 }, null]]) {
    const c = criarColetorObservacao(has, parse);
    igual(c.registrar(cab, itens, "etapa_nao_aberta"), false, `itens ${JSON.stringify(itens)}`);
    igual([c.linhas.length, c.integra, c.perda], [0, false, "itens_malformados:12000000001"], "perda");
  }
});

Deno.test("coletor: PO NÃO contado sem itens entra com 1 linha de presença; contado sem itens perde a integridade", () => {
  const c = criarColetorObservacao(has, parse);
  igual(c.registrar({ ...cab, cEtapa: "10" }, [], "etapa_nao_aberta"), true, "presença");
  igual(c.linhas, [{
    omie_codigo_pedido: 12000000001, seq_item: 0, numero_pedido: "1205", etapa: "10", id_item: null,
    sku_codigo_omie: null, quantidade: null, quantidade_recebida: null, contribuicao: 0, exclusao: "etapa_nao_aberta",
  }], "linha de presença");
  igual(c.integra, true, "presença não é perda");
  const d = criarColetorObservacao(has, parse);
  igual(d.registrar(cab, [], null), false, "contado sem itens");
  igual([d.linhas.length, d.integra, d.perda], [0, false, "pedido_contado_sem_itens:12000000001"], "perda");
});

Deno.test("coletor: PO anotado 1º como NÃO contado e depois CONTADO perde a integridade (a soma poderia compensar)", () => {
  const c = criarColetorObservacao(has, parse);
  c.registrar({ ...cab, cEtapa: "10" }, [{ nCodProd: 8689791246, nQtde: 6 }], "etapa_nao_aberta");
  igual(c.registrar(cab, [{ nCodProd: 8689791246, nQtde: 6 }], null), false, "a aparição que o motor contou");
  igual([c.integra, c.perda], [false, "decisao_mudou_na_varredura:12000000001"], "perda");
  igual(observacaoBateComPendente(c.linhas, new Map([["8689791246", 6]])), false, "e a soma também não fecha");
});

Deno.test("coletor: reaparição NÃO contada de um PO já anotado é ignorada sem perder a integridade", () => {
  const c = criarColetorObservacao(has, parse);
  c.registrar(cab, [{ nCodProd: 8689791246, nQtde: 6 }], null);
  igual(c.registrar(cab, [{ nCodProd: 8689791246, nQtde: 6 }], "repetido_na_varredura"), false, "repetido");
  igual(c.registrar(cab, [{ nCodProd: 8689791246, nQtde: 6 }], "etapa_nao_aberta"), false, "mudou de etapa, não conta");
  igual([c.linhas.length, c.integra], [1, true], "segue íntegra");
});
