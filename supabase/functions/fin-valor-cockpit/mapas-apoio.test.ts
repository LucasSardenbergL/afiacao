// Testa as leituras de apoio da fin-valor-cockpit (plano v5, lote 5 — VAL-IO).
// Rodar: deno test --no-remote supabase/functions/fin-valor-cockpit/mapas-apoio.test.ts
//
// Asserts LOCAIS de propósito (`deno test --no-remote` no CI): nada de import remoto em teste de edge.
import { carregarMapasApoio } from "./mapas-apoio.ts";
import { FalhaLeituraCritica, type ErroPostgrest } from "../_shared/leitura-critica.ts";

function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg ?? "assert falhou");
}

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// Exige rejeição, a CLASSE e a FONTE — "rejeitou com qualquer coisa" passaria com um TypeError.
async function assertRejeitaFalha(p: Promise<unknown>, fonte: string) {
  try {
    await p;
  } catch (e) {
    assert(e instanceof FalhaLeituraCritica, `esperava FalhaLeituraCritica, veio ${e}`);
    assertEquals(e.fonte, fonte, `fonte errada: ${e.fonte}`);
    return;
  }
  throw new Error("esperava rejeição, resolveu");
}

type Resp<T> = { data: T[] | null; error: ErroPostgrest | null };

/** Fonte paginada em memória: devolve `linhas` fatiadas por range, opcionalmente presa num portão. */
function fonte<T>(linhas: T[], opts: { portao?: Promise<void>; inicio?: string[]; nome?: string; erro?: ErroPostgrest } = {}) {
  return (de: number, ate: number): Promise<Resp<T>> => {
    if (opts.inicio && opts.nome && de === 0) opts.inicio.push(opts.nome);
    const responder = (): Resp<T> =>
      opts.erro ? { data: null, error: opts.erro } : { data: linhas.slice(de, ate + 1), error: null };
    return opts.portao ? opts.portao.then(responder) : Promise.resolve(responder());
  };
}

const linhas = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ id: `${p}-${i}` }));

Deno.test("as 4 leituras COMEÇAM antes de qualquer uma terminar (em série, só a 1ª teria começado)", async () => {
  let abrir!: () => void;
  const portao = new Promise<void>((r) => (abrir = r));
  const inicio: string[] = [];
  const pendente = carregarMapasApoio({
    clientes: fonte(linhas(1, "c"), { portao, inicio, nome: "clientes" }),
    profiles: fonte(linhas(1, "p"), { portao, inicio, nome: "profiles" }),
    custos: fonte(linhas(1, "k"), { portao, inicio, nome: "custos" }),
    estoque: fonte(linhas(1, "e"), { portao, inicio, nome: "estoque" }),
  });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals([...inicio].sort(), ["clientes", "custos", "estoque", "profiles"]);
  abrir();
  const r = await pendente;
  assertEquals([r.clientes.length, r.profiles.length, r.custos.length, r.estoque.length], [1, 1, 1, 1]);
});

Deno.test("paginação preservada: fonte com 2.345 linhas volta inteira, e cada mapa vem da SUA fonte", async () => {
  const r = await carregarMapasApoio({
    clientes: fonte(linhas(3, "c")),
    profiles: fonte(linhas(2345, "p")),
    custos: fonte(linhas(1000, "k")),
    estoque: fonte(linhas(0, "e")),
  });
  assertEquals(r.profiles.length, 2345);
  assertEquals(r.profiles[2344], { id: "p-2344" });
  assertEquals(r.custos.length, 1000);
  assertEquals(r.clientes.map((c) => c.id), ["c-0", "c-1", "c-2"]);
  assertEquals(r.estoque, []);
});

Deno.test("falha integral: uma leitura que falha rejeita o conjunto com a fonte certa — nada volta vazio", async () => {
  const timeout: ErroPostgrest = { message: "canceling statement due to statement timeout", code: "57014" };
  const ok = <T>(x: T[]) => fonte(x);
  await assertRejeitaFalha(
    carregarMapasApoio({ clientes: ok(linhas(1, "c")), profiles: fonte([], { erro: timeout }), custos: ok(linhas(1, "k")), estoque: ok(linhas(1, "e")) }),
    "profiles",
  );
  await assertRejeitaFalha(
    carregarMapasApoio({ clientes: ok(linhas(1, "c")), profiles: ok(linhas(1, "p")), custos: ok(linhas(1, "k")), estoque: fonte([], { erro: timeout }) }),
    "inventory_position",
  );
  await assertRejeitaFalha(
    carregarMapasApoio({ clientes: fonte([], { erro: timeout }), profiles: ok(linhas(1, "p")), custos: ok(linhas(1, "k")), estoque: ok(linhas(1, "e")) }),
    "omie_customer_account_map_fresco",
  );
  await assertRejeitaFalha(
    carregarMapasApoio({ clientes: ok(linhas(1, "c")), profiles: ok(linhas(1, "p")), custos: fonte([], { erro: timeout }), estoque: ok(linhas(1, "e")) }),
    "product_costs",
  );
});

Deno.test("falha na 2ª PÁGINA também derruba o conjunto (não devolve a 1ª página como se fosse tudo)", async () => {
  const base = linhas(1500, "p");
  const quebraNaSegunda = (de: number, ate: number): Promise<Resp<{ id: string }>> =>
    Promise.resolve(de === 0 ? { data: base.slice(de, ate + 1), error: null } : { data: null, error: { message: "x", code: "57014" } });
  await assertRejeitaFalha(
    carregarMapasApoio({ clientes: fonte(linhas(1, "c")), profiles: quebraNaSegunda, custos: fonte(linhas(1, "k")), estoque: fonte(linhas(1, "e")) }),
    "profiles",
  );
});
