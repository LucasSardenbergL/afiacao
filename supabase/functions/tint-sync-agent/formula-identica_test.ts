// formula-identica_test.ts — o reenvio idêntico de /formulas não abre run.
// Roda no CI via `bun run test:edges` (deno test --no-remote) — SEM import remoto.
//
// Money-path: o ack sem run SÓ pode sair com a fórmula idêntica em tudo que a promoção usa. Uma fórmula
// diferente que caísse aqui seria cacheada pelo conector (hash no 200) e nunca gravada — o dado some calado.
// O CONTROLE é a linha real da ERVA MATE (prod, 2026-10-27): ele tem de dar true, senão a entrega não corta nada.
import { ackSemRun } from "./catalogo-vazio.ts";
import {
  COLUNAS_HEADER,
  formulaIdentica,
  type ItemStaging,
  type LinhaStaging,
  loteElegivel,
  MAX_FORMULAS_CHECADAS,
  SELECT_ULTIMA,
  ultimaDaChave,
} from "./formula-identica.ts";
import type { TintFormulaPayload } from "./staging-rows.ts";

function assertEq(atual: unknown, esperado: unknown, msg: string) {
  if (JSON.stringify(atual) !== JSON.stringify(esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}

const ACC = "colacor";
const LOJA = "loja-1";

/** O payload como o conector manda (raw_data da última staging da ERVA MATE, 2026-10-27 13:45 UTC). */
function payload(): TintFormulaPayload {
  return {
    itens: [
      { ordem: 1, qtd_ml: 1.54, id_corante: "1" },
      { ordem: 2, qtd_ml: 1.001, id_corante: "3" },
      { ordem: 3, qtd_ml: 2.464, id_corante: "4" },
      { ordem: 4, qtd_ml: 36.197, id_corante: "8" },
      { ordem: 5, qtd_ml: 0.231, id_corante: "11" },
    ],
    cor_id: "ERVA MATE SUVINIL",
    id_base: "20",
    nome_cor: "ERVA MATE SUVINIL",
    cod_produto: "FO20.6501",
    id_embalagem: "1",
    personalizada: true,
    volume_final_ml: 810,
  };
}

/** A linha de staging como o PostgREST a devolve (chaves do raw_data na ordem do jsonb). */
function ultima(): LinhaStaging {
  const p = payload();
  return {
    id: "9011fa25-3d67-45a3-9137-12a9852d8eed",
    sync_run_id: "80b5c111-0398-4a70-8c3a-8e9a0cf286cc",
    created_at: "2026-10-27T13:45:17.649149+00:00",
    raw_data: {
      itens: p.itens!.map((i) => ({ ordem: i.ordem, qtd_ml: i.qtd_ml, id_corante: i.id_corante })),
      cor_id: p.cor_id,
      id_base: p.id_base,
      nome_cor: p.nome_cor,
      cod_produto: p.cod_produto,
      id_embalagem: p.id_embalagem,
      personalizada: p.personalizada,
      volume_final_ml: p.volume_final_ml,
    },
    cor_id: "ERVA MATE SUVINIL",
    nome_cor: "ERVA MATE SUVINIL",
    cod_produto: "FO20.6501",
    id_base: "20",
    id_embalagem: "1",
    subcolecao: null,
    volume_final_ml: 810,
    preco_final: null,
    personalizada: true,
    expected_item_count: 5,
    is_base_pura: null,
  };
}

/** Os itens gravados, em ordem de retorno arbitrária (o PostgREST não garante ordem sem .order). */
function itens(): ItemStaging[] {
  return [
    { id_corante: "8", ordem: 4, qtd_ml: 36.197 },
    { id_corante: "1", ordem: 1, qtd_ml: 1.54 },
    { id_corante: "11", ordem: 5, qtd_ml: 0.231 },
    { id_corante: "3", ordem: 2, qtd_ml: 1.001 },
    { id_corante: "4", ordem: 3, qtd_ml: 2.464 },
  ];
}

function identica(f = payload(), u = ultima(), it = itens(), st: unknown = "promovido") {
  return formulaIdentica(f, ACC, LOJA, u, it, st);
}

Deno.test("CONTROLE: o reenvio real da ERVA MATE é idêntico → ack sem run", () => {
  assertEq(identica(), true, "controle");
});

Deno.test("CADA campo do payload diferente → caminho normal", () => {
  const mutacoes: Record<string, (f: TintFormulaPayload) => void> = {
    nome_cor: (f) => (f.nome_cor = "ERVA MATE"),
    id_embalagem: (f) => (f.id_embalagem = "2"),
    volume_final_ml: (f) => (f.volume_final_ml = 3600),
    preco_final: (f) => (f.preco_final = 99.9),
    is_base_pura: (f) => (f.is_base_pura = true),
    subcolecao: (f) => (f.subcolecao = "SL"),
    personalizada: (f) => (f.personalizada = false),
    cor_id: (f) => (f.cor_id = "ERVA MATE SUVINIL "),
    cod_produto: (f) => (f.cod_produto = "FO20.6502"),
    id_base: (f) => (f.id_base = "21"),
    "item: ordem": (f) => (f.itens![0].ordem = 9),
    "item: corante": (f) => (f.itens![0].id_corante = "2"),
    "item: qtd": (f) => (f.itens![3].qtd_ml = 36.198),
    "item: qtd null": (f) => (f.itens![3].qtd_ml = null),
    "item a mais": (f) => f.itens!.push({ ordem: 6, qtd_ml: 0.1, id_corante: "12" }),
    "item a menos": (f) => f.itens!.pop(),
    "itens ausente": (f) => delete f.itens,
    "itens vazio": (f) => (f.itens = []),
    "campo novo no payload": (f) => ((f as Record<string, unknown>).id_colecao = "7"),
  };
  for (const [nome, mutar] of Object.entries(mutacoes)) {
    const f = payload();
    mutar(f);
    assertEq(identica(f), false, nome);
  }
});

Deno.test("raw_data igual, mas coluna gravada diferente (edge antiga) → caminho normal", () => {
  for (const col of COLUNAS_HEADER) {
    const u = ultima();
    u[col] = col === "personalizada" ? false : col === "expected_item_count" ? 4 : "outro";
    assertEq(identica(payload(), u), false, `coluna ${col}`);
  }
  const u = ultima();
  u.expected_item_count = null;
  assertEq(identica(payload(), u), false, "expected_item_count null gravado");
});

Deno.test("itens gravados diferentes do payload → caminho normal", () => {
  const mutacoes: Record<string, (it: ItemStaging[]) => ItemStaging[]> = {
    "item faltando (insert parcial)": (it) => it.slice(1),
    "item sobrando": (it) => [...it, { id_corante: "12", ordem: 6, qtd_ml: 0.1 }],
    "qtd gravada diferente": (it) => it.map((i) => (i.id_corante === "8" ? { ...i, qtd_ml: 36.2 } : i)),
    "corante gravado vazio": (it) => it.map((i) => (i.id_corante === "8" ? { ...i, id_corante: "" } : i)),
    "ordem gravada null": (it) => it.map((i) => (i.id_corante === "8" ? { ...i, ordem: null } : i)),
    "duplicado no lugar de outro": (it) => [...it.slice(1), it[1]],
    "nenhum item": () => [],
  };
  for (const [nome, mutar] of Object.entries(mutacoes)) {
    assertEq(identica(payload(), ultima(), mutar(itens())), false, nome);
  }
});

Deno.test("run da última staging não promovido → caminho normal", () => {
  for (const st of ["pendente", "erro", null, undefined, "PROMOVIDO", ""]) {
    // Direto, sem o helper: o default do parâmetro engoliria o `undefined`.
    assertEq(formulaIdentica(payload(), ACC, LOJA, ultima(), itens(), st), false, `promocao_status ${String(st)}`);
  }
});

Deno.test("raw_data: ordem de chave é irrelevante, ausente ≠ null", () => {
  const u = ultima();
  u.raw_data = JSON.parse(JSON.stringify(payload())); // outra ordem de chaves
  assertEq(identica(payload(), u), true, "ordem de chave");
  const f = payload();
  f.preco_final = null as unknown as number; // null explícito no payload, ausente no raw_data gravado
  assertEq(identica(f), false, "null explícito vs ausente");
  const u2 = ultima();
  (u2.raw_data as Record<string, unknown>).extra = null;
  assertEq(identica(payload(), u2), false, "raw_data com chave a mais");
});

Deno.test("ultimaDaChave: 1ª linha (DESC) da MESMA COALESCE(subcolecao,'')", () => {
  const l = (id: string, subcolecao: string | null) => ({ ...ultima(), id, subcolecao });
  const desc = [l("a", "SL"), l("b", null), l("c", ""), l("d", "SL")];
  assertEq(ultimaDaChave(desc, payload())?.id, "b", "sem subcoleção pega a mais recente null/''");
  assertEq(ultimaDaChave([l("c", ""), l("b", null)], payload())?.id, "c", "'' e null são a mesma chave");
  assertEq(ultimaDaChave(desc, { ...payload(), subcolecao: "SL" })?.id, "a", "com subcoleção");
  assertEq(ultimaDaChave(desc, { ...payload(), subcolecao: "XX" }), null, "subcoleção fora da janela");
  assertEq(ultimaDaChave([], payload()), null, "sem staging da chave");
});

Deno.test("loteElegivel: só 1..MAX fórmulas, todas com os campos obrigatórios", () => {
  assertEq(loteElegivel([payload()]), true, "1 fórmula");
  assertEq(loteElegivel(Array.from({ length: MAX_FORMULAS_CHECADAS }, payload)), true, "no teto");
  assertEq(loteElegivel(Array.from({ length: MAX_FORMULAS_CHECADAS + 1 }, payload)), false, "acima do teto");
  assertEq(loteElegivel([]), false, "vazio");
  assertEq(loteElegivel(undefined), false, "ausente");
  assertEq(loteElegivel({ 0: payload() }), false, "não-array");
  assertEq(loteElegivel([payload(), null]), false, "item null");
  for (const campo of ["cor_id", "cod_produto", "id_base", "id_embalagem"] as const) {
    const f = payload();
    delete f[campo];
    assertEq(loteElegivel([payload(), f]), false, `sem ${campo}`);
  }
});

Deno.test("select da última staging traz o run, a ordem e todas as colunas comparadas", () => {
  const cols = SELECT_ULTIMA.split(", ");
  for (const c of ["id", "sync_run_id", "created_at", "raw_data", ...COLUNAS_HEADER]) {
    assertEq(cols.includes(c), true, `coluna ${c}`);
  }
});

Deno.test("ack do reenvio: ok, sem erro, sem run — o que o conector confere para cachear o hash", () => {
  const a = ackSemRun("chave-1", "fórmula idêntica à última staging da chave", 1);
  assertEq(
    [a.ok, a.error_count, a.errors, a.sync_run_id, a.batch_id, a.received_count, a.ignored_count],
    [true, 0, [], null, "chave-1", 1, 1],
    "ack",
  );
});
