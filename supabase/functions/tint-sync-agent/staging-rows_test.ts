// staging-rows_test.ts — contrato payload→staging do handler /formulas (Fase 1d).
// Roda no CI via `bun run test:edges` (deno test --no-remote) — SEM import remoto.
//
// O que está em jogo (money-path): o conector 1d passou a PRESERVAR itens
// inválidos no payload e a DECLARAR is_base_pura. A edge é o transporte
// payload→staging — se ela filtrar, defaultar ou inferir, os guards do banco
// ficam cegos de novo (o furo original da receita parcial).
import {
  montarStagingFormulaRow,
  montarStagingItemRows,
  type TintFormulaPayload,
} from "./staging-rows.ts";

function assertEq(atual: unknown, esperado: unknown, msg: string) {
  if (!Object.is(atual, esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}

const BASE: TintFormulaPayload = {
  cor_id: "COR1",
  cod_produto: "P1",
  id_base: "B1",
  id_embalagem: "E1",
  personalizada: false,
};

Deno.test("expected_item_count conta TODAS as linhas — inclusive as inválidas preservadas", () => {
  const f: TintFormulaPayload = {
    ...BASE,
    itens: [
      { id_corante: "AX", ordem: 1, qtd_ml: 10 },
      { id_corante: "VM", ordem: 2, qtd_ml: null }, // inválido preservado pelo conector 1d
    ],
  };
  const row = montarStagingFormulaRow(f, "run1", "oben", "L1");
  assertEq(row.expected_item_count, 2, "expected deve contar o item inválido");
  const itens = montarStagingItemRows(f, row.id as string, "run1");
  assertEq(itens.length, 2, "itemRows preserva as 2 linhas");
  assertEq(itens[1].qtd_ml, null, "qtd_ml null é pass-through (nunca vira 0)");
  assertEq(itens[1].id_corante, "VM", "id do inválido preservado");
});

Deno.test("todos inválidos: nada é filtrado na edge (o banco decide)", () => {
  const f: TintFormulaPayload = {
    ...BASE,
    itens: [
      { id_corante: "AX", ordem: 1, qtd_ml: 0 },
      { id_corante: "VM", ordem: 2, qtd_ml: -3 },
    ],
  };
  const row = montarStagingFormulaRow(f, "run1", "oben", "L1");
  assertEq(row.expected_item_count, 2, "expected conta os 2 inválidos");
  const itens = montarStagingItemRows(f, row.id as string, "run1");
  assertEq(itens[0].qtd_ml, 0, "qtd 0 preservada crua");
  assertEq(itens[1].qtd_ml, -3, "qtd negativa preservada crua");
});

Deno.test("itens AUSENTE → expected_item_count NULL (nunca 0 — protocolo ambíguo barra no banco)", () => {
  const row = montarStagingFormulaRow({ ...BASE }, "run1", "oben", "L1");
  assertEq(row.expected_item_count, null, "ausência NUNCA vira 0");
});

Deno.test("itens=[] declarado → expected=0 (transporte íntegro de conjunto vazio)", () => {
  const row = montarStagingFormulaRow({ ...BASE, itens: [] }, "run1", "oben", "L1");
  assertEq(row.expected_item_count, 0, "array vazio explícito declara 0");
});

Deno.test("is_base_pura: SÓ o literal true entra; string/1/undefined viram null", () => {
  assertEq(
    montarStagingFormulaRow({ ...BASE, itens: [], is_base_pura: true }, "r", "oben", "L1").is_base_pura,
    true, "literal true repassado");
  assertEq(
    montarStagingFormulaRow({ ...BASE, itens: [] }, "r", "oben", "L1").is_base_pura,
    null, "ausente vira null");
  assertEq(
    montarStagingFormulaRow({ ...BASE, itens: [], is_base_pura: false }, "r", "oben", "L1").is_base_pura,
    null, "false vira null (o campo só existe quando true)");
  assertEq(
    montarStagingFormulaRow(
      { ...BASE, itens: [], is_base_pura: "true" as unknown as boolean }, "r", "oben", "L1").is_base_pura,
    null, "string 'true' NÃO é declaração");
  assertEq(
    montarStagingFormulaRow(
      { ...BASE, itens: [], is_base_pura: 1 as unknown as boolean }, "r", "oben", "L1").is_base_pura,
    null, "1 NÃO é declaração");
});

Deno.test("placeholder (id_corante ausente) vira '' PRESERVANDO a dose (órfão → Guard 4b)", () => {
  const f: TintFormulaPayload = { ...BASE, itens: [{ ordem: 3, qtd_ml: 7 }] };
  const itens = montarStagingItemRows(f, "fid", "run1");
  assertEq(itens[0].id_corante, "", "id ausente vira ''");
  assertEq(itens[0].qtd_ml, 7, "dose do órfão preservada");
});

Deno.test("id do header é PRÉ-GERADO e único por chamada", () => {
  const r1 = montarStagingFormulaRow({ ...BASE }, "run1", "oben", "L1");
  const r2 = montarStagingFormulaRow({ ...BASE }, "run1", "oben", "L1");
  if (typeof r1.id !== "string" || (r1.id as string).length < 30) {
    throw new Error("id do header ausente/curto: " + JSON.stringify(r1.id));
  }
  if (r1.id === r2.id) throw new Error("ids de headers distintos colidiram");
});
