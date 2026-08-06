// Testa o CÓDIGO REAL de vision-helpers.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/promocao-extrair-via-vision/
//
// Foco: os guards money-path. Percentual extraído por LLM que não passa por
// `validarPercentual` viraria desconto/aumento gravado em cima de preço real.
import {
  anotarRejeicoes,
  dataValida,
  LIMITE_BASE64_BYTES,
  montarBlocoAnexo,
  normalizarCategoriasAumento,
  normalizarConfianca,
  normalizarItensPromo,
  validarPercentual,
} from "./vision-helpers.ts";

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

// ─────────────────────────── montarBlocoAnexo ───────────────────────────

Deno.test("montarBlocoAnexo: pdf vira content block document", () => {
  const r = montarBlocoAnexo("pdf", "QUJD");
  assert(r.ok, "deveria aceitar pdf");
  if (!r.ok) return;
  assertEquals(r.bloco.type, "document");
  assertEquals(r.mediaType, "application/pdf");
  assertEquals(r.extensao, "pdf");
  assertEquals(r.bloco.source.data, "QUJD");
});

Deno.test("montarBlocoAnexo: application/pdf também é aceito", () => {
  const r = montarBlocoAnexo("application/pdf", "QUJD");
  assert(r.ok, "deveria aceitar application/pdf");
});

Deno.test("montarBlocoAnexo: imagens viram content block image com extensão certa", () => {
  const casos: Array<[string, string]> = [
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
  ];
  for (const [mime, ext] of casos) {
    const r = montarBlocoAnexo(mime, "QUJD");
    assert(r.ok, `deveria aceitar ${mime}`);
    if (!r.ok) continue;
    assertEquals(r.bloco.type, "image", mime);
    assertEquals(r.bloco.source.media_type, mime, mime);
    assertEquals(r.extensao, ext, `extensão de ${mime}`);
  }
});

Deno.test("montarBlocoAnexo: MIME não suportado pela Anthropic é rejeitado aqui", () => {
  // image/heic sai do iPhone e o <input> aceita; o gateway antigo tolerava.
  for (const mime of ["image/heic", "image/bmp", "text/plain", ""]) {
    const r = montarBlocoAnexo(mime, "QUJD");
    assert(!r.ok, `${mime} deveria ser rejeitado`);
  }
});

Deno.test("montarBlocoAnexo: base64 vazio é rejeitado", () => {
  assert(!montarBlocoAnexo("pdf", "").ok, "vazio deveria ser rejeitado");
  assert(!montarBlocoAnexo("pdf", "   ").ok, "só espaço deveria ser rejeitado");
});

Deno.test("montarBlocoAnexo: acima do teto de request é rejeitado com mensagem acionável", () => {
  const grande = "A".repeat(LIMITE_BASE64_BYTES + 1);
  const r = montarBlocoAnexo("pdf", grande);
  assert(!r.ok, "deveria rejeitar acima do limite");
  if (r.ok) return;
  assert(r.erro.includes("MB"), "erro deveria informar o tamanho");
});

// ─────────────────────── validarPercentual (money-path) ───────────────────────

Deno.test("validarPercentual: aceita faixa (0,100]", () => {
  assertEquals(validarPercentual(20), 20);
  assertEquals(validarPercentual(0.5), 0.5);
  assertEquals(validarPercentual(100), 100);
});

