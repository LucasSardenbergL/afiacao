// Testa o CÓDIGO REAL de argumento-tools.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/generate-bundle-argument/
//
// Foco: `versao_whatsapp` é a mensagem que a vendedora ENVIA AO CLIENTE. O
// fallback antigo a preenchia com `content.slice(0,150)` — texto cru do modelo.
// Nada aqui pode deixar passar argumentação pela metade.
import {
  CAMPOS_ESSENCIAIS,
  normalizarArgumentacao,
  normalizarPerguntas,
  TOOL_ARGUMENTO,
  TOOL_PERGUNTAS,
} from "./argumento-tools.ts";

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

const ARG_COMPLETO = {
  diagnostico: "Cliente com queda de recompra em abrasivos.",
  insight_tecnico: "Provável desgaste prematuro por grão inadequado.",
  beneficio_operacional: "Menos trocas de disco por turno.",
  beneficio_economico: "Redução de paradas na linha.",
  objecao_antecipada: "Preço acima do atual — responder com vida útil.",
  versao_phone: "Olá, notei que a recompra de abrasivos caiu…",
  versao_whatsapp: "Oi! Reparei uma queda no consumo de abrasivos 👀",
  versao_tecnica: "Análise técnica completa do caso.",
};

// ───────────────────────────── schema das tools ─────────────────────────────

Deno.test("schema: tools têm nomes DISTINTOS (o caller força uma por modo)", () => {
  assert(
    TOOL_PERGUNTAS.name !== TOOL_ARGUMENTO.name,
    "nomes iguais fariam o modo errado ser forçado",
  );
});

Deno.test("schema: os 8 campos da argumentação são obrigatórios", () => {
  const req = TOOL_ARGUMENTO.input_schema.required as string[];
  for (const campo of Object.keys(ARG_COMPLETO)) {
    assert(req.includes(campo), `${campo} deveria ser required`);
  }
});

Deno.test("schema: beneficio_economico instrui a NÃO estimar cifra", () => {
  // Sem margem no contexto, qualquer número de economia seria fabricado.
  const props = TOOL_ARGUMENTO.input_schema.properties as Record<
    string,
    { description?: string }
  >;
  const d = props.beneficio_economico.description ?? "";
  assert(/não estime|qualitativa/i.test(d), "a descrição deveria proibir estimativa");
});

// ───────────────────────────── normalizarPerguntas ─────────────────────────────

Deno.test("normalizarPerguntas: aceita os 4 tipos SPIN", () => {
  const r = normalizarPerguntas({
    questions: [
      { type: "situacao", main: "a", alt: "x", rationale: "r" },
      { type: "problema", main: "b", alt: "x", rationale: "r" },
      { type: "implicacao", main: "c", alt: "x", rationale: "r" },
      { type: "direcionamento", main: "d", alt: "x", rationale: "r" },
    ],
  });
  assertEquals(r.length, 4);
  assertEquals(r.map((q) => q.type), ["situacao", "problema", "implicacao", "direcionamento"]);
});

Deno.test("normalizarPerguntas: pergunta SEM enunciado é descartada", () => {
  // Item em branco na tela da vendedora não é pergunta.
  const r = normalizarPerguntas({
    questions: [
      { type: "situacao", main: "  ", alt: "x", rationale: "r" },
      { type: "problema", alt: "x", rationale: "r" },
      { type: "implicacao", main: "vale", alt: "x", rationale: "r" },
    ],
  });
  assertEquals(r.length, 1);
  assertEquals(r[0].main, "vale");
});

Deno.test("normalizarPerguntas: tipo SPIN desconhecido é descartado", () => {
  const r = normalizarPerguntas({
    questions: [
      { type: "fechamento", main: "a", alt: "x", rationale: "r" },
      { type: "", main: "b", alt: "x", rationale: "r" },
    ],
  });
  assertEquals(r.length, 0);
});

Deno.test("normalizarPerguntas: entrada inválida degrada para lista vazia", () => {
  for (const v of [null, undefined, {}, { questions: "três" }, { questions: null }, "x"]) {
    assertEquals(normalizarPerguntas(v), [], `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("normalizarPerguntas: alt/rationale ausentes viram vazio, não undefined", () => {
  const r = normalizarPerguntas({ questions: [{ type: "situacao", main: "a" }] });
  assertEquals(r[0].alt, "");
  assertEquals(r[0].rationale, "");
});

// ──────────────────────────── normalizarArgumentacao ────────────────────────────

Deno.test("normalizarArgumentacao: saída completa passa inteira", () => {
  assertEquals(normalizarArgumentacao(ARG_COMPLETO), ARG_COMPLETO);
});

Deno.test("normalizarArgumentacao: versao_whatsapp VAZIA invalida tudo", () => {
  // É a mensagem enviada ao cliente — melhor erro explícito que mensagem vazia.
  assertEquals(normalizarArgumentacao({ ...ARG_COMPLETO, versao_whatsapp: "" }), null);
  assertEquals(normalizarArgumentacao({ ...ARG_COMPLETO, versao_whatsapp: "   " }), null);
});

Deno.test("normalizarArgumentacao: cada campo essencial ausente invalida", () => {
  for (const campo of CAMPOS_ESSENCIAIS) {
    const parcial = { ...ARG_COMPLETO } as Record<string, unknown>;
    delete parcial[campo];
    assertEquals(normalizarArgumentacao(parcial), null, `sem ${campo}`);
  }
});

Deno.test("normalizarArgumentacao: campo NÃO essencial vazio não derruba a saída", () => {
  const r = normalizarArgumentacao({ ...ARG_COMPLETO, insight_tecnico: "" });
  assert(r !== null, "não deveria invalidar por campo secundário");
  assertEquals(r!.insight_tecnico, "");
});

Deno.test("normalizarArgumentacao: não-objeto vira null", () => {
  for (const v of [null, undefined, "texto", 42, [], true]) {
    assertEquals(normalizarArgumentacao(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("normalizarArgumentacao: campo não-string não vira texto acidental", () => {
  // `{diagnostico: 42}` não pode virar "42" no material que vai ao cliente.
  assertEquals(normalizarArgumentacao({ ...ARG_COMPLETO, diagnostico: 42 }), null);
});
