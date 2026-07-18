// Testa o CÓDIGO REAL de `montarRelatorios` (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/relatorio-mensal_test.ts
//
// Os dois testes do bloco "INVARIANTES DE CUSTO" são a razão deste arquivo existir: eles
// ficam VERMELHOS na implementação N+1 que vivia na edge (uma consulta a `user_tools` por
// perfil + 2 counts por ferramenta ⇒ ~5.280 idas ao banco em prod, página em spinner
// indefinido e cron mensal ameaçado pelo timeout de 150s).
import {
  type BancoPostgrest,
  montarRelatorios,
  type QueryPostgrest,
  type RespostaPostgrest,
} from "./relatorio-mensal.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

type Linha = Record<string, unknown>;

// Banco de memória fiel aos dois comportamentos do PostgREST que importam aqui:
//  (1) conta cada ida ao banco (round-trip), para o invariante de custo;
//  (2) CAPA em 1000 linhas, em silêncio, quando o call-site não usa `.range()`
//      (docs/agent/database.md; o mesmo footgun que `_shared/paginate.ts` previne).
// `erroDoBanco` faz toda consulta falhar — para provar que o erro PROPAGA em vez de virar zero.
function bancoFake(tabelas: Record<string, Linha[]>, erroDoBanco?: string) {
  const idas: string[] = [];

  function query(tabela: string): QueryPostgrest<Linha> {
    let linhas = [...(tabelas[tabela] ?? [])];
    let contarSemCorpo = false;
    let usouRange = false;

    const q: QueryPostgrest<Linha> = {
      select(_colunas, opts) {
        if (opts?.head) contarSemCorpo = true;
        return q;
      },
      eq(coluna, valor) {
        linhas = linhas.filter((l) => l[coluna] === valor);
        return q;
      },
      in(coluna, valores) {
        const alvo = new Set(valores);
        linhas = linhas.filter((l) => alvo.has(l[coluna]));
        return q;
      },
      order(coluna, opts) {
        // Textual: as colunas de ordenação aqui são ids, e `unknown` não compara com `<`.
        const asc = opts?.ascending !== false;
        linhas.sort((a, b) => {
          const x = String(a[coluna] ?? "");
          const y = String(b[coluna] ?? "");
          return x < y ? (asc ? -1 : 1) : x > y ? (asc ? 1 : -1) : 0;
        });
        return q;
      },
      range(de, ate) {
        usouRange = true;
        linhas = linhas.slice(de, ate + 1);
        return q;
      },
      then(aoResolver) {
        idas.push(tabela);
        // O cap silencioso: sem `.range()` explícito, a cauda além de 1000 some sem erro.
        const corpo = usouRange ? linhas : linhas.slice(0, 1000);
        const resposta: RespostaPostgrest<Linha> = erroDoBanco
          ? { data: null, error: { message: erroDoBanco } }
          : contarSemCorpo
          ? { data: null, count: corpo.length, error: null }
          : { data: corpo, error: null };
        return Promise.resolve(resposta).then(aoResolver);
      },
    };
    return q;
  }

  return {
    banco: {
      // Duplo cast do TEST DOUBLE: `query` devolve sempre `QueryPostgrest<Linha>`, que não
      // satisfaz sozinho o `from<T>` genérico da interface real.
      from: <T>(tabela: string) => query(tabela) as unknown as QueryPostgrest<T>,
    } as BancoPostgrest,
    idas: () => idas,
    idasA: (tabela: string) => idas.filter((t) => t === tabela).length,
  };
}

const AGORA = new Date("2026-07-18T12:00:00Z");

function perfil(user_id: string, extra: Linha = {}): Linha {
  return { user_id, name: `Cliente ${user_id}`, email: null, phone: null, ...extra };
}

function ferramenta(id: string, user_id: string, extra: Linha = {}): Linha {
  return {
    id,
    user_id,
    internal_code: null,
    generated_name: `Ferramenta ${id}`,
    custom_name: null,
    last_sharpened_at: null,
    next_sharpening_due: null,
    tool_categories: null,
    ...extra,
  };
}

// ── CONTRATO: o que o relatório entrega ─────────────────────────────────────