Deno.test("validarPercentual: ausente/ilegível NÃO vira zero", () => {
  // Number(null) === 0 é a armadilha canônica: 0% de desconto é um FATO
  // diferente de "não consegui ler o desconto".
  for (const v of [null, undefined, "", "abc", NaN, Infinity, -Infinity, {}, []]) {
    assertEquals(validarPercentual(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("validarPercentual: zero, negativo e acima de 100 são rejeitados", () => {
  for (const v of [0, -1, -0.01, 100.01, 5000]) {
    assertEquals(validarPercentual(v), null, `entrada ${v}`);
  }
});

// ─────────────────────────── normalizarConfianca ───────────────────────────

Deno.test("normalizarConfianca: fora de [0,1] ou ilegível degrada para 0", () => {
  assertEquals(normalizarConfianca(0.9), 0.9);
  assertEquals(normalizarConfianca(0), 0);
  assertEquals(normalizarConfianca(1), 1);
  for (const v of [null, undefined, "alta", NaN, -0.1, 1.1]) {
    assertEquals(normalizarConfianca(v), 0, `entrada ${JSON.stringify(v)}`);
  }
});

// ─────────────────────────────── dataValida ───────────────────────────────

Deno.test("dataValida: aceita YYYY-MM-DD real", () => {
  assertEquals(dataValida("2026-04-16"), "2026-04-16");
  assertEquals(dataValida("2024-02-29"), "2024-02-29"); // bissexto
});

Deno.test("dataValida: rejeita formato errado e data inexistente", () => {
  for (const v of [
    "16/04/2026",
    "2026-4-16",
    "2026-02-31", // overflow silencioso do Date
    "2025-02-29", // não bissexto
    "hoje",
    null,
    undefined,
    20260416,
  ]) {
    assertEquals(dataValida(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

// ───────────────────────── normalizarItensPromo ─────────────────────────

Deno.test("normalizarItensPromo: mantém item bom e preserva o código verbatim", () => {
  const { itens, rejeitados } = normalizarItensPromo([
    {
      codigo_fornecedor: "YLO4.6269.02",
      descricao: " Verniz PU ",
      desconto_perc: 22.5,
      volume_minimo: 10,
    },
  ]);
  assertEquals(rejeitados.length, 0);
  assertEquals(itens.length, 1);
  assertEquals(itens[0].codigo_fornecedor, "YLO4.6269.02");
  assertEquals(itens[0].descricao, "Verniz PU");
  assertEquals(itens[0].desconto_perc, 22.5);
  assertEquals(itens[0].volume_minimo, 10);
});

Deno.test("normalizarItensPromo: item com desconto inválido é DESCARTADO, não gravado com 0", () => {
  const { itens, rejeitados } = normalizarItensPromo([
    { codigo_fornecedor: "DR.4403", desconto_perc: 20 },
    { codigo_fornecedor: "FL.6269.02", desconto_perc: null },
    { codigo_fornecedor: "FL.9999.01", desconto_perc: "vinte" },
    { codigo_fornecedor: "FL.8888.01", desconto_perc: 0 },
    { codigo_fornecedor: "FL.7777.01", desconto_perc: 250 },
  ]);
  assertEquals(itens.length, 1, "só o item válido deveria passar");
  assertEquals(itens[0].codigo_fornecedor, "DR.4403");
  assertEquals(rejeitados.length, 4);
  assert(
    rejeitados.every((r) => r.motivo.includes("desconto_perc")),
    "motivo deveria citar o campo",
  );
});

Deno.test("normalizarItensPromo: item sem código é descartado", () => {
  const { itens, rejeitados } = normalizarItensPromo([
    { codigo_fornecedor: "  ", desconto_perc: 10 },
    { desconto_perc: 10 },
  ]);
  assertEquals(itens.length, 0);
  assertEquals(rejeitados.length, 2);
});

Deno.test("normalizarItensPromo: volume_minimo ilegível vira null, não 0", () => {
  const { itens } = normalizarItensPromo([
    { codigo_fornecedor: "A", desconto_perc: 10, volume_minimo: "n/a" },
    { codigo_fornecedor: "B", desconto_perc: 10, volume_minimo: 0 },
    { codigo_fornecedor: "C", desconto_perc: 10 },
  ]);
  assertEquals(itens.map((i) => i.volume_minimo), [null, null, null]);
});

Deno.test("normalizarItensPromo: entrada não-array não explode", () => {
  assertEquals(normalizarItensPromo(null), { itens: [], rejeitados: [] });
  assertEquals(normalizarItensPromo("x"), { itens: [], rejeitados: [] });
});

// ─────────────────── normalizarCategoriasAumento ───────────────────

Deno.test("normalizarCategoriasAumento: categoria com aumento inválido é descartada", () => {
  const { categorias, rejeitadas } = normalizarCategoriasAumento([
    {
      categoria_fornecedor: "Poliuretano",
      aumento_perc: 7.5,
      data_vigencia_especifica: "2026-05-01",
    },
    { categoria_fornecedor: "Nitro", aumento_perc: null },
    { categoria_fornecedor: "Hidro", aumento_perc: 0 },
  ]);
  assertEquals(categorias.length, 1);
  assertEquals(categorias[0].categoria_fornecedor, "Poliuretano");
  assertEquals(categorias[0].aumento_perc, 7.5);
  assertEquals(categorias[0].data_vigencia_especifica, "2026-05-01");
  assertEquals(rejeitadas.length, 2);
});

Deno.test("normalizarCategoriasAumento: data específica inválida vira null sem derrubar a categoria", () => {
  const { categorias } = normalizarCategoriasAumento([
    {
      categoria_fornecedor: "Poliuretano",
      aumento_perc: 5,
      data_vigencia_especifica: "01/05/2026",
    },
  ]);
  assertEquals(categorias.length, 1);
  assertEquals(categorias[0].data_vigencia_especifica, null);
});

// ─────────────────────────── anotarRejeicoes ───────────────────────────

Deno.test("anotarRejeicoes: sem rejeição preserva a observação original", () => {
  assertEquals(anotarRejeicoes("tudo certo", []), "tudo certo");
});

Deno.test("anotarRejeicoes: rejeição aparece na observação do revisor", () => {
  const texto = anotarRejeicoes("obs original", [
    { codigo: "FL.1", motivo: "desconto_perc fora da faixa (0,100]: null" },
  ]);
  assert(texto.includes("obs original"), "deveria manter a observação");
  assert(texto.includes("DESCARTADA"), "deveria sinalizar o descarte");
  assert(texto.includes("FL.1"), "deveria citar o código descartado");
});
