// Testa o CÓDIGO REAL de transcricao.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/analyze-unified-order/
//
// Foco: (1) a leitura INTEIRA do catálogo/perfis passa da página de 1.000 (o defeito era o
// `.limit(1000)` silencioso) e falha de leitura LANÇA em vez de virar "nenhum casou"; (2) o
// ranking corta por RELEVÂNCIA ao item, não pela ordem alfabética; (3) a transcrição malformada
// é recusada, não lida como "foto vazia".
import { FalhaLeituraCritica } from "../_shared/leitura-critica.ts";
import type { BancoPostgrest } from "../_shared/paginate.ts";
import {
  carregarCatalogoAtivo,
  carregarPerfis,
  interpretarTranscricao,
  normalizar,
  type PerfilMinimo,
  type ProdutoCatalogoMinimo,
  rankearClientes,
  rankearProdutos,
  termos,
} from "./transcricao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

async function assertRejeitaCom(p: Promise<unknown>, codigo: string) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof FalhaLeituraCritica)) throw new Error(`esperava FalhaLeituraCritica, veio ${e}`);
    assertEquals(e.codigo, codigo, "código da falha");
    return;
  }
  throw new Error("esperava rejeição, resolveu");
}

// ── Banco de memória com o contrato do PostgREST que o keyset usa ────────────
// Aplica eq/gt/order/limit de VERDADE sobre as linhas e capa cada resposta em `cap` (o
// max-rows do PostgREST), para o teste reproduzir o corte silencioso de prod.
function bancoFake(
  tabelas: Record<string, Record<string, unknown>[]>,
  opts: { cap?: number; erroNaChamada?: number } = {},
): { db: BancoPostgrest; chamadas: () => number } {
  let chamadas = 0;
  const cap = opts.cap ?? 1000;
  const db = {
    from(tabela: string) {
      const filtros: ((l: Record<string, unknown>) => boolean)[] = [];
      let ordem: string | null = null;
      let lim = Infinity;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        gt: (c: string, v: unknown) => (filtros.push((l) => String(l[c]) > String(v)), q),
        order: (c: string) => ((ordem = c), q),
        limit: (n: number) => ((lim = n), q),
        then(res: (r: unknown) => unknown, rej?: (e: unknown) => unknown) {
          chamadas++;
          if (opts.erroNaChamada === chamadas) {
            return Promise.resolve({ data: null, error: { message: "boom", code: "57014" } }).then(res, rej);
          }
          let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
          if (ordem) {
            const o = ordem;
            linhas = [...linhas].sort((a, b) => (String(a[o]) < String(b[o]) ? -1 : 1));
          }
          return Promise.resolve({ data: linhas.slice(0, Math.min(lim, cap)), error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return { db: db as unknown as BancoPostgrest, chamadas: () => chamadas };
}

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function produto(n: number, descricao: string, codigo = `P${n}`, ativo = true) {
  return { id: id(n), codigo, descricao, account: "oben", valor_unitario: 1, estoque: 0, ativo };
}

Deno.test("catálogo: lê INTEIRO além da página de 1.000 e só os ativos (era .limit(1000))", async () => {
  const linhas = Array.from({ length: 3223 }, (_, i) => produto(i + 1, `ITEM ${i + 1}`));
  linhas.push(produto(9999, "INATIVO", "X", false));
  const { db } = bancoFake({ omie_products: linhas });
  const cat = await carregarCatalogoAtivo(db);
  assertEquals(cat.length, 3223, "todas as linhas ativas");
  assertEquals(cat.some((p) => p.descricao === "INATIVO"), false, "inativo fora");
  // CONTROLE: o banco fake capa mesmo — uma leitura single-shot veria só 1.000.
  const { db: db2 } = bancoFake({ omie_products: linhas });
  const unica = await (db2.from("omie_products").select("*").eq("ativo", true).order("id").limit(5000));
  assertEquals(unica.data?.length, 1000, "controle: o cap do fake reproduz o corte de prod");
});

Deno.test("perfis: lê os 5.668 (era .limit(1000) = 18%)", async () => {
  const linhas = Array.from({ length: 5668 }, (_, i) => ({ user_id: id(i + 1), name: `Cliente ${i}`, document: null }));
  const { db } = bancoFake({ profiles: linhas });
  assertEquals((await carregarPerfis(db)).length, 5668);
});

Deno.test("falha de leitura LANÇA com o código do PostgREST — nunca lista vazia/parcial", async () => {
  const linhas = Array.from({ length: 2500 }, (_, i) => produto(i + 1, `ITEM ${i}`));
  // Falha na 2ª página: o acumulado PARCIAL (1.000) não pode voltar como se fosse o catálogo.
  const { db } = bancoFake({ omie_products: linhas }, { erroNaChamada: 2 });
  await assertRejeitaCom(carregarCatalogoAtivo(db), "57014");
  const { db: dbP } = bancoFake({ profiles: [] }, { erroNaChamada: 1 });
  await assertRejeitaCom(carregarPerfis(dbP), "57014");
});

Deno.test("ranking: o produto certo entra mesmo FORA dos 1.000 primeiros em ordem alfabética", () => {
  // 1.500 'AAA…' antes do alvo na ordem de descrição — o `.order(descricao).limit(1000)` o perdia.
  const catalogo: ProdutoCatalogoMinimo[] = Array.from(
    { length: 1500 },
    (_, i) => produto(i + 1, `AAA GENERICO ${i}`),
  );
  catalogo.push(produto(5000, "LIXA FOLHA GRAO 120 NORTON", "FO05.6717"));
  catalogo.push(produto(5001, "LIXA FOLHA GRAO 220 NORTON", "FO05.6718"));
  const r = rankearProdutos([{ descricao: "lixa grão 120 norton", codigo: null }], catalogo);
  assertEquals(r.candidatos[0]?.id, id(5000), "o 120 vence o 220 (palavra inteira com dígito)");
  assertEquals(r.semCandidato, 0);
});

Deno.test("ranking: código transcrito sem pontuação casa (FO056717 ≡ FO05.6717)", () => {
  const catalogo = [produto(1, "SELADORA X", "FO05.6717"), produto(2, "SELADORA Y", "FO05.9999")];
  const r = rankearProdutos([{ descricao: "", codigo: "FO056717" }], catalogo);
  assertEquals(r.candidatos.map((p) => p.id), [id(1)]);
});

Deno.test("ranking: top-K por item, união deduplicada, item sem candidato contado", () => {
  const catalogo = Array.from({ length: 30 }, (_, i) => produto(i + 1, `THINNER ${i}`));
  const r = rankearProdutos(
    [{ descricao: "thinner", codigo: null }, { descricao: "thinner", codigo: null }, { descricao: "zzzz", codigo: null }],
    catalogo,
    8,
  );
  assertEquals(r.candidatos.length, 8, "8 por item, o 2º item repete os mesmos — sem duplicata");
  assertEquals(r.semCandidato, 1, "o 'zzzz' não tem candidato");
});

Deno.test("clientes: ranqueia pelo nome transcrito, ignora genéricos e exclui o vendedor", () => {
  const perfis: PerfilMinimo[] = [
    { user_id: "u1", name: "Marcenaria Silva Ltda", document: "1" },
    { user_id: "u2", name: "Comércio Souza Ltda", document: "2" },
    { user_id: "vend", name: "Silva Vendedor", document: null },
  ];
  assertEquals(rankearClientes("MARCENARIA SILVA LTDA", perfis, "vend").map((p) => p.user_id), ["u1"]);
  assertEquals(rankearClientes(null, perfis, "vend"), [], "sem nome na foto → sem candidato");
  assertEquals(rankearClientes("Ltda", perfis, "vend"), [], "só genérico → sem candidato (não casa todo mundo)");
});

Deno.test("transcrição: malformada é RECUSADA (null), vazia é legítima, item oco descartado", () => {
  assertEquals(interpretarTranscricao(null), null);
  assertEquals(interpretarTranscricao({ cliente: "X" }), null, "sem `itens` = malformada, não 'foto vazia'");
  assertEquals(interpretarTranscricao({ cliente: " ", itens: [] }), { cliente: null, itens: [] });
  assertEquals(
    interpretarTranscricao({ cliente: "Ana", itens: [{ descricao: " cola ", codigo: "" }, { descricao: "", codigo: null }, 7] }),
    { cliente: "Ana", itens: [{ descricao: "cola", codigo: null }] },
  );
});

Deno.test("normalização: acento e pontuação não separam termo de catálogo", () => {
  assertEquals(normalizar("Grão-120, LIXA"), "grao 120 lixa");
  assertEquals(termos("lixa p80 com 3m de"), ["lixa", "p80", "3m"]);
});