Deno.test("só entra no relatório quem TEM ferramenta", async () => {
  const f = bancoFake({
    profiles: [perfil("u1"), perfil("u2"), perfil("u3")],
    user_tools: [ferramenta("t1", "u2")],
    tool_events: [],
  });
  const rel = await montarRelatorios(f.banco, { agora: AGORA });
  assertEquals(rel.map((r) => r.user_id), ["u2"]);
  assertEquals(rel[0].total_tools, 1);
});

Deno.test("conta afiações e anomalias por ferramenta, ignorando outros tipos de evento", async () => {
  const f = bancoFake({
    profiles: [perfil("u1")],
    user_tools: [ferramenta("t1", "u1"), ferramenta("t2", "u1")],
    tool_events: [
      { id: "e1", user_tool_id: "t1", event_type: "sharpening" },
      { id: "e2", user_tool_id: "t1", event_type: "sharpening" },
      { id: "e3", user_tool_id: "t1", event_type: "anomaly" },
      { id: "e4", user_tool_id: "t2", event_type: "sharpening" },
      { id: "e5", user_tool_id: "t1", event_type: "inspection" }, // tipo alheio: não conta
    ],
  });
  const rel = await montarRelatorios(f.banco, { agora: AGORA });
  const porNome = Object.fromEntries(rel[0].tools.map((t) => [t.name, t]));
  assertEquals(porNome["Ferramenta t1"].sharpening_count, 2);
  assertEquals(porNome["Ferramenta t1"].anomaly_count, 1);
  assertEquals(porNome["Ferramenta t2"].sharpening_count, 1);
  assertEquals(porNome["Ferramenta t2"].anomaly_count, 0);
});

Deno.test("ferramenta sem evento nenhum conta zero (ausência real, não fabricação)", async () => {
  const f = bancoFake({
    profiles: [perfil("u1")],
    user_tools: [ferramenta("t1", "u1")],
    tool_events: [],
  });
  const rel = await montarRelatorios(f.banco, { agora: AGORA });
  assertEquals(rel[0].tools[0].sharpening_count, 0);
  assertEquals(rel[0].tools[0].anomaly_count, 0);
});

Deno.test("classifica atrasada / em breve / em dia e ordena nessa prioridade", async () => {
  const f = bancoFake({
    profiles: [perfil("u1")],
    user_tools: [
      ferramenta("t_ok", "u1", { next_sharpening_due: "2026-09-01T12:00:00Z" }),
      ferramenta("t_breve", "u1", { next_sharpening_due: "2026-07-22T12:00:00Z" }),
      ferramenta("t_atrasada", "u1", { next_sharpening_due: "2026-07-10T12:00:00Z" }),
      ferramenta("t_sem_data", "u1", { next_sharpening_due: null }),
    ],
    tool_events: [],
  });
  const rel = await montarRelatorios(f.banco, { agora: AGORA });
  assertEquals(rel[0].tools.map((t) => t.name), [
    "Ferramenta t_atrasada",
    "Ferramenta t_breve",
    "Ferramenta t_ok",
    "Ferramenta t_sem_data",
  ]);
  assertEquals(rel[0].overdue_count, 1);
  assertEquals(rel[0].due_soon_count, 1);
  assertEquals(rel[0].tools[0].days_until_due, -8);
  // Sem data de vencimento não é atrasada nem "em breve" — degrada para null, não para zero.
  const semData = rel[0].tools[3];
  assertEquals(semData.days_until_due, null);
  assertEquals([semData.is_overdue, semData.is_due_soon], [false, false]);
});

Deno.test("userIdAlvo restringe o relatório a um cliente", async () => {
  const f = bancoFake({
    profiles: [perfil("u1"), perfil("u2")],
    user_tools: [ferramenta("t1", "u1"), ferramenta("t2", "u2")],
    tool_events: [],
  });
  const rel = await montarRelatorios(f.banco, { agora: AGORA, userIdAlvo: "u2" });
  assertEquals(rel.map((r) => r.user_id), ["u2"]);
  assertEquals(rel[0].tools.map((t) => t.name), ["Ferramenta t2"]);
});

Deno.test("nome da ferramenta: generated_name → custom_name → categoria → fallback", async () => {
  const f = bancoFake({
    profiles: [perfil("u1")],
    user_tools: [
      ferramenta("t1", "u1", { generated_name: "Gerado" }),
      ferramenta("t2", "u1", { generated_name: null, custom_name: "Customizado" }),
      ferramenta("t3", "u1", {
        generated_name: null,
        custom_name: null,
        tool_categories: { name: "Serra" },
      }),
      ferramenta("t4", "u1", { generated_name: null, custom_name: null }),
    ],
    tool_events: [],
  });
  const rel = await montarRelatorios(f.banco, { agora: AGORA });
  assertEquals(rel[0].tools.map((t) => t.name).sort(), [
    "Customizado",
    "Ferramenta",
    "Gerado",
    "Serra",
  ]);
});

