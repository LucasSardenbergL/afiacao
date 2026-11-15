// Testa o CÓDIGO REAL de limites-anexo.ts no runtime Deno (scanner `03689f08`, lote 3).
// Roda com: deno test --no-remote supabase/functions/gmail-webhook-receiver/
import {
  conferirTetosAnexos,
  lerCorpoComTeto,
  TETO_ANEXO_BASE64,
  TETO_ANEXOS,
  TETO_CORPO_BYTES,
  TETO_MENSAGEM_BASE64,
} from "./limites-anexo.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function stream(pedacos: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of pedacos) c.enqueue(p);
      c.close();
    },
  });
}

const b64 = (n: number) => "A".repeat(n);

Deno.test("tetos: o corpo cabe a soma dos anexos mais o envelope", () => {
  assert(TETO_CORPO_BYTES > TETO_MENSAGEM_BASE64, "corpo precisa caber a mensagem cheia");
  assert(TETO_MENSAGEM_BASE64 >= TETO_ANEXO_BASE64, "mensagem precisa caber um anexo no teto");
});

Deno.test("conferirTetosAnexos: ausente e lista vazia passam", () => {
  assert(conferirTetosAnexos(undefined).ok, "undefined passa");
  assert(conferirTetosAnexos(null).ok, "null passa");
  assert(conferirTetosAnexos([]).ok, "[] passa");
});

Deno.test("conferirTetosAnexos: anexo exatamente no teto passa; 1 byte acima é recusado", () => {
  assert(conferirTetosAnexos([{ filename: "a.pdf", contentBase64: b64(TETO_ANEXO_BASE64) }]).ok, "no teto passa");
  const r = conferirTetosAnexos([{ filename: "a.pdf", contentBase64: b64(TETO_ANEXO_BASE64 + 1) }]);
  assert(!r.ok, "acima do teto é recusado");
  if (!r.ok) assert(r.erro.includes("teto por anexo"), `marca do ramo por anexo: ${r.erro}`);
});

Deno.test("conferirTetosAnexos: soma acima do teto da mensagem é recusada mesmo com cada anexo dentro", () => {
  const metade = Math.floor(TETO_ANEXO_BASE64 * 0.9);
  const n = Math.ceil(TETO_MENSAGEM_BASE64 / metade) + 1;
  assert(n <= TETO_ANEXOS, "o caso precisa caber no teto de quantidade");
  const lista = Array.from({ length: n }, (_, i) => ({ filename: `${i}.pdf`, contentBase64: b64(metade) }));
  const r = conferirTetosAnexos(lista);
  assert(!r.ok, "soma acima é recusada");
  if (!r.ok) assert(r.erro.includes("teto por mensagem"), `marca do ramo por mensagem: ${r.erro}`);
});

Deno.test("conferirTetosAnexos: quantidade acima do teto é recusada", () => {
  const lista = Array.from({ length: TETO_ANEXOS + 1 }, () => ({ filename: "x.png", contentBase64: "QQ==" }));
  const r = conferirTetosAnexos(lista);
  assert(!r.ok, "quantidade acima é recusada");
  if (!r.ok) assert(r.erro.includes(`o teto é ${TETO_ANEXOS}`), `marca do ramo de quantidade: ${r.erro}`);
  assert(conferirTetosAnexos(lista.slice(0, TETO_ANEXOS)).ok, "no teto de quantidade passa");
});

Deno.test("conferirTetosAnexos: tamanho desconhecido não passa (fail-closed)", () => {
  for (const ruim of [[null], [{ filename: "a.pdf" }], [{ contentBase64: 123 }], ["texto"]]) {
    const r = conferirTetosAnexos(ruim);
    assert(!r.ok, `deveria recusar ${JSON.stringify(ruim)}`);
    if (!r.ok) assert(r.erro.includes("sem conteúdo base64"), `marca do ramo ilegível: ${r.erro}`);
  }
  const naoLista = conferirTetosAnexos({ contentBase64: "QQ==" });
  assert(!naoLista.ok && naoLista.erro === "attachments não é uma lista", "objeto solto é recusado");
});

Deno.test("lerCorpoComTeto: corpo dentro do teto volta inteiro, mesmo em pedaços", async () => {
  const enc = new TextEncoder();
  const r = await lerCorpoComTeto(stream([enc.encode('{"a":'), enc.encode('"çã"}')]), 100);
  assert(r.ok && r.texto === '{"a":"çã"}', `texto remontado: ${JSON.stringify(r)}`);
  const vazio = await lerCorpoComTeto(null, 100);
  assert(vazio.ok && vazio.texto === "", "sem corpo é texto vazio");
});

Deno.test("lerCorpoComTeto: no teto passa; 1 byte acima é corpo_grande", async () => {
  const dez = new Uint8Array(10);
  const noTeto = await lerCorpoComTeto(stream([dez, dez]), 20);
  assert(noTeto.ok, "20 bytes com teto 20 passa");
  const acima = await lerCorpoComTeto(stream([dez, dez, new Uint8Array(1)]), 20);
  assert(!acima.ok && acima.motivo === "corpo_grande", `21 bytes é corpo_grande: ${JSON.stringify(acima)}`);
});

Deno.test("lerCorpoComTeto: stream que falha é corpo_ilegivel", async () => {
  const quebrado = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("rede caiu");
    },
  });
  const r = await lerCorpoComTeto(quebrado, 20);
  assert(!r.ok && r.motivo === "corpo_ilegivel", `falha de leitura: ${JSON.stringify(r)}`);
});
