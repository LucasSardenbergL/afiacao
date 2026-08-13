// Testa o CÓDIGO REAL de _shared/ia-cota.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/
import {
  type ClienteRpc,
  consumirCota,
  formatarEspera,
  headersDeCota,
  interpretarCota,
} from "./ia-cota.ts";

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

const ROTULO = "identificações por foto";

/** Duplo do cliente: devolve o que o teste mandar, sem tocar rede. */
function clienteFake(
  resposta: { data: unknown; error: unknown },
): ClienteRpc & { chamadas: Array<Record<string, unknown>> } {
  const chamadas: Array<Record<string, unknown>> = [];
  return {
    chamadas,
    rpc(nome: string, args: Record<string, unknown>) {
      chamadas.push({ nome, ...args });
      return Promise.resolve(resposta);
    },
  };
}

/** Duplo que estoura — a edge não pode deixar a exceção escapar nem liberar. */
function clienteQueExplode(): ClienteRpc {
  return {
    rpc(): Promise<{ data: unknown; error: unknown }> {
      throw new Error("boom");
    },
  };
}

// ── formatarEspera ────────────────────────────────────────────────────────
Deno.test("formatarEspera: abaixo de um minuto", () => {
  assertEquals(formatarEspera(1), "menos de um minuto");
  assertEquals(formatarEspera(59), "menos de um minuto");
});

Deno.test("formatarEspera: arredonda minutos para CIMA", () => {
  assertEquals(formatarEspera(60), "1 minuto");
  assertEquals(formatarEspera(61), "2 minutos");   // volta cedo frustra mais
  assertEquals(formatarEspera(1320), "22 minutos");
});

Deno.test("formatarEspera: a fronteira 3599 não vira '1h 60min'", () => {
  assertEquals(formatarEspera(3599), "1 hora");
  assertEquals(formatarEspera(3600), "1 hora");
  assertEquals(formatarEspera(5400), "1h30min");
  assertEquals(formatarEspera(7200), "2 horas");
  assertEquals(formatarEspera(75600), "21 horas");
});

Deno.test("formatarEspera: valor inútil não vira frase inútil", () => {
  assertEquals(formatarEspera(0), "instantes");
  assertEquals(formatarEspera(-5), "instantes");
  assertEquals(formatarEspera(NaN), "instantes");
});

// ── interpretarCota: caminho permitido ────────────────────────────────────
Deno.test("interpretarCota: permitido devolve os contadores", () => {
  const r = interpretarCota([{
    permitido: true,
    motivo: "ok",
    usado_hora: 3,
    limite_hora: 20,
    usado_dia: 8,
    limite_dia: 60,
    libera_em_segundos: 0,
  }], ROTULO);
  assert(r.permitido, "devia permitir");
  if (r.permitido) {
    assertEquals(r.usadoHora, 3);
    assertEquals(r.limiteDia, 60);
  }
});

Deno.test("interpretarCota: aceita objeto solto, não só array", () => {
  const r = interpretarCota({ permitido: true, motivo: "ok" }, ROTULO);
  assert(r.permitido, "devia permitir");
});

Deno.test("interpretarCota: contador ausente vira null, NÃO zero", () => {
  // Number(null)===0 fabricaria "você usou 0 de 0" — ausente ≠ zero.
  const r = interpretarCota([{ permitido: true, usado_hora: null }], ROTULO);
  assert(r.permitido, "devia permitir");
  if (r.permitido) {
    assertEquals(r.usadoHora, null);
    assertEquals(r.limiteHora, null);
  }
});

// ── interpretarCota: negações ─────────────────────────────────────────────
Deno.test("interpretarCota: limite da HORA — 429, o número certo e a espera", () => {
  const r = interpretarCota([{
    permitido: false,
    motivo: "hora",
    usado_hora: 20,
    limite_hora: 20,
    usado_dia: 20,
    limite_dia: 60,
    libera_em_segundos: 1320,
  }], ROTULO);
  assert(!r.permitido, "devia negar");
  if (!r.permitido) {
    assertEquals(r.http, 429);
    assert(r.mensagem.includes("20 identificações por foto"), `número/rótulo ausentes: ${r.mensagem}`);
    assert(r.mensagem.includes("22 minutos"), `espera ausente: ${r.mensagem}`);
    // O ponto do achado: a mensagem tem de dizer que é a cota DELE, e negar
    // explicitamente o diagnóstico errado ("a IA quebrou").
    assert(r.mensagem.includes("seu limite de uso"), `não se identifica como cota: ${r.mensagem}`);
    assert(r.mensagem.includes("não uma falha da IA"), `não contrasta com falha da IA: ${r.mensagem}`);
    assertEquals(r.retryAposSegundos, 1320);
  }
});

