// Testa o CÓDIGO REAL de comRegistro (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/registro-execucao_test.ts
import { comRegistro, type DbRegistro } from "./registro-execucao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

function fakeDb(opts: { falharInsert?: boolean } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const db: DbRegistro = {
    from: (tabela: string) => ({
      insert: (linha: Record<string, unknown>) => ({
        select: () => ({
          single: () => {
            if (opts.falharInsert) return Promise.resolve({ data: null, error: { message: "boom" } });
            inserts.push({ tabela, ...linha });
            return Promise.resolve({ data: { id: "reg-9" }, error: null });
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_c: string, id: string) => {
          updates.push({ id, patch });
          return Promise.resolve({ error: null });
        },
      }),
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { name: "Lucas" }, error: null }),
        }),
      }),
    }),
  };
  return { db, inserts, updates };
}

Deno.test("staff → origem manual com executado_por e nome", async () => {
  const { db, inserts, updates } = fakeDb();
  const r = await comRegistro(db, "a.b", { via: "staff", userId: "u1" }, () => Promise.resolve(42));
  assertEquals(r, 42);
  assertEquals(inserts[0].origem, "manual");
  assertEquals(inserts[0].executado_por, "u1");
  assertEquals(inserts[0].executado_por_nome, "Lucas");
  assertEquals(updates[0].id, "reg-9");
  assertEquals(updates[0].patch.status, "sucesso");
});

Deno.test("cron → origem automatica sem executor", async () => {
  const { db, inserts } = fakeDb();
  await comRegistro(db, "a.b", { via: "cron" }, () => Promise.resolve(1));
  assertEquals(inserts[0].origem, "automatica");
  assertEquals(inserts[0].executado_por, null);
});

Deno.test("FAIL-OPEN: insert falha e fn roda mesmo assim", async () => {
  const { db, updates } = fakeDb({ falharInsert: true });
  const r = await comRegistro(db, "a.b", { via: "cron" }, () => Promise.resolve("ok"));
  assertEquals(r, "ok");
  assertEquals(updates.length, 0);
});

Deno.test("erro na fn → fecha com status erro e re-lança", async () => {
  const { db, updates } = fakeDb();
  let lancou = false;
  try {
    await comRegistro(db, "a.b", { via: "staff", userId: "u1" }, () => Promise.reject(new Error("quebrou")));
  } catch {
    lancou = true;
  }
  assertEquals(lancou, true);
  assertEquals(updates[0].patch.status, "erro");
});
