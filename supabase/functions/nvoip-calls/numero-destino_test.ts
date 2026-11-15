// Testa o CÓDIGO REAL de numero-destino.ts no runtime Deno (scanner Lovable Security, lote 3).
// Roda com: deno test --no-remote supabase/functions/nvoip-calls/
import { validarNumeroDestino } from "./numero-destino.ts";

function aceita(entrada: unknown, esperado: string) {
  const r = validarNumeroDestino(entrada);
  if (!r.ok || r.numero !== esperado) {
    throw new Error(`${JSON.stringify(entrada)} deveria virar ${esperado}; veio ${JSON.stringify(r)}`);
  }
}

function recusa(entrada: unknown) {
  const r = validarNumeroDestino(entrada);
  if (r.ok) throw new Error(`${JSON.stringify(entrada)} deveria ser recusado; veio ${r.numero}`);
  if (!r.erro.startsWith("Número inválido.")) throw new Error(`marca do ramo de recusa: ${r.erro}`);
}

Deno.test("aceita o formato nacional que o front já manda (normalizeBrPhone)", () => {
  aceita("37999999999", "37999999999");
  aceita("3732221234", "3732221234");
  aceita("11987654321", "11987654321");
});

Deno.test("aceita máscara, +55, 55 e zero de longa distância, sempre devolvendo o nacional", () => {
  aceita("(37) 99999-9999", "37999999999");
  aceita("+55 37 99999-9999", "37999999999");
  aceita("5537999999999", "37999999999");
  aceita("037999999999", "37999999999");
  aceita("03732221234", "3732221234");
  aceita("0 15 37 3222-1234", "3732221234");
  aceita("037.3222.1234", "3732221234");
  aceita(37999999999, "37999999999");
});

Deno.test("aceita 0800", () => {
  aceita("0800 123 4567", "08001234567");
});

Deno.test("recusa tarifado, internacional, curto e DDD inválido", () => {
  recusa("0900 123 4567");
  recusa("0300 123 4567");
  recusa("0500 123 4567");
  recusa("+1 212 555 1234");
  recusa("+351 912 345 678");
  recusa("190");
  recusa("99999999"); // sem DDD: o front aplica o DDD padrão antes de mandar
  recusa("01999999999"); // DDD com zero
  recusa("10999999999"); // DDD com zero
  recusa("3799999999"); // 10 dígitos começando com 9: celular sem o nono dígito
  recusa("37199999999"); // 11 dígitos sem o 9
  recusa("379999999999"); // 12 dígitos
});

Deno.test("recusa tipo errado, vazio, símbolo de DTMF e entrada gigante", () => {
  recusa(undefined);
  recusa(null);
  recusa("");
  recusa({ numero: "37999999999" });
  recusa("37999999999,123");
  recusa("37999999999#");
  recusa("*37999999999");
  recusa("tel:37999999999");
  recusa("3".repeat(41));
});
