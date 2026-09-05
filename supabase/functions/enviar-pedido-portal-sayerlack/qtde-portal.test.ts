// Testa a conversão PURA Omie→portal (qtdePortal). Rodar: deno test supabase/functions/enviar-pedido-portal-sayerlack/
import { FatorConversaoInvalidoError, qtdeFisicaOmie, qtdePortal } from "./qtde-portal.ts";

// Asserts LOCAIS de propósito (sem jsr:@std/assert): `deno test --no-remote` roda no `validate` do CI.
function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: esperado ${String(expected)}, veio ${String(actual)}`);
}
function assertLancaFator(fn: () => unknown, msg: string) {
  try {
    fn();
  } catch (e) {
    if (e instanceof FatorConversaoInvalidoError) return; // casa a MARCA do ramo, não "lançou algo"
    throw new Error(`${msg}: lançou outra coisa (${String(e)})`);
  }
  throw new Error(`${msg}: não lançou`);
}

Deno.test("fator 1 = identidade (concentrados QT/GL já vêm em embalagens)", () => {
  assertEquals(qtdePortal(4, 1), 4, "4 QT");
  assertEquals(qtdePortal(2, 1), 2, "2 GL");
  assertEquals(qtdePortal(3.99996, 1), 4, "poeira decimal do Omie sobe para 4");
});

Deno.test("fator 0,2 = litro → balde de 5 L, sempre para cima", () => {
  const casos: Array<[number, number]> = [[5, 1], [10, 2], [35, 7], [36, 8], [40, 8], [45, 9], [55, 11], [70, 14], [1, 1]];
  for (const [litros, baldes] of casos) assertEquals(qtdePortal(litros, 0.2), baldes, `${litros} L`);
});

Deno.test("múltiplo exato NÃO ganha embalagem extra por poeira binária", () => {
  // 0,2 não é exato em IEEE-754: sem round6, algum q*0.2 pode dar 7,000000000000001 → ceil 8.
  for (let litros = 5; litros <= 500; litros += 5) {
    assertEquals(qtdePortal(litros, 0.2), litros / 5, `${litros} L exato`);
  }
  assertEquals(qtdePortal(3.24, 1 / 3.24), 1, "1 galão-base (3,24 L)");
  assertEquals(qtdePortal(4.05, 1 / 0.81), 5, "5 quartinhos-base (0,81 L)");
  // Casos VIVOS onde o float morde (medido em node, literais de 2 casas): 10,8 × (1/3,6) = 3,0000000000000004
  // → ceil 4 sem round6 (galão 3,6 L e quartinho 0,9 L mordem; 5 / 3,24 / 0,81 não mordem em 0..2000 L).
  // Os asserts acima são regressão; ESTES são a prova de que o round6 faz trabalho (sabotá-lo = vermelho).
  assertEquals(qtdePortal(10.8, 1 / 3.6), 3, "3 galões (10,8 L)");
  assertEquals(qtdePortal(21.6, 1 / 3.6), 6, "6 galões (21,6 L)");
  assertEquals(qtdePortal(2.7, 1 / 0.9), 3, "3 quartinhos (2,7 L)");
  assertEquals(qtdePortal(5.4, 1 / 0.9), 6, "6 quartinhos (5,4 L)");
});

Deno.test("mínimo 1 unidade no portal", () => {
  assertEquals(qtdePortal(0.5, 1), 1, "0,5");
  assertEquals(qtdePortal(0, 1), 1, "0 (o guard nQtde>0 do chamador barra antes)");
});

Deno.test("fail-closed: fator inválido lança a marca do ramo (nunca 'NaN' no input do portal)", () => {
  assertLancaFator(() => qtdePortal(36, 0), "fator 0");
  assertLancaFator(() => qtdePortal(36, -0.2), "fator negativo");
  assertLancaFator(() => qtdePortal(36, Number.NaN), "fator NaN");
  assertLancaFator(() => qtdePortal(36, Number.POSITIVE_INFINITY), "fator Infinity");
  assertLancaFator(() => qtdePortal(Number.NaN, 0.2), "qtde NaN");
  // Ramo da RPC `envio_portal_itens_mapeados` (hoje inexistente em prod): se um dia devolver linha SEM fator,
  // `undefined` cai aqui — abortar, nunca assumir 1 (Codex P1).
  assertLancaFator(() => qtdePortal(36, undefined as unknown as number), "fator undefined (RPC futura sem coluna)");
});

Deno.test("qtdeFisicaOmie: portal e Omie enxergam a MESMA compra (Codex P0)", () => {
  assertEquals(qtdeFisicaOmie(8, 0.2), 40, "8 BB = 40 L");
  assertEquals(qtdeFisicaOmie(7, 0.2), 35, "7 BB = 35 L");
  assertEquals(qtdeFisicaOmie(4, 1), 4, "fator 1 = identidade");
  assertEquals(qtdeFisicaOmie(5, 1 / 0.81), 4.05, "5 quartinhos-base = 4,05 L (round6)");
  assertEquals(qtdeFisicaOmie(3, 1 / 3.6), 10.8, "3 galões = 10,8 L (round6)");
  // ida-e-volta: normalizar e reconverter não muda o nº de embalagens (36 L → 8 BB → 40 L → 8 BB)
  for (const litros of [1, 36, 37, 40, 41, 99]) {
    const bb = qtdePortal(litros, 0.2);
    assertEquals(qtdePortal(qtdeFisicaOmie(bb, 0.2), 0.2), bb, `ida-e-volta ${litros} L`);
  }
  assertLancaFator(() => qtdeFisicaOmie(8, 0), "fator 0");
  assertLancaFator(() => qtdeFisicaOmie(7.2, 0.2), "qtde_portal fracionária (nunca chega aqui)");
  assertLancaFator(() => qtdeFisicaOmie(0, 0.2), "qtde_portal 0");
});

// ── Challenge Codex 2026-09-05 (3 achados) — casos espelhados em src/lib/reposicao/__tests__/qtde-portal.test.ts ──
import { FATOR_MAX, FatorAprovadoDivergenteError, indexarMapeamentos, MapeamentoAmbiguoError, QtdeNaoMultiploEmbalagemError, qtdePortalCanonica, verificarFatorAprovado } from "./qtde-portal.ts";

function assertLanca<T extends Error>(fn: () => unknown, classe: new (...a: never[]) => T, msg: string): T {
  try {
    fn();
  } catch (e) {
    if (e instanceof classe) return e; // casa a MARCA do ramo, não "lançou algo"
    throw new Error(`${msg}: lançou outra coisa (${String(e)})`);
  }
  throw new Error(`${msg}: não lançou`);
}

Deno.test("bound de finitude espelha o SQL: fator 1e9 é recusado (o CHECK fator_positivo recusa o mesmo)", () => {
  assertEquals(FATOR_MAX, 1e9, "FATOR_MAX");
  assertLancaFator(() => qtdePortal(36, 1e9), "qtdePortal 1e9");
  assertLancaFator(() => qtdePortal(36, 1e12), "qtdePortal 1e12");
  assertLancaFator(() => qtdeFisicaOmie(8, 1e9), "qtdeFisicaOmie 1e9");
  assertEquals(qtdePortal(1, 1e9 - 1), 1e9 - 1, "logo abaixo do bound segue aceito");
});

Deno.test("verificarFatorAprovado: TOCTOU aprovação→envio (0,2 → 0,18) recusa; NULL = aprovado 1:1", () => {
  verificarFatorAprovado(null, 1, "X");
  verificarFatorAprovado(undefined, 1, "X");
  // Codex P0 (#2166): NULL aprovado + vivo 0,2 = o comprador aprovou 36 L sem embalagem; recusar, não normalizar.
  const a = assertLanca(() => verificarFatorAprovado(null, 0.2, "TEH.3505.00BB"), FatorAprovadoDivergenteError, "NULL→0,2");
  assertEquals(a.motivo, "fator_aprovado_ausente", "marca do ramo AUSENTE");
  assertEquals(a.fatorAprovado, null, "aprovado null");
  assertLanca(() => verificarFatorAprovado(undefined, 0.18, "X"), FatorAprovadoDivergenteError, "undefined→0,18");
  verificarFatorAprovado("0.20000000", 0.2, "X"); // numeric do PostgREST chega como string
  verificarFatorAprovado("0.2777777777777778", 0.2777777777777778, "X"); // mesmo numeric → mesmo Number
  assertLanca(() => verificarFatorAprovado(0.2, 0.2000000009, "X"), FatorAprovadoDivergenteError, "Δ 9e-10 = 201 vs 200 BB em 1.000 L");
  const d = assertLanca(() => verificarFatorAprovado(0.2, 0.18, "TEH.3505.00BB"), FatorAprovadoDivergenteError, "0,2→0,18");
  assertEquals(d.sku, "TEH.3505.00BB", "sku");
  assertEquals(d.fatorAprovado, 0.2, "aprovado");
  assertEquals(d.fatorVivo, 0.18, "vivo");
  assertEquals(d.motivo, "fator_aprovado_divergente", "marca do ramo DIVERGENTE");
  assertEquals(d.message.includes("0.18") && d.message.includes("0.2") && /reaprov/i.test(d.message), true, "motivo visível");
  for (const ruim of [0, -0.2, Number.NaN, 1e9, "abc", ""]) {
    assertLanca(() => verificarFatorAprovado(ruim, 0.2, "X"), FatorAprovadoDivergenteError, `aprovado inválido ${String(ruim)}`);
  }
});

Deno.test("indexarMapeamentos: >1 ativa por sku_omie é ambiguidade (nunca last-wins); ativa vence inativa", () => {
  type Row = { sku_omie: string; ativo: boolean | null; fator_conversao: number };
  const ativa: Row = { sku_omie: "A", ativo: true, fator_conversao: 0.2 };
  const inativa: Row = { sku_omie: "A", ativo: false, fator_conversao: 1 };
  assertEquals(indexarMapeamentos([inativa, ativa]).get("A"), ativa, "ativa vence (inativa primeiro)");
  assertEquals(indexarMapeamentos([ativa, inativa]).get("A"), ativa, "ativa vence (ativa primeiro)");
  assertEquals(indexarMapeamentos([inativa]).get("A"), inativa, "só inativa fica (chamador recusa por 'sem mapeamento ativo')");
  const amb = assertLanca(
    () => indexarMapeamentos([ativa, { sku_omie: "A", ativo: true, fator_conversao: 1 }]),
    MapeamentoAmbiguoError,
    "2 ativas",
  );
  assertEquals(amb.sku, "A", "sku ambíguo");
  assertEquals(amb.n, 2, "contagem");
});

Deno.test("qtdePortalCanonica: enviado = aprovado — qtde fora do múltiplo recusa (Codex P0 #2166: 37 L com 0,2)", () => {
  assertEquals(qtdePortalCanonica(40, 0.2, "X"), 8, "40 L = 8 BB");
  assertEquals(qtdePortalCanonica(37, 1, "X"), 37, "fator 1 inteiro");
  assertEquals(qtdePortalCanonica(10.8, 1 / 3.6, "X"), 3, "round6 segue trabalhando");
  const d = assertLanca(() => qtdePortalCanonica(37, 0.2, "TEH.3505.00BB"), QtdeNaoMultiploEmbalagemError, "37 L");
  assertEquals(d.sku, "TEH.3505.00BB", "sku");
  assertEquals(d.qtdeFinal, 37, "qtde aprovada");
  assertEquals(d.qtdePortal, 8, "qtde portal");
  assertEquals(d.qtdeFisica, 40, "qtde física");
  assertEquals(d.message.includes("37") && d.message.includes("40") && /reaprov/i.test(d.message), true, "motivo visível");
  for (const [q, f] of [[36, 0.2], [0, 0.2], [0, 1], [36.5, 1], [3.99996, 1], [41, 0.2], [-5, 1]] as const) {
    assertLanca(() => qtdePortalCanonica(q, f, "X"), QtdeNaoMultiploEmbalagemError, `${q} × ${f}`);
  }
  assertLancaFator(() => qtdePortalCanonica(40, 0, "X"), "fator 0 continua sendo a marca do FATOR");
  assertLancaFator(() => qtdePortalCanonica(Number.NaN, 0.2, "X"), "qtde NaN idem");
});
