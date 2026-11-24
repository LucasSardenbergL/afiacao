// Testa o CÓDIGO REAL de modalidade-os.ts no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync/modalidade-os_test.ts
import { modalidadeDaOs } from "./modalidade-os.ts";

function igual(veio: unknown, esperado: unknown, ctx: string) {
  const v = JSON.stringify(veio);
  const e = JSON.stringify(esperado);
  if (v !== e) throw new Error(`${ctx}: esperava ${e}, veio ${v}`);
}

Deno.test("as 4 modalidades do Novo Pedido são gravadas como vieram (não mais 'retirada' fixo)", () => {
  for (const m of ["coleta_entrega", "somente_coleta", "somente_entrega", "balcao"]) {
    igual(modalidadeDaOs(m), { valor: m, invalida: false }, m);
  }
});

Deno.test("front antigo (sem modalidade): o valor legado, sem acusar defeito", () => {
  igual(modalidadeDaOs(undefined), { valor: "retirada", invalida: false }, "undefined");
  igual(modalidadeDaOs(null), { valor: "retirada", invalida: false }, "null");
  igual(modalidadeDaOs(""), { valor: "retirada", invalida: false }, "vazio");
});

Deno.test("valor fora do vocabulário: legado, mas MARCADO inválido (o chamador loga)", () => {
  igual(modalidadeDaOs("entrega"), { valor: "retirada", invalida: true }, "entrega");
  igual(modalidadeDaOs("COLETA_ENTREGA"), { valor: "retirada", invalida: true }, "caixa");
  igual(modalidadeDaOs(3), { valor: "retirada", invalida: true }, "numero");
});

import { enderecoDaOs, turnoDaOs } from "./modalidade-os.ts";

const FILIAL = { street: "Rua B", number: "10", neighborhood: "Centro", city: "Serra", state: "ES", zip_code: "29160000", complement: "" };

Deno.test("coleta na filial: o endereço ESCOLHIDO vai à OS (sem o vazio), não o padrão do cliente", () => {
  igual(enderecoDaOs("somente_coleta", FILIAL), { street: "Rua B", number: "10", neighborhood: "Centro", city: "Serra", state: "ES", zip_code: "29160000" }, "filial");
});

Deno.test("balcão e legado não guardam endereço nem turno", () => {
  igual(enderecoDaOs("balcao", FILIAL), null, "balcao");
  igual(enderecoDaOs("retirada", FILIAL), null, "legado");
  igual(turnoDaOs("balcao", "tarde"), null, "turno-balcao");
  igual(turnoDaOs("retirada", "tarde"), null, "turno-legado");
});

Deno.test("endereço ausente/ilegível → null (o roteirizador cai no padrão, como antes)", () => {
  igual(enderecoDaOs("coleta_entrega", undefined), null, "ausente");
  igual(enderecoDaOs("coleta_entrega", ["Rua B"]), null, "array");
  igual(enderecoDaOs("coleta_entrega", { number: "10" }), null, "so-numero");
  igual(enderecoDaOs("coleta_entrega", { street: 7, city: "Serra" }), { city: "Serra" }, "nao-texto");
});

Deno.test("turno: o escolhido quando há rota; vazio/não-texto → null", () => {
  igual(turnoDaOs("somente_entrega", "tarde"), "tarde", "tarde");
  igual(turnoDaOs("coleta_entrega", ""), null, "vazio");
  igual(turnoDaOs("coleta_entrega", 2), null, "numero");
});
