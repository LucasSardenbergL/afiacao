// C16: o retrato vai ao Chrome pelo TEXTO do `.toString()` que o Deno produz. Aqui ele é reavaliado a partir desse
// texto, sem o escopo do módulo, e EXECUTADO contra um documento mínimo (helper externo vira ReferenceError). O
// comportamento contra HTML é provado em `scripts/sayerlack-portal-dom.test.ts` (vitest + jsdom).
import { diagnosticarCondicaoDom } from "./condicao-dom.ts";

function igual(a: unknown, e: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${msg}: esperado ${JSON.stringify(e)}, veio ${JSON.stringify(a)}`);
}

Deno.test("C16: o retrato serializado roda sem o escopo do módulo e sem crase", () => {
  const src = diagnosticarCondicaoDom.toString();
  igual(src.includes("`"), false, "sem crase no texto serializado");
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  g.document = { querySelector: () => null, querySelectorAll: () => [] };
  try {
    igual(new Function(`return (${src});`)()(), {
      caminho: "", titulo: "", select_presente: false, select_n_opcoes: null, select_selecionada: null,
      select_desabilitado: null, selects: [], campos: [], textos: [], n_iframes: 0,
      omitidos: { selects: 0, campos: 0, textos: 0 },
    }, "retrato de página vazia");
  } finally {
    delete g.document;
  }
});
