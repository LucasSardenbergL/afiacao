// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/
import { normalizarNcm } from "./ncm.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("normalizarNcm (_shared): NCM pontuado do Omie vira os 8 dígitos que cabem na coluna", () => {
  assertEquals(normalizarNcm("2909.60.90"), "29096090");
  assertEquals(normalizarNcm("29096090"), "29096090");
  assertEquals(normalizarNcm(" 2909.60.90 "), "29096090");
});

Deno.test("normalizarNcm (_shared): sufixo depois de separador (EX TIPI) não entra", () => {
  assertEquals(normalizarNcm("3920.49.00.01"), "39204900");
  assertEquals(normalizarNcm("3920.49.00-EX01"), "39204900");
});

Deno.test("normalizarNcm (_shared): forma irreconhecível é AUSENTE (null), nunca código fabricado", () => {
  for (const ruim of [null, undefined, "", "2909.60", "290960901", "abcd.ef.gh", "29096"]) {
    assertEquals(normalizarNcm(ruim), null, `${JSON.stringify(ruim)} deveria ser null`);
  }
});

Deno.test("normalizarNcm (_shared): a sync usa a MESMA função — re-exporta daqui, ou mantém cópia byte-idêntica", async () => {
  // Relativo a ESTE arquivo (import.meta.url), não ao CWD: o teste roda igual de qualquer pasta.
  const daSync = await Deno.readTextFile(new URL("../omie-nfe-recebimento-sync/itens.ts", import.meta.url));
  const daqui = await Deno.readTextFile(new URL("./ncm.ts", import.meta.url));
  // Estado final (PR da RPC): a sync re-exporta daqui — uma fonte só.
  if (/export\s*\{[^}]*\bnormalizarNcm\b[^}]*\}\s*from\s*["']\.\.\/_shared\/ncm\.ts["']/.test(daSync)) return;
  // Estado transitório: cópia na sync, que não pode divergir desta.
  const corpo = (s: string) => {
    const m = /^export function normalizarNcm[\s\S]*?\n}\n/m.exec(s);
    if (!m) throw new Error("normalizarNcm não encontrada (nem função, nem re-export de _shared/ncm.ts)");
    return m[0];
  };
  assertEquals(corpo(daSync), corpo(daqui), "os dois corpos de normalizarNcm divergiram");
});
