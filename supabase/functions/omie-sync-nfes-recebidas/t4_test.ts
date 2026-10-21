// Testa o UPDATE REAL do t4 (t4.ts) contra um cliente que GRAVA a cadeia emitida — os predicados são os do
// código de produção, não uma reimplementação (Codex 2026-10-20, P2: o banco falso da revisita_test passava
// com cada guarda do UPDATE removida).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-nfes-recebidas/t4_test.ts
import { type ClienteT4, preencherT4PorChave } from "./t4.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${jb}, veio ${ja}`);
}

type Chamada = [string, ...unknown[]];

/** Cliente que registra cada consulta como lista de [método, ...args] e devolve `respostas` em ordem. */
function gravador(respostas: Array<{ data?: unknown[] | null; count?: number | null; error?: unknown }>) {
  const consultas: Chamada[][] = [];
  let i = 0;
  const cliente: ClienteT4 = {
    from(tabela: string) {
      const passos: Chamada[] = [["from", tabela]];
      consultas.push(passos);
      const resp = respostas[i++] ?? { data: [] };
      const q: Record<string, unknown> = {};
      for (const m of ["update", "select", "eq", "is", "neq", "not", "abortSignal"]) {
        q[m] = (...args: unknown[]) => {
          passos.push([m, ...args.map((a) => (a instanceof AbortSignal ? "<sinal>" : a))]);
          return q;
        };
      }
      q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve({ data: resp.data ?? null, count: resp.count ?? null, error: resp.error ?? null }).then(ok, ko);
      return q as unknown as ReturnType<ClienteT4["from"]>;
    },
  };
  return { cliente, consultas };
}

const sinal = () => AbortSignal.timeout(1000);
const CHAVE = "4".repeat(44);
const T4 = "2026-08-21T10:00:00-03:00";
const AGORA = "2026-10-21T04:15:00Z";

const filtrosComuns: Chamada[] = [
  ["eq", "empresa", "OBEN"],
  ["eq", "nfe_chave_acesso", CHAVE],
  ["is", "t4_data_recebimento", null],
  ["neq", "status", "CANCELADO"],
];

Deno.test("t4: UPDATE pela chave com o MESMO nid, depois pela chave com nid nulo (que ganha o nid), e conta divergentes", async () => {
  const g = gravador([{ data: [{ id: "a" }] }, { data: [{ id: "b" }, { id: "c" }] }, { count: 1 }]);
  const r = await preencherT4PorChave(g.cliente, "OBEN", CHAVE, 947706, T4, AGORA, sinal);
  assertEquals(r, { preenchidas: 3, nidDivergente: 1 });
  assertEquals(g.consultas, [
    [
      ["from", "purchase_orders_tracking"],
      ["update", { t4_data_recebimento: T4, updated_at: AGORA }],
      ...filtrosComuns,
      ["eq", "nid_receb", 947706],
      ["select", "id"],
      ["abortSignal", "<sinal>"],
    ],
    [
      ["from", "purchase_orders_tracking"],
      ["update", { t4_data_recebimento: T4, updated_at: AGORA, nid_receb: 947706 }],
      ...filtrosComuns,
      ["is", "nid_receb", null],
      ["select", "id"],
      ["abortSignal", "<sinal>"],
    ],
    [
      ["from", "purchase_orders_tracking"],
      ["select", "id", { count: "exact", head: true }],
      ...filtrosComuns,
      ["not", "nid_receb", "is", null],
      ["neq", "nid_receb", 947706],
      ["abortSignal", "<sinal>"],
    ],
  ]);
});

Deno.test("t4: erro do banco LANÇA (nunca vira 0 preenchidas)", async () => {
  const g = gravador([{ error: { message: "PostgREST 500" } }]);
  let lancou = "";
  try {
    await preencherT4PorChave(g.cliente, "OBEN", CHAVE, 1, T4, AGORA, sinal);
  } catch (e) {
    lancou = (e as { message?: string }).message ?? "";
  }
  assertEquals(lancou, "PostgREST 500");
  assertEquals(g.consultas.length, 1, "para no 1º erro");
});

Deno.test("t4: contagem de divergentes ausente LANÇA (ausente ≠ zero)", async () => {
  const g = gravador([{ data: [] }, { data: [] }, { count: null }]);
  let lancou = "";
  try {
    await preencherT4PorChave(g.cliente, "OBEN", CHAVE, 1, T4, AGORA, sinal);
  } catch (e) {
    lancou = (e as { message?: string }).message ?? "";
  }
  assertEquals(lancou.startsWith("t4: contagem de nid divergente ausente"), true, lancou);
});