// ── INVARIANTES DE CUSTO: o que esta unidade existe para proteger ───────────

Deno.test("custo de banco NÃO cresce com o tamanho da base de clientes", async () => {
  // Proporção real medida em prod (2026-07-18): 5.276 perfis, 4 ferramentas, 2 donos.
  const perfis = Array.from({ length: 5276 }, (_, i) => perfil(`u${i}`));
  const f = bancoFake({
    profiles: perfis,
    user_tools: [
      ferramenta("t1", "u2495"),
      ferramenta("t2", "u2495"),
      ferramenta("t3", "u4700"),
      ferramenta("t4", "u4700"),
    ],
    tool_events: [],
  });

  const rel = await montarRelatorios(f.banco, { agora: AGORA });
  assertEquals(rel.length, 2, "os 2 donos de ferramenta têm de aparecer");

  // Um teto folgado: o certo são ~3 consultas (+ páginas). O N+1 fazia ~5.280 e estourava aqui.
  const total = f.idas().length;
  assert(
    total <= 10,
    `custo de banco deveria ser O(1) na base de clientes, mas foram ${total} idas ao banco ` +
      `(user_tools=${f.idasA("user_tools")}, tool_events=${f.idasA("tool_events")}, ` +
      `profiles=${f.idasA("profiles")})`,
  );
});

Deno.test("custo de banco NÃO cresce com o número de ferramentas (sem 2 counts por ferramenta)", async () => {
  const ferramentas = Array.from({ length: 300 }, (_, i) => ferramenta(`t${i}`, "u1"));
  const f = bancoFake({
    profiles: [perfil("u1")],
    user_tools: ferramentas,
    tool_events: ferramentas.flatMap((t, i) => [
      { id: `e${i}a`, user_tool_id: t.id, event_type: "sharpening" },
      { id: `e${i}b`, user_tool_id: t.id, event_type: "anomaly" },
    ]),
  });

  const rel = await montarRelatorios(f.banco, { agora: AGORA });
  assertEquals(rel[0].total_tools, 300);
  assertEquals(rel[0].tools.every((t) => t.sharpening_count === 1 && t.anomaly_count === 1), true);

  const emEventos = f.idasA("tool_events");
  assert(
    emEventos <= 3,
    `contagem de eventos deveria ser agregada, mas foram ${emEventos} consultas a tool_events ` +
      `(o N+1 fazia 2 por ferramenta = 600)`,
  );
});

Deno.test("dono de ferramenta além da linha 1000 NÃO some (cap silencioso do PostgREST)", async () => {
  // A leitura de `profiles` sem `.range()` devolve só as 1000 primeiras, sem erro. Se o
  // relatório partir dos perfis, o cliente na posição 4000 desaparece em silêncio.
  const perfis = Array.from({ length: 5000 }, (_, i) => perfil(`u${String(i).padStart(4, "0")}`));
  const f = bancoFake({
    profiles: perfis,
    user_tools: [ferramenta("t1", "u4000")],
    tool_events: [],
  });

  const rel = await montarRelatorios(f.banco, { agora: AGORA });
  assertEquals(
    rel.map((r) => r.user_id),
    ["u4000"],
    "o dono na posição 4000 sumiu — a leitura foi truncada pelo cap de 1000",
  );
});

Deno.test("erro do banco PROPAGA (fail-closed), não vira relatório vazio nem contagem zero", async () => {
  const f = bancoFake({
    profiles: [perfil("u1")],
    user_tools: [ferramenta("t1", "u1")],
    tool_events: [],
  }, "boom");

  let lancou = false;
  try {
    await montarRelatorios(f.banco, { agora: AGORA });
  } catch (e) {
    lancou = true;
    assert(
      (e as Error).message.includes("boom"),
      `erro deveria carregar a causa original, veio: ${(e as Error).message}`,
    );
  }
  assertEquals(lancou, true, "erro de banco não pode ser engolido — relatório mudo é pior que 500");
});
