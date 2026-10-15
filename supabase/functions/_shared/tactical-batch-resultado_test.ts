// Testa o CÓDIGO REAL de tactical-batch-resultado.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/tactical-batch-resultado_test.ts
//
// POR QUE ESTE MÓDULO EXISTE — incidente 2026-07-21, 1ª execução real do
// tactical-plans-batch-nightly (jobid 165). A resposta foi:
//   {"ok":true,"farmers":3,"alvos":58,"gerados":30,"pulados":0,"erros":28}
// 28 de 58 alvos falharam (48%), UMA VENDEDORA INTEIRA ficou sem plano, e o batch
// devolveu `ok: true` com HTTP 200. O cron marcaria `succeeded`, e o motivo dos 28
// erros foi PERDIDO — o laço fazia `else erros++` sem ler `r.status` nem `j.error`.
// Sem o motivo, foi impossível distinguir 429 (transiente) de 402 (quota) sem
// re-executar o batch inteiro 3h depois.
//
// As duas invariantes que este módulo garante:
//   1. `ok` é FALSO quando há erro — resultado parcial não pode ler como sucesso.
//   2. Todo erro carrega motivo com o STATUS HTTP — é o que separa 429 de 402 de 500.
import { agregar, classificarAlvo } from "./tactical-batch-resultado.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assertInclui(hay: string, needle: string, msg?: string) {
  if (!hay.includes(needle)) {
    throw new Error(msg ?? `esperava "${needle}" dentro de "${hay}"`);
  }
}

// ── classificarAlvo ──────────────────────────────────────────────────────────

Deno.test("classificarAlvo: generated:true → gerado", () => {
  assertEquals(classificarAlvo(200, { id: "uuid-1", generated: true }), { tipo: "gerado" });
});

Deno.test("classificarAlvo: skipped preserva o motivo do skip", () => {
  assertEquals(
    classificarAlvo(200, { id: "uuid-1", skipped: "ja_gerado_hoje" }),
    { tipo: "pulado", motivo: "ja_gerado_hoje" },
  );
});

Deno.test("classificarAlvo: rpc_error é PULADO (não erro) — a edge alvo já o trata", () => {
  // Regressão do diagnóstico: `pulados: 0` foi o que provou que os 28 erros NÃO
  // vinham da RPC criar_plano_tatico. Se rpc_error virasse `erro`, essa dedução
  // teria sido impossível.
  assertEquals(
    classificarAlvo(200, { skipped: "rpc_error", detail: "owner mismatch" }),
    { tipo: "pulado", motivo: "rpc_error" },
  );
});

Deno.test("classificarAlvo: 429 vira erro com o STATUS no motivo", () => {
  const c = classificarAlvo(429, { error: "Limite de requisições excedido." });
  assertEquals(c.tipo, "erro");
  assertInclui((c as { motivo: string }).motivo, "429");
});

Deno.test("classificarAlvo: 402 vira erro com o STATUS no motivo", () => {
  // 402 (quota) e 429 (rate limit) exigem correções OPOSTAS — backoff não resolve
  // quota esgotada. O motivo tem de os separar.
  const c = classificarAlvo(402, { error: "Créditos de IA esgotados." });
  assertEquals(c.tipo, "erro");
  assertInclui((c as { motivo: string }).motivo, "402");
});

Deno.test("classificarAlvo: 429 e 402 produzem motivos DIFERENTES", () => {
  const a = classificarAlvo(429, { error: "Limite de requisições excedido." });
  const b = classificarAlvo(402, { error: "Créditos de IA esgotados." });
  if ((a as { motivo: string }).motivo === (b as { motivo: string }).motivo) {
    throw new Error("429 e 402 colapsaram no mesmo motivo — indistinguíveis no log");
  }
});

Deno.test("classificarAlvo: corpo vazio (JSON ilegível) não vira erro SILENCIOSO", () => {
  // `r.json().catch(() => ({}))` no batch produz {} quando a resposta não é JSON.
  // Ausência de motivo é ausência de dado, não 'sem causa' — precisa ser nomeada.
  const c = classificarAlvo(500, {});
  assertEquals(c.tipo, "erro");
  assertInclui((c as { motivo: string }).motivo, "500");
});

Deno.test("classificarAlvo: status 0 = fetch não respondeu (rede/timeout)", () => {
  // Convenção usada pelo catch do index.ts: em vez de um ramo de erro NÃO TESTADO
  // no laço, o catch chama classificarAlvo(0, {}) e cai nesta função. `http_0` é
  // distinguível de qualquer status real — falha de rede não se confunde com 500.
  const c = classificarAlvo(0, {});
  assertEquals(c.tipo, "erro");
  assertEquals((c as { motivo: string }).motivo, "http_0");
});

Deno.test("classificarAlvo: 200 sem generated nem skipped ainda é erro", () => {
  // Caso traiçoeiro: HTTP ok, corpo inesperado. Contar como sucesso fabricaria plano.
  const c = classificarAlvo(200, { foo: "bar" });
  assertEquals(c.tipo, "erro");
});

