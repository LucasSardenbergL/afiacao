// Testa o CÓDIGO REAL de copiloto-tools.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/copilot-analyze/
//
// Foco: o FALLBACK FABRICADO. A edge devolvia, no catch do JSON.parse,
//   { intent: 'indiferenca', direction: 'neutro', confidence: 30, ... }
// com cara de leitura real — durante a ligação, com a vendedora ao telefone.
// "Indiferença" e "neutro" são AFIRMAÇÕES sobre o cliente; 30 é um número que
// ninguém mediu. Conversa em RISCO aparecia como neutra.
import {
  confiancaValida,
  motivosValidos,
  normalizarAnalise,
  TOOL_COPILOTO,
} from "./copiloto-tools.ts";

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

const COMPLETA = {
  intent: "objecao_preco",
  phase: "proposta",
  direction: "risco",
  direction_reasons: ["cliente citou concorrente mais barato"],
  suggestion: "Traga o custo por peça afiada em vez do preço do serviço.",
  suggestion_type: "argumento_economico",
  confidence: 78,
};

Deno.test("normalizarAnalise: leitura completa passa e preserva os campos", () => {
  const r = normalizarAnalise(COMPLETA);
  assert(r !== null, "deveria aceitar leitura completa");
  assertEquals(r!.intent, "objecao_preco");
  assertEquals(r!.direction, "risco");
  assertEquals(r!.confidence, 78);
  assertEquals(r!.direction_reasons, ["cliente citou concorrente mais barato"]);
});

Deno.test("normalizarAnalise: CADA campo afirmado na tela é obrigatório", () => {
  // Meia análise (intenção sem direção, sugestão sem tipo) chega à tela com a
  // mesma aparência de leitura completa.
  for (const campo of ["intent", "phase", "direction", "suggestion", "suggestion_type", "confidence"]) {
    const sem = { ...COMPLETA } as Record<string, unknown>;
    delete sem[campo];
    assertEquals(normalizarAnalise(sem), null, `sem ${campo} deveria invalidar`);
  }
});

Deno.test("normalizarAnalise: valor fora do enum NÃO é aceito nem 'corrigido'", () => {
  assertEquals(normalizarAnalise({ ...COMPLETA, intent: "cliente_bravo" }), null);
  assertEquals(normalizarAnalise({ ...COMPLETA, direction: "ótimo" }), null);
  assertEquals(normalizarAnalise({ ...COMPLETA, phase: "pos_venda" }), null);
  assertEquals(normalizarAnalise({ ...COMPLETA, suggestion_type: "piada" }), null);
});

Deno.test("normalizarAnalise: o FALLBACK FABRICADO não passaria hoje sem os campos", () => {
  // O objeto antigo tinha todos os campos preenchidos — o ponto é que agora ele
  // só existe se a IA REALMENTE devolver. Sem tool_use, o caller responde 422.
  const fabricado = {
    intent: "indiferenca",
    phase: "abertura",
    direction: "neutro",
    direction_reasons: ["Análise inconclusiva"],
    suggestion: "Continue explorando as necessidades do cliente.",
    suggestion_type: "pergunta_diagnostica",
    // confidence ausente: era 30 fixo, agora não há de onde tirar
  };
  assertEquals(normalizarAnalise(fabricado), null, "sem confiança medida não há análise");
});

Deno.test("normalizarAnalise: entrada não-objeto degrada para null", () => {
  for (const v of [null, undefined, "texto", 42, [], true]) {
    assertEquals(normalizarAnalise(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("normalizarAnalise: caixa e espaço no enum são normalizados", () => {
  const r = normalizarAnalise({ ...COMPLETA, intent: "  INTERESSE  ", direction: "Positivo" });
  assert(r !== null, "deveria normalizar");
  assertEquals(r!.intent, "interesse");
  assertEquals(r!.direction, "positivo");
});

// ─────────────────────────── confiancaValida ───────────────────────────

Deno.test("confiancaValida: aceita 0–100 e rejeita fora da faixa", () => {
  assertEquals(confiancaValida(0), 0);
  assertEquals(confiancaValida(100), 100);
  assertEquals(confiancaValida("78"), 78);
  for (const v of [-1, 101, 1000]) {
    assertEquals(confiancaValida(v), null, `entrada ${v}`);
  }
});

Deno.test("confiancaValida: ilegível vira null, NÃO 0 nem número de consolo", () => {
  // Number(null) === 0 é a armadilha: 0% de confiança é um FATO diferente de
  // "não consegui medir a confiança".
  for (const v of [null, undefined, "", "alta", NaN, {}, []]) {
    assertEquals(confiancaValida(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

// ─────────────────────────── motivosValidos ───────────────────────────

Deno.test("motivosValidos: objeto no array é descartado (derrubaria a lista)", () => {
  assertEquals(motivosValidos(["preço citado", {}, "", { a: 1 }, "  ", "prazo"]), [
    "preço citado",
    "prazo",
  ]);
});

Deno.test("motivosValidos: entrada não-array degrada para vazio", () => {
  for (const v of [null, undefined, "texto", 7]) {
    assertEquals(motivosValidos(v), [], `entrada ${JSON.stringify(v)}`);
  }
});

// ───────────────────────────── contrato da tool ─────────────────────────────

Deno.test("TOOL_COPILOTO: exige os campos que a tela afirma ao vendedor", () => {
  const req = TOOL_COPILOTO.input_schema.required;
  for (const campo of ["intent", "phase", "direction", "suggestion", "suggestion_type", "confidence"]) {
    assert(req.includes(campo), `${campo} deveria ser required no schema`);
  }
});
