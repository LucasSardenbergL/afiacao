/**
 * Gate estrutural — nenhuma edge pode apagar `farmer_association_rules` por conta própria.
 *
 * A tabela é GLOBAL (sem farmer_id) e alimenta cinco consumidores que não distinguem
 * "sem regra" de "tabela zerada": `get_meu_mixgap` (card MixGap), `melhoria_produtos_
 * relacionados` (canal Melhorias), a edge `recommend` (assoc_score), o `useCrossSellEngine`
 * e o bundle engine. O writer daqui fazia `delete()` de tudo e depois um INSERT POR REGRA,
 * com o `error` só decrementando um contador — falha no meio deixava a tabela vazia ou pela
 * metade, e o retorno seguia dizendo "N regras geradas".
 *
 * A troca inteira passou a ir por `farmer_association_rules_substituir`, que faz DELETE+INSERT
 * numa transação (migration 20260729120000, provada em db/test-farmer-association-rules-
 * atomica.sh). Este teste trava a regressão: um `delete()` direto aqui volta a ser possível
 * de digitar, mas não de mergear.
 *
 * Estrutural em vez de comportamental porque a lógica que mudou é I/O puro: `index.ts` importa
 * `serve` de URL remota e `test:edges` roda com `--no-remote`, então importá-lo derrubaria a
 * entrega de todo PR. A garantia de comportamento vive no harness PG17 (26 asserts).
 */

// Asserts locais: `test:edges` roda com `--no-remote`, então um `import "jsr:…"` aqui poria
// o jsr.io no caminho de entrega de TODO PR. Mesmo padrão de paginate_test.ts.
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertListaVazia(itens: string[], msg: string): void {
  if (itens.length > 0) throw new Error(`${msg}\n  - ${itens.join("\n  - ")}`);
}

const RAIZ = "supabase/functions";

async function* arquivosTs(dir: string): AsyncGenerator<string> {
  for await (const entrada of Deno.readDir(dir)) {
    const caminho = `${dir}/${entrada.name}`;
    if (entrada.isDirectory) yield* arquivosTs(caminho);
    else if (entrada.name.endsWith(".ts")) yield caminho;
  }
}

/** Colapsa espaços/quebras pra pegar a cadeia mesmo formatada em várias linhas. */
const normalizar = (s: string) => s.replace(/\s+/g, "");

const PROIBIDOS = [
  `from("farmer_association_rules").delete(`,
  `from('farmer_association_rules').delete(`,
];

Deno.test("nenhuma edge apaga farmer_association_rules direto", async () => {
  const infratores: string[] = [];

  for await (const caminho of arquivosTs(RAIZ)) {
    if (caminho.endsWith("assoc-rules-substituicao_test.ts")) continue; // as strings-alvo vivem aqui
    const codigo = normalizar(await Deno.readTextFile(caminho));
    if (PROIBIDOS.some((p) => codigo.includes(normalizar(p)))) infratores.push(caminho);
  }

  assertListaVazia(
    infratores,
    "troque via RPC farmer_association_rules_substituir (DELETE+INSERT numa transação), não com .delete():",
  );
});

Deno.test("o writer de omie-analytics-sync usa a RPC de substituição", async () => {
  const codigo = await Deno.readTextFile(`${RAIZ}/omie-analytics-sync/index.ts`);

  assert(
    normalizar(codigo).includes(normalizar(`rpc("farmer_association_rules_substituir"`)),
    "computeAssociationRules deve trocar o lote pela RPC atômica",
  );
  // O erro tem que subir: engoli-lo era o que fazia a falha virar "sucesso com 0 regras".
  assert(
    /erroSubstituir[\s\S]{0,200}throw/.test(codigo),
    "o erro da RPC precisa ser propagado, não logado e esquecido",
  );
});
