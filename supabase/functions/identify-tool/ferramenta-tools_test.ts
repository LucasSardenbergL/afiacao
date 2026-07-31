// Testa o CÓDIGO REAL de ferramenta-tools.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/identify-tool/
//
// Foco: a categoria devolvida preenche o pedido de afiação. Um nome plausível
// porém INEXISTENTE no cadastro ("Serra Circular Widia" quando só existe "Serra
// Circular") viraria vínculo que não resolve — e a tela mostraria como se
// tivesse casado com o catálogo.
import { naoIdentificada, normalizarFerramenta, TOOL_FERRAMENTA } from "./ferramenta-tools.ts";

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

const CATEGORIAS = ["Serra Circular", "Faca de Plaina", "Fresa Topo"];
const OK = {
  identified: true,
  category_name: "Serra Circular",
  confidence: "alta",
  description: "Serra circular de widia, ~250mm, 40 dentes",
  specs_detected: { diametro_mm: 250, dentes: 40 },
  suggested_services: ["Afiação", "Troca de dentes"],
};

Deno.test("normalizarFerramenta: leitura completa passa e preserva os campos", () => {
  const r = normalizarFerramenta(OK, CATEGORIAS);
  assert(r !== null, "deveria aceitar");
  assertEquals(r!.category_name, "Serra Circular");
  assertEquals(r!.confidence, "alta");
  assertEquals(r!.suggested_services, ["Afiação", "Troca de dentes"]);
  assertEquals(r!.specs_detected, { diametro_mm: 250, dentes: 40 });
});

Deno.test("normalizarFerramenta: categoria INEXISTENTE no cadastro vira null", () => {
  // O nome é plausível, mas não existe — não pode entrar como se fosse do catálogo.
  const r = normalizarFerramenta({ ...OK, category_name: "Serra Circular Widia" }, CATEGORIAS);
  assert(r !== null, "o resto da leitura continua válido");
  assertEquals(r!.category_name, null, "categoria inventada não vira vínculo");
  assertEquals(r!.description, OK.description, "a descrição é preservada");
});

Deno.test("normalizarFerramenta: casamento de categoria ignora caixa e espaço", () => {
  const r = normalizarFerramenta({ ...OK, category_name: "  serra circular " }, CATEGORIAS);
  assertEquals(r!.category_name, "Serra Circular", "devolve o nome CADASTRADO, não o do modelo");
});

Deno.test("normalizarFerramenta: sem categorias cadastradas, nenhuma categoria casa", () => {
  const r = normalizarFerramenta(OK, []);
  assertEquals(r!.category_name, null);
});

Deno.test("normalizarFerramenta: confiança fora do enum invalida a leitura", () => {
  for (const c of ["altíssima", "99%", "", null, undefined, 5]) {
    assertEquals(normalizarFerramenta({ ...OK, confidence: c }, CATEGORIAS), null, `confidence ${JSON.stringify(c)}`);
  }
});

Deno.test("normalizarFerramenta: descrição vazia invalida a leitura", () => {
  assertEquals(normalizarFerramenta({ ...OK, description: "  " }, CATEGORIAS), null);
});

Deno.test("normalizarFerramenta: serviço não-string é descartado da lista", () => {
  const r = normalizarFerramenta(
    { ...OK, suggested_services: ["Afiação", {}, "", 42, "Retífica"] },
    CATEGORIAS,
  );
  assertEquals(r!.suggested_services, ["Afiação", "Retífica"]);
});

Deno.test("normalizarFerramenta: specs não-objeto degrada para vazio", () => {
  for (const s of ["texto", 42, ["a"], null]) {
    const r = normalizarFerramenta({ ...OK, specs_detected: s }, CATEGORIAS);
    assertEquals(r!.specs_detected, {}, `specs ${JSON.stringify(s)}`);
  }
});

Deno.test("normalizarFerramenta: identified só é true se vier true de verdade", () => {
  // "true" string ou 1 não são confirmação de identificação.
  for (const v of ["true", 1, "sim", {}]) {
    const r = normalizarFerramenta({ ...OK, identified: v }, CATEGORIAS);
    assertEquals(r!.identified, false, `identified ${JSON.stringify(v)}`);
  }
});

Deno.test("normalizarFerramenta: entrada não-objeto degrada para null", () => {
  for (const v of [null, undefined, "x", 7, []]) {
    assertEquals(normalizarFerramenta(v, CATEGORIAS), null, `entrada ${JSON.stringify(v)}`);
  }
});

// ─────────────────────────── naoIdentificada ───────────────────────────

Deno.test("naoIdentificada: resposta honesta, sem chute de categoria", () => {
  const r = naoIdentificada("Foto ilegível");
  assertEquals(r.identified, false);
  assertEquals(r.category_name, null);
  assertEquals(r.confidence, "baixa");
  assertEquals(r.suggested_services, []);
  assertEquals(r.description, "Foto ilegível", "o motivo REAL chega à tela");
});

Deno.test("TOOL_FERRAMENTA: exige identificação, confiança e descrição", () => {
  const req = TOOL_FERRAMENTA.input_schema.required;
  for (const campo of ["identified", "confidence", "description"]) {
    assert(req.includes(campo), `${campo} deveria ser required`);
  }
});
