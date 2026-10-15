// Testa o CÓDIGO REAL de cursor-lease.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-vendas-sync/cursor-lease_test.ts
//
// O lado SQL do fencing (o banco recusar o zumbi) é provado no PG17 por
// db/test-vendas-sync-cursor-fencing.sh. Aqui fica o lado da EDGE: o token viaja em toda chamada,
// a resposta fora do contrato nunca vira lease, e só `false` explícito do banco vira "perdido".
import {
  acquireVendasLease,
  type ClienteRpc,
  finishVendasCursor,
  heartbeatVendasCursor,
  interpretarAcquire,
  interpretarCercado,
  releaseVendasCursor,
} from "./cursor-lease.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const TOKEN = "9b2f6a8e-3c1d-4e5f-8a7b-0c9d8e7f6a5b";
const LEASE = { resumePage: 4, leaseToken: TOKEN };

/** Duplo do cliente: devolve a resposta programada e registra cada chamada. */
function cliente(resposta: { data: unknown; error: { message: string } | null }) {
  const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const db: ClienteRpc = {
    rpc(nome, args) {
      chamadas.push({ nome, args });
      return Promise.resolve(resposta);
    },
  };
  return { db, chamadas };
}

// ── interpretarAcquire: fail-closed — fora do contrato NUNCA vira lease ──
Deno.test("interpretarAcquire: contrato válido vira lease", () => {
  assertEquals(interpretarAcquire({ resume_page: 3, lease_token: TOKEN }), { resumePage: 3, leaseToken: TOKEN });
});
Deno.test("interpretarAcquire: null (lease não adquirido) → null", () => {
  assertEquals(interpretarAcquire(null), null);
});
Deno.test("interpretarAcquire: resposta da RPC ANTIGA (inteiro) → null, nunca lease sem token", () => {
  assertEquals(interpretarAcquire(3), null);
});
Deno.test("interpretarAcquire: token ausente, vazio ou fora do formato uuid → null", () => {
  assertEquals(interpretarAcquire({ resume_page: 3 }), null);
  assertEquals(interpretarAcquire({ resume_page: 3, lease_token: "" }), null);
  assertEquals(interpretarAcquire({ resume_page: 3, lease_token: null }), null);
  assertEquals(interpretarAcquire({ resume_page: 3, lease_token: "nao-e-uuid" }), null);
});
Deno.test("interpretarAcquire: página inválida (0, negativa, fracionária, string) → null", () => {
  for (const p of [0, -1, 2.5, "3", null]) {
    assertEquals(interpretarAcquire({ resume_page: p, lease_token: TOKEN }), null, `resume_page=${JSON.stringify(p)}`);
  }
});
Deno.test("interpretarAcquire: array (rpc RETURNS TABLE) → null", () => {
  assertEquals(interpretarAcquire([{ resume_page: 3, lease_token: TOKEN }]), null);
});

// ── interpretarCercado: SÓ `false` explícito é prova de que outro worker manda ──
Deno.test("interpretarCercado: true → dono, false → perdido", () => {
  assertEquals(interpretarCercado(true, null), "dono");
  assertEquals(interpretarCercado(false, null), "perdido");
});
Deno.test("interpretarCercado: erro de RPC → erro, mesmo com data=false", () => {
  assertEquals(interpretarCercado(false, { message: "boom" }), "erro");
});
Deno.test("interpretarCercado: resposta fora do contrato (null, 't', 1, void da RPC antiga) → erro, nunca perdido/dono", () => {
  for (const d of [null, undefined, "t", 1, "true"]) {
    assertEquals(interpretarCercado(d, null), "erro", `data=${JSON.stringify(d)}`);
  }
});

// ── as 4 chamadas: nome CERCADO + token em toda chamada ──
Deno.test("acquireVendasLease: chama a RPC cercada e devolve o lease", async () => {
  const { db, chamadas } = cliente({ data: { resume_page: 7, lease_token: TOKEN }, error: null });
  const lease = await acquireVendasLease(db, "oben", "2026-01-01", "2026-06-30");
  assertEquals(lease, { resumePage: 7, leaseToken: TOKEN });
  assertEquals(chamadas, [{
    nome: "vendas_sync_lease_acquire_fenced",
    args: { p_account: "oben", p_date_from: "2026-01-01", p_date_to: "2026-06-30" },
  }]);
});
Deno.test("acquireVendasLease: erro de RPC (ex.: migration não aplicada) → null (no-op, não roda sem cerca)", async () => {
  const { db } = cliente({ data: null, error: { message: "Could not find the function" } });
  assertEquals(await acquireVendasLease(db, "oben", "2026-01-01", "2026-06-30"), null);
});
Deno.test("heartbeatVendasCursor: envia token + página; false do banco → perdido", async () => {
  const { db, chamadas } = cliente({ data: false, error: null });
  assertEquals(await heartbeatVendasCursor(db, "colacor", "2026-01-01", "2026-06-30", LEASE, 12), "perdido");
  assertEquals(chamadas, [{
    nome: "vendas_sync_heartbeat_fenced",
    args: { p_account: "colacor", p_date_from: "2026-01-01", p_date_to: "2026-06-30", p_lease_token: TOKEN, p_page: 12 },
  }]);
});
Deno.test("heartbeatVendasCursor: true → dono; erro → erro (best-effort, NÃO para o laço)", async () => {
  assertEquals(await heartbeatVendasCursor(cliente({ data: true, error: null }).db, "oben", "a", "b", LEASE, 1), "dono");
  assertEquals(await heartbeatVendasCursor(cliente({ data: null, error: { message: "timeout" } }).db, "oben", "a", "b", LEASE, 1), "erro");
});
Deno.test("finishVendasCursor: complete=true zera next_page/kind e envia o token", async () => {
  const { db, chamadas } = cliente({ data: true, error: null });
  assertEquals(await finishVendasCursor(db, "oben", "2026-01-01", "2026-06-30", LEASE, true, 9, "http"), "dono");
  assertEquals(chamadas[0], {
    nome: "vendas_sync_finish_fenced",
    args: {
      p_account: "oben", p_date_from: "2026-01-01", p_date_to: "2026-06-30", p_lease_token: TOKEN,
      p_complete: true, p_next_page: null, p_last_error_kind: null,
    },
  });
});
Deno.test("finishVendasCursor: pausa leva next_page e kind; recusa do banco → perdido", async () => {
  const { db, chamadas } = cliente({ data: false, error: null });
  assertEquals(await finishVendasCursor(db, "oben", "a", "b", LEASE, false, 9, "rate_limit"), "perdido");
  assertEquals(chamadas[0].args.p_next_page, 9);
  assertEquals(chamadas[0].args.p_last_error_kind, "rate_limit");
});
Deno.test("releaseVendasCursor: chama a RPC cercada com o token", async () => {
  const { db, chamadas } = cliente({ data: true, error: null });
  assertEquals(await releaseVendasCursor(db, "oben", "2026-01-01", "2026-06-30", LEASE, "error"), "dono");
  assertEquals(chamadas, [{
    nome: "vendas_sync_release_fenced",
    args: { p_account: "oben", p_date_from: "2026-01-01", p_date_to: "2026-06-30", p_lease_token: TOKEN, p_last_error_kind: "error" },
  }]);
});
