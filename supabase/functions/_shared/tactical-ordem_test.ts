// Testa o CÓDIGO REAL de tactical-ordem.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/tactical-ordem_test.ts
//
// POR QUE ESTE MÓDULO EXISTE — a cobertura PARCIAL do batch noturno não é hipótese, é
// rotina, e ela cai SEMPRE na mesma pessoa:
//   2026-07-21: "UMA VENDEDORA INTEIRA ficou sem plano" (ver tactical-batch-resultado.ts)
//   2026-07-30: alvos 9/25/25 → gerados 9/15/0   (farmer 700657a1 zerado)
//   2026-07-31: alvos 9/25/25 → gerados 9/16/0   (farmer 700657a1 zerado de novo)
// A causa da CONCENTRAÇÃO é a ordem: o batch concatenava os grupos do Map
// (`[A...A, B...B, C...C]`), então qualquer truncamento — timeout, 429, 402 — come o
// sufixo inteiro e o ÚLTIMO farmer nunca recebe nada. A ordem era acidental: vinha da
// primeira ocorrência de cada farmer na paginação por customer_user_id.
//
// Este módulo NÃO conserta o volume (isso é o batch retomável). Ele garante que, quando
// a cobertura for parcial — e ela SEMPRE pode ser, por 429/402/queda —, a perda seja
// distribuída em vez de recair inteira sobre uma vendedora.
import { intercalarPorFarmer, rotacaoDoDia } from "./tactical-ordem.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

/** Conta quantos alvos de cada farmer caem num prefixo de tamanho `n`. */
function contarNoPrefixo(alvos: Array<{ farmer: string; customer: string }>, n: number) {
  const conta = new Map<string, number>();
  for (const a of alvos.slice(0, n)) conta.set(a.farmer, (conta.get(a.farmer) ?? 0) + 1);
  return conta;
}

function carteira(farmer: string, quantos: number) {
  return {
    farmer,
    clientes: Array.from({ length: quantos }, (_, i) => `${farmer}-c${i + 1}`),
  };
}

// ── intercalarPorFarmer ──────────────────────────────────────────────────────

Deno.test("intercala em round-robin: um de cada farmer por rodada", () => {
  const alvos = intercalarPorFarmer(
    [carteira("A", 2), carteira("B", 2), carteira("C", 2)],
    0,
  );
  assertEquals(alvos.map((a) => a.customer), [
    "A-c1", "B-c1", "C-c1",
    "A-c2", "B-c2", "C-c2",
  ]);
});

Deno.test("preserva a ordem interna de cada farmer (priority desc já vem do caller)", () => {
  const alvos = intercalarPorFarmer([carteira("A", 3), carteira("B", 3)], 0);
  const soA = alvos.filter((a) => a.farmer === "A").map((a) => a.customer);
  assertEquals(soA, ["A-c1", "A-c2", "A-c3"]);
});

Deno.test("farmer que acaba antes sai da rodada; os outros continuam", () => {
  const alvos = intercalarPorFarmer([carteira("A", 1), carteira("B", 3)], 0);
  assertEquals(alvos.map((a) => a.customer), ["A-c1", "B-c1", "B-c2", "B-c3"]);
});

Deno.test("nenhum alvo é perdido nem duplicado", () => {
  const alvos = intercalarPorFarmer(
    [carteira("A", 9), carteira("B", 25), carteira("C", 25)],
    0,
  );
  assertEquals(alvos.length, 59);
  assertEquals(new Set(alvos.map((a) => a.customer)).size, 59);
});

// ── A invariante que este módulo existe para garantir ────────────────────────

Deno.test("prefixo de 24 sobre 9/25/25 distribui 8/8/8 — nenhum farmer zerado", () => {
  const alvos = intercalarPorFarmer(
    [carteira("A", 9), carteira("B", 25), carteira("C", 25)],
    0,
  );
  const conta = contarNoPrefixo(alvos, 24);
  assertEquals(conta.get("A"), 8);
  assertEquals(conta.get("B"), 8);
  assertEquals(conta.get("C"), 8);
});

