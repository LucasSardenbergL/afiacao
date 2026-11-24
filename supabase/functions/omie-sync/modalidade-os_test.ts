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