// ── agregar ──────────────────────────────────────────────────────────────────

Deno.test("agregar: ok é FALSO quando há erro — o bug de 2026-07-21", () => {
  const r = agregar([
    { tipo: "gerado" },
    { tipo: "gerado" },
    { tipo: "erro", motivo: "http_429" },
  ]);
  assertEquals(r.ok, false, "resultado parcial NÃO pode reportar ok:true");
  assertEquals(r.gerados, 2);
  assertEquals(r.erros, 1);
});

Deno.test("agregar: ok é verdadeiro só com zero erros", () => {
  const r = agregar([
    { tipo: "gerado" },
    { tipo: "pulado", motivo: "ja_gerado_hoje" },
  ]);
  assertEquals(r.ok, true);
  assertEquals(r.erros, 0);
});

Deno.test("agregar: lote vazio é ok (nada a fazer ≠ falha)", () => {
  const r = agregar([]);
  assertEquals(r.ok, true);
  assertEquals(r.gerados, 0);
});

Deno.test("agregar: agrupa motivos com contagem", () => {
  const r = agregar([
    { tipo: "erro", motivo: "http_429" },
    { tipo: "erro", motivo: "http_429" },
    { tipo: "erro", motivo: "http_402" },
    { tipo: "pulado", motivo: "ja_gerado_hoje" },
  ]);
  assertEquals(r.erros_por_motivo, { http_429: 2, http_402: 1 });
  assertEquals(r.pulados_por_motivo, { ja_gerado_hoje: 1 });
});

Deno.test("agregar: reproduz o incidente real (30 gerados / 28 erros)", () => {
  const cs = [
    ...Array.from({ length: 30 }, () => ({ tipo: "gerado" as const })),
    ...Array.from({ length: 28 }, () => ({ tipo: "erro" as const, motivo: "http_429" })),
  ];
  const r = agregar(cs);
  assertEquals(r.ok, false, "48% de falha reportado como ok:true foi o incidente");
  assertEquals(r.gerados, 30);
  assertEquals(r.erros, 28);
  assertEquals(r.erros_por_motivo, { http_429: 28 });
});

// ── Registro server-side (incidente 2026-10-09) ──────────────────────────────────────────
// O cron marcou `succeeded` e criou ZERO planos — e a causa é irrecuperável: a resposta da
// edge só existia em net._http_response (TTL ~6h). O registro em acoes_execucoes precisa
// guardar o MESMO corpo que a resposta HTTP devolve, senão volta a ser um resumo de segunda mão.
import { corpoDoLote, detalhesDoRegistro } from "./tactical-batch-resultado.ts";

const CONTEXTO = { farmers: 3, alvos: 6, mascarados_ignorados: 10, sem_margem_indecidivel: 4675, ja_na_fila: 12 };

Deno.test("registro: detalhes contêm o corpo da resposta INTEIRO, chave a chave", () => {
  const resumo = agregar([
    { tipo: "gerado" },
    { tipo: "pulado", motivo: "ja_na_fila" },
    { tipo: "erro", motivo: "http_429" },
  ]);
  const corpo = corpoDoLote(resumo, CONTEXTO);
  const det = detalhesDoRegistro(corpo, new Date("2026-10-15T08:00:05Z"));
  for (const [k, v] of Object.entries(corpo)) {
    assertEquals(det[k], v, `detalhes.${k} difere do corpo da resposta`);
  }
  assertEquals(corpo.ok, false, "erro no lote ⇒ ok falso também no registro");
  assertEquals(corpo.erros_por_motivo, { http_429: 1 });
  assertEquals(corpo.ja_na_fila, 12);
});

Deno.test("registro: zero alvos é gravado como zero EXPLÍCITO (o caso de 2026-10-09)", () => {
  const corpo = corpoDoLote(agregar([]), { ...CONTEXTO, alvos: 0 });
  const det = detalhesDoRegistro(corpo, new Date("2026-10-09T08:00:05Z"));
  assertEquals(det.alvos, 0);
  assertEquals(det.gerados, 0);
  assertEquals(det.farmers, 3);
});

Deno.test("registro: dia operacional é BRT, não o dia UTC", () => {
  const corpo = corpoDoLote(agregar([]), CONTEXTO);
  // 08:00 UTC de 15/10 = 05:00 BRT de 15/10
  assertEquals(detalhesDoRegistro(corpo, new Date("2026-10-15T08:00:00Z")).dia_operacional_brt, "2026-10-15");
  // 01:00 UTC de 15/10 = 22:00 BRT de 14/10 — o dia UTC erraria aqui
  assertEquals(detalhesDoRegistro(corpo, new Date("2026-10-15T01:00:00Z")).dia_operacional_brt, "2026-10-14");
  assertEquals(detalhesDoRegistro(corpo, new Date("2026-10-15T08:00:00Z")).registrado_em, "2026-10-15T08:00:00.000Z");
});
