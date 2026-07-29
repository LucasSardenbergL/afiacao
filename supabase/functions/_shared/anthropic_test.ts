// Testa o CÓDIGO REAL de _shared/anthropic.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/
import {
  extrairToolUseUnico,
  objetoDaTool,
  statusDoErro,
  traduzirErroAnthropic,
} from "./anthropic.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ───────────────────────── traduzirErroAnthropic ─────────────────────────

Deno.test("402 é tratado — saldo esgotado não pode virar 'erro interno'", () => {
  // Foi o estouro de orçamento silencioso que derrubou as features de IA.
  const r = traduzirErroAnthropic(402);
  assert(r !== null, "402 tem de ser reconhecido");
  assertEquals(r!.http, 402);
  assert(/[Cc]réditos/.test(r!.mensagem), "mensagem deveria citar créditos");
});

Deno.test("sobrecarga (500/503/529) vira 503, não repassa 500 cru", () => {
  for (const s of [500, 503, 529]) {
    assertEquals(traduzirErroAnthropic(s)!.http, 503, `status ${s}`);
  }
});

Deno.test("erro de configuração (401/403/404) não vaza como problema do usuário", () => {
  for (const s of [401, 403, 404]) {
    const r = traduzirErroAnthropic(s)!;
    assertEquals(r.http, 500, `status ${s}`);
    assert(/equipe/.test(r.mensagem), "deveria mandar avisar a equipe");
  }
});

Deno.test("429 e 413 têm resposta própria e acionável", () => {
  assertEquals(traduzirErroAnthropic(429)!.http, 429);
  assertEquals(traduzirErroAnthropic(413)!.http, 413);
});

Deno.test("status desconhecido devolve null — caller falha explícito", () => {
  // Devolver uma mensagem tranquilizadora para status que não conhecemos
  // esconderia falha nova; null obriga o caller a tratar como erro interno.
  for (const s of [undefined, 0, 200, 418, 999]) {
    assertEquals(traduzirErroAnthropic(s as number | undefined), null, `status ${s}`);
  }
});

// ─────────────────────────────── statusDoErro ───────────────────────────────

Deno.test("statusDoErro: lê number, ignora o resto", () => {
  assertEquals(statusDoErro({ status: 429 }), 429);
  assertEquals(statusDoErro({ status: "429" }), undefined);
  assertEquals(statusDoErro(new Error("x")), undefined);
  assertEquals(statusDoErro(null), undefined);
  assertEquals(statusDoErro(undefined), undefined);
});

// ───────────────────────── extrairToolUseUnico ─────────────────────────

Deno.test("um tool_use devolve o input", () => {
  const r = extrairToolUseUnico([{ type: "text" }, { type: "tool_use", input: { a: 1 } }]);
  assert(r.ok, "deveria aceitar");
  if (!r.ok) return;
  assertEquals(r.input, { a: 1 });
});

Deno.test("DOIS tool_use são recusados, não cortados em silêncio", () => {
  const r = extrairToolUseUnico([
    { type: "tool_use", input: { parte: 1 } },
    { type: "tool_use", input: { parte: 2 } },
  ]);
  assert(!r.ok, "dois blocos têm de ser recusados");
  if (r.ok) return;
  assertEquals(r.motivo, "multiplo");
  assertEquals(r.quantidade, 2);
});

Deno.test("nenhum tool_use é 'ausente', distinto de 'multiplo'", () => {
  const r = extrairToolUseUnico([{ type: "text" }]);
  assert(!r.ok, "deveria recusar");
  if (r.ok) return;
  assertEquals(r.motivo, "ausente");
});

Deno.test("lista vazia/inválida não explode", () => {
  assertEquals(extrairToolUseUnico([]).ok, false);
  assertEquals(
    extrairToolUseUnico(null as unknown as { type: string }[]).ok,
    false,
  );
});

// ─────────────────────────────── objetoDaTool ───────────────────────────────

Deno.test("objetoDaTool: só objeto passa", () => {
  assertEquals(objetoDaTool({ a: 1 }), { a: 1 });
  for (const v of [null, undefined, "texto", 42, [], [1, 2], true]) {
    assertEquals(objetoDaTool(v), null, `entrada ${JSON.stringify(v)}`);
  }
});
