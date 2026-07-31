// Testa o CÓDIGO REAL de imagem.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/
//
// Foco: a detecção por magic bytes. O frontend aceita qualquer `image/*` e o
// código antigo rotulava TUDO como image/jpeg — o gateway sniffava e tolerava,
// a Anthropic recusa com 400. Um rótulo errado aqui derruba a análise inteira
// do pedido; um formato aceito calado sem estar na lista faz o mesmo.
import {
  detectarMediaTypeImagem,
  montarBlocoImagem,
} from "./imagem.ts";

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

/** Monta base64 a partir de bytes crus — é assim que o arquivo real chega. */
function b64(bytes: number[]): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const CORPO = Array.from({ length: 40 }, (_, i) => i % 256);

const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, ...CORPO]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...CORPO]);
const GIF87 = b64([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, ...CORPO]);
const GIF89 = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...CORPO]);
// RIFF + 4 bytes de tamanho + WEBP
const WEBP = b64([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, ...CORPO,
]);
// Container RIFF que NÃO é webp (WAVE) — precisa ser rejeitado.
const WAVE = b64([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45, ...CORPO,
]);
// HEIC: foto de iPhone. `ftypheic` no offset 4. A Anthropic não aceita.
const HEIC = b64([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x68, 0x65, 0x69, 0x63, ...CORPO,
]);
const BMP = b64([0x42, 0x4d, 0x36, 0x00, ...CORPO]);
const PDF = b64([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, ...CORPO]);

// ─────────────────────── detectarMediaTypeImagem ───────────────────────

Deno.test("detecta os 4 formatos que a Anthropic aceita, pelos magic bytes", () => {
  assertEquals(detectarMediaTypeImagem(JPEG), "image/jpeg");
  assertEquals(detectarMediaTypeImagem(PNG), "image/png");
  assertEquals(detectarMediaTypeImagem(GIF87), "image/gif");
  assertEquals(detectarMediaTypeImagem(GIF89), "image/gif");
  assertEquals(detectarMediaTypeImagem(WEBP), "image/webp");
});

Deno.test("PNG NÃO é rotulado como jpeg — a regressão que motivou o helper", () => {
  // O código antigo mandava `data:image/jpeg;base64,<png>`; o Gemini sniffava
  // e engolia, a Anthropic devolve 400 e o vendedor perde a análise inteira.
  assertEquals(detectarMediaTypeImagem(PNG), "image/png");
  const r = montarBlocoImagem(PNG);
  assert(r.ok, "png deveria ser aceito");
  if (!r.ok) return;
  assertEquals(r.bloco.source.media_type, "image/png");
});

Deno.test("formato fora da lista da Anthropic é rejeitado, não adivinhado", () => {
  for (const [nome, dados] of [["heic", HEIC], ["bmp", BMP], ["pdf", PDF], ["wave", WAVE]] as const) {
    assertEquals(detectarMediaTypeImagem(dados), null, `${nome} deveria dar null`);
  }
});

Deno.test("RIFF só vira webp com o marcador WEBP no offset 8", () => {
  // Sem o segundo pedaço da assinatura, WAV/AVI passariam por imagem.
  assertEquals(detectarMediaTypeImagem(WAVE), null);
  assertEquals(detectarMediaTypeImagem(WEBP), "image/webp");
});

Deno.test("base64 ilegível/vazio/curto degrada para null, não explode", () => {
  for (const v of ["", "   ", "!!!!", "@@", "A", "aa"]) {
    assertEquals(detectarMediaTypeImagem(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("aceita data-URI inteiro além do base64 puro", () => {
  assertEquals(detectarMediaTypeImagem(`data:image/png;base64,${PNG}`), "image/png");
  // Rótulo do data-URI é IGNORADO: valem os bytes, não o que o caller diz.
  assertEquals(detectarMediaTypeImagem(`data:image/jpeg;base64,${PNG}`), "image/png");
});

Deno.test("whitespace no meio do base64 não quebra a detecção", () => {
  const comQuebras = PNG.slice(0, 8) + "\n  " + PNG.slice(8);
  assertEquals(detectarMediaTypeImagem(comQuebras), "image/png");
});

// ─────────────────────────── montarBlocoImagem ───────────────────────────

Deno.test("montarBlocoImagem: bloco no formato de content block da Anthropic", () => {
  const r = montarBlocoImagem(JPEG);
  assert(r.ok, "jpeg deveria ser aceito");
  if (!r.ok) return;
  assertEquals(r.bloco.type, "image");
  assertEquals(r.bloco.source.type, "base64");
  assertEquals(r.bloco.source.media_type, "image/jpeg");
  assertEquals(r.bloco.source.data, JPEG);
});

Deno.test("montarBlocoImagem: HEIC dá erro ACIONÁVEL (é o caso do iPhone)", () => {
  const r = montarBlocoImagem(HEIC);
  assert(!r.ok, "heic deveria ser rejeitado");
  if (r.ok) return;
  assert(r.erro.includes("HEIC"), "erro deveria citar HEIC");
  assert(r.erro.includes("JPEG"), "erro deveria dizer o que fazer");
});

Deno.test("montarBlocoImagem: cabeçalho válido + corpo corrompido é REJEITADO", () => {
  // A detecção só lê os magic bytes; sem checar o formato inteiro, arquivo
  // truncado passaria e só viraria 400 na API, com a análise já perdida.
  const corrompido = JPEG.slice(0, 12) + "!!!$$$@@@";
  const r = montarBlocoImagem(corrompido);
  assert(!r.ok, "base64 malformado deveria ser rejeitado");
  if (r.ok) return;
  assert(r.erro.includes("corrompido"), "erro deveria dizer que o arquivo está corrompido");
});

Deno.test("montarBlocoImagem: comprimento fora do múltiplo de 4 é rejeitado", () => {
  assert(!montarBlocoImagem(JPEG + "A").ok, "truncado deveria ser rejeitado");
});


Deno.test("montarBlocoImagem: o data-URI é removido dos dados enviados", () => {
  const r = montarBlocoImagem(`data:image/png;base64,${PNG}`);
  assert(r.ok, "deveria aceitar");
  if (!r.ok) return;
  assert(!r.bloco.source.data.startsWith("data:"), "o prefixo não pode ir para a API");
  assertEquals(r.bloco.source.data, PNG);
});
