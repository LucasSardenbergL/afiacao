// Fiação do relógio Omie nos DOIS wrappers que escrevem (M-33 p3). Os `index.ts` importam npm:/remoto e
// não carregam sob `--no-remote`, então o comportamento mora em omie-chamada-relogio_test.ts e AQUI
// fica só o que aquela suíte não alcança: que o wrapper de verdade USA o módulo do jeito certo.
// Pedido explícito do challenge Codex: "remover o guard ali não é falsificado pela suíte isolada".
// Cada asserção casa a forma ESCRITA no fonte (sem comentários) e nomeia o vínculo que protege.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/omie-chamada-relogio-fiacao_test.ts

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Sem comentários de linha (o fiscal não pode ser satisfeito pela EXPLICAÇÃO do vínculo) e com
// espaços colapsados (o formatador pode quebrar linhas sem mudar o vínculo).
function codigo(texto: string): string {
  return texto
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ");
}

// Corpo da função: da assinatura até o `}` de coluna 0 seguinte.
function corpoDe(fonte: string, assinatura: string): string {
  const i = fonte.indexOf(assinatura);
  assert(i >= 0, `não achei ${assinatura}`);
  const fim = fonte.indexOf("\n}\n", i);
  assert(fim > i, `não achei o fim de ${assinatura}`);
  return codigo(fonte.slice(i, fim));
}

function ordem(corpo: string, nomes: string[], trechos: string[]) {
  let pos = -1;
  trechos.forEach((t, k) => {
    const j = corpo.indexOf(t, pos + 1);
    assert(j > pos, `fiação: "${nomes[k]}" ausente ou fora de ordem (procurei: ${t})`);
    pos = j;
  });
}

const RAIZ = new URL("..", import.meta.url);
const vendas = corpoDe(await Deno.readTextFile(new URL("omie-vendas-sync/index.ts", RAIZ)), "async function callOmieVendasApi(");
const sync = corpoDe(await Deno.readTextFile(new URL("omie-sync/index.ts", RAIZ)), "async function callOmieApi(");

Deno.test("vendas: o prazo nasce FORA do laço e o relógio envolve a trava inteira com o signal no fetch e no corpo", () => {
  ordem(vendas, [
    "deadline antes do laço",
    "laço de tentativas",
    "chamarComRelogio envolvendo",
    "comVezOmie dentro dele",
    "fetch",
    "signal no fetch",
    "corpo lido DENTRO do callback",
    "teto da espera pela trava",
    "opções do relógio com o deadline",
  ], [
    "const deadline = prazoDaChamadaOmie(Date.now());",
    "for (let attempt = 0;",
    "await chamarComRelogio(",
    "comVezOmie(",
    "await fetch(",
    "signal, });",
    "await response.json()",
    "{ tetoEsperaMs: tetoEsperaTravaMs(Date.now(), deadline) }",
    "{ metodo: call, conta: account, deadline, sinalExtra: sinalDaChamada(call), envioAnteriorAmbiguo: envioAmbiguo }",
  ]);
});

Deno.test("vendas: transitório ambíguo em escrita não-repetível PARA; o sono exige o prazo; esgotar após ambíguo é indeterminado", () => {
  ordem(vendas, [
    "decisão por método ANTES do sono",
    "marca o envio ambíguo",
    "sono só se couber no prazo",
    "esgotado após ambíguo → indeterminada (antes do OMIE_TRANSIENT/null)",
    "semântica antiga do esgotado",
  ], [
    'if (decidirFaultTransitorio(call, isRateLimit) === "indeterminada") throw erroEscritaAmbigua(call, account, fs);',
    "if (!isRateLimit && ehEscritaOmie(call)) envioAmbiguo = true;",
    "&& cabeEspera(Date.now(), deadline, delay)) {",
    "if (envioAmbiguo) throw erroEscritaAmbigua(call, account, fs);",
    "if (opts?.throwOnTransient) {",
  ]);
});

Deno.test("omie-sync: um fetch só, dentro do relógio, com signal e corpo lido dentro", () => {
  ordem(sync, ["chamarComRelogio", "fetch", "signal no fetch", "corpo dentro", "prazo da chamada"], [
    "await chamarComRelogio(async (signal) => {",
    "await fetch(",
    "signal, });",
    "await response.json();",
    "deadline: prazoDaChamadaOmie(Date.now()) });",
  ]);
  assert(sync.split("await fetch(").length === 2, "omie-sync: fetch fora do relógio");
});