Deno.test("o truncamento REAL de 30/07 (24 de 59) deixaria de zerar qualquer farmer", () => {
  const alvos = intercalarPorFarmer(
    [carteira("A", 9), carteira("B", 25), carteira("C", 25)],
    0,
  );
  for (const f of ["A", "B", "C"]) {
    const n = contarNoPrefixo(alvos, 24).get(f) ?? 0;
    if (n === 0) throw new Error(`farmer ${f} ficou ZERADO no prefixo de 24 — regressão da concentração`);
  }
});

Deno.test("prefixo indivisível por 3 dá o extra a um só farmer, e a rotação muda quem", () => {
  const carteiras = [carteira("A", 9), carteira("B", 25), carteira("C", 25)];
  const dia0 = contarNoPrefixo(intercalarPorFarmer(carteiras, 0), 25);
  assertEquals([dia0.get("A"), dia0.get("B"), dia0.get("C")], [9, 8, 8]);

  const dia1 = contarNoPrefixo(intercalarPorFarmer(carteiras, 1), 25);
  assertEquals([dia1.get("A"), dia1.get("B"), dia1.get("C")], [8, 9, 8]);

  const dia2 = contarNoPrefixo(intercalarPorFarmer(carteiras, 2), 25);
  assertEquals([dia2.get("A"), dia2.get("B"), dia2.get("C")], [8, 8, 9]);
});

Deno.test("rotação é módulo: dia 3 volta ao mesmo beneficiário do dia 0", () => {
  const carteiras = [carteira("A", 9), carteira("B", 25), carteira("C", 25)];
  assertEquals(
    intercalarPorFarmer(carteiras, 3).map((a) => a.customer),
    intercalarPorFarmer(carteiras, 0).map((a) => a.customer),
  );
});

// ── Bordas ───────────────────────────────────────────────────────────────────

Deno.test("lista vazia devolve vazio (não lança)", () => {
  assertEquals(intercalarPorFarmer([], 0), []);
});

Deno.test("farmer sem clientes não trava a rodada dos demais", () => {
  const alvos = intercalarPorFarmer([carteira("A", 0), carteira("B", 2)], 0);
  assertEquals(alvos.map((a) => a.customer), ["B-c1", "B-c2"]);
});

Deno.test("um único farmer degenera para a própria ordem", () => {
  const alvos = intercalarPorFarmer([carteira("A", 3)], 0);
  assertEquals(alvos.map((a) => a.customer), ["A-c1", "A-c2", "A-c3"]);
});

Deno.test("rotação não perde nem duplica alvo em nenhum deslocamento", () => {
  const carteiras = [carteira("A", 9), carteira("B", 25), carteira("C", 25)];
  for (let r = 0; r < 6; r++) {
    const alvos = intercalarPorFarmer(carteiras, r);
    assertEquals(alvos.length, 59, `rotacao ${r} perdeu alvo`);
    assertEquals(new Set(alvos.map((a) => a.customer)).size, 59, `rotacao ${r} duplicou alvo`);
  }
});

// ── rotacaoDoDia ─────────────────────────────────────────────────────────────
// Deriva o deslocamento do DIA OPERACIONAL. Precisa ser estável dentro do mesmo dia
// (senão um retry do batch reordena e a idempotência por dia vira loteria) e mudar
// entre dias (senão o mesmo farmer leva o extra para sempre).

Deno.test("rotação é estável dentro do mesmo dia operacional", () => {
  assertEquals(rotacaoDoDia("2026-07-31"), rotacaoDoDia("2026-07-31"));
});

Deno.test("rotação muda entre dias consecutivos", () => {
  const a = rotacaoDoDia("2026-07-31");
  const b = rotacaoDoDia("2026-08-01");
  if (a === b) throw new Error("dias consecutivos deram a mesma rotação — o extra ficaria fixo");
});

Deno.test("rotação avança de 1 por dia (previsível para auditar)", () => {
  const d0 = rotacaoDoDia("2026-07-31");
  assertEquals(rotacaoDoDia("2026-08-01"), d0 + 1);
  assertEquals(rotacaoDoDia("2026-08-02"), d0 + 2);
});

Deno.test("rotação é não-negativa mesmo para data anterior à epoch", () => {
  const r = rotacaoDoDia("1969-12-31");
  if (r < 0) throw new Error(`rotação negativa (${r}) — o índice do array sairia da faixa`);
});