Deno.test("interpretarCota: limite do DIA usa o limite diário, não o horário", () => {
  const r = interpretarCota([{
    permitido: false,
    motivo: "dia",
    usado_hora: 2,
    limite_hora: 20,
    usado_dia: 60,
    limite_dia: 60,
    libera_em_segundos: 75600,
  }], ROTULO);
  assert(!r.permitido, "devia negar");
  if (!r.permitido) {
    assertEquals(r.http, 429);
    assert(r.mensagem.includes("60 identificações por foto"), `limite errado: ${r.mensagem}`);
    assert(r.mensagem.includes("por dia"), `janela errada: ${r.mensagem}`);
    assert(r.mensagem.includes("21 horas"), `espera ausente: ${r.mensagem}`);
  }
});

Deno.test("interpretarCota: sem_limite é 503 de configuração, não 429 do usuário", () => {
  // Culpar o usuário por uma edge que ninguém configurou mandaria ele esperar
  // uma janela que nunca abre.
  const r = interpretarCota([{ permitido: false, motivo: "sem_limite" }], ROTULO);
  assert(!r.permitido, "devia negar");
  if (!r.permitido) {
    assertEquals(r.http, 503);
    assert(r.mensagem.includes("avise a equipe"), `mensagem errada: ${r.mensagem}`);
    assertEquals(r.retryAposSegundos, undefined);
  }
});

Deno.test("interpretarCota: negado com limite ilegível NÃO inventa o número", () => {
  const r = interpretarCota([{
    permitido: false,
    motivo: "hora",
    limite_hora: null,
    libera_em_segundos: 60,
  }], ROTULO);
  assert(!r.permitido, "devia negar");
  if (!r.permitido) {
    assertEquals(r.http, 503);
    assert(!r.mensagem.includes("null"), `vazou null na frase: ${r.mensagem}`);
    assert(!r.mensagem.includes("NaN"), `vazou NaN na frase: ${r.mensagem}`);
  }
});

// ── fail-closed ───────────────────────────────────────────────────────────
Deno.test("interpretarCota: payload inútil é NEGADO (fail-closed)", () => {
  for (const lixo of [null, undefined, [], {}, "erro", 42, [{ permitido: "sim" }]]) {
    const r = interpretarCota(lixo, ROTULO);
    assert(!r.permitido, `payload ${JSON.stringify(lixo)} devia ser negado`);
    if (!r.permitido) assertEquals(r.http, 503);
  }
});

Deno.test("consumirCota: erro da RPC é negado, não liberado", () => {
  return consumirCota(
    clienteFake({ data: null, error: { message: "conexão caiu" } }),
    "u1",
    "identify-tool",
    ROTULO,
  ).then((r) => {
    assert(!r.permitido, "erro de RPC NÃO pode liberar a chamada");
    if (!r.permitido) {
      assertEquals(r.http, 503);
      assert(r.mensagem.includes("limite de uso"), `mensagem genérica demais: ${r.mensagem}`);
    }
  });
});

Deno.test("consumirCota: exceção lançada é negada, não propagada", () => {
  return consumirCota(clienteQueExplode(), "u1", "identify-tool", ROTULO).then((r) => {
    assert(!r.permitido, "exceção NÃO pode liberar a chamada");
    if (!r.permitido) assertEquals(r.http, 503);
  });
});

Deno.test("consumirCota: manda os parâmetros que a RPC espera", () => {
  const c = clienteFake({ data: [{ permitido: true }], error: null });
  return consumirCota(c, "u-123", "analyze-services", ROTULO).then((r) => {
    assert(r.permitido, "devia permitir");
    assertEquals(c.chamadas, [{
      nome: "ia_consumir_cota",
      p_user_id: "u-123",
      p_funcao: "analyze-services",
    }]);
  });
});

// ── headersDeCota ─────────────────────────────────────────────────────────
Deno.test("headersDeCota: Retry-After só quando há espera", () => {
  assertEquals(headersDeCota({ permitido: true, usadoHora: 1, limiteHora: 2, usadoDia: 1, limiteDia: 2 }), {});
  assertEquals(headersDeCota({ permitido: false, http: 503, mensagem: "x" }), {});
  assertEquals(
    headersDeCota({ permitido: false, http: 429, mensagem: "x", retryAposSegundos: 90 }),
    { "Retry-After": "90" },
  );
  // Retry-After é inteiro em segundos; fração viraria header inválido.
  assertEquals(
    headersDeCota({ permitido: false, http: 429, mensagem: "x", retryAposSegundos: 0.4 }),
    { "Retry-After": "1" },
  );
});
