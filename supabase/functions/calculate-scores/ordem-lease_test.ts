// GUARD ESTRUTURAL — o lease tem de ser reivindicado ANTES de qualquer leitura que alimente o payload.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/calculate-scores/
//
// POR QUE ESTE TESTE EXISTE (achado do challenge /codex): o harness PG17
// (db/test-calculate-scores-lease.sh) prova a RPC e o protocolo, mas NÃO prova que a EDGE chama o
// claim antes de ler o snapshot. Mover o `select('*')` para antes do claim reabre a corrida
// last-writer-wins inteira e deixa TODO o harness SQL verde — o payload voltaria a carregar valores
// lidos fora da exclusão mútua. Não há como cobrir isso em SQL; aqui a asserção é sobre a ORDEM no
// próprio fonte da edge.
//
// Por que ler o fonte como TEXTO em vez de importar o módulo: `test:edges` roda com `--no-remote`, e
// index.ts importa `npm:@supabase/supabase-js@2` — importá-lo colocaria o registry npm no caminho de
// entrega de todo PR (regra do CLAUDE.md sobre a suíte Deno).

const FONTE = new URL("./index.ts", import.meta.url);

/**
 * Remove comentários antes de medir a ordem.
 *
 * OBRIGATÓRIO, não higiene: os comentários deste arquivo citam `claim_calculate_scores` e
 * `farmer_client_scores` várias vezes, inclusive no bloco explicativo do topo — que vem ANTES de
 * tudo. Medir a ordem sobre o fonte cru casaria a PROSA e o assert ficaria verde mesmo com o
 * snapshot movido para antes do claim: o falso-verde do #1472/#1488, onde a defesa satisfaz o fiscal
 * que deveria fiscalizá-la.
 *
 * O `(?<!:)` preserva `https://` — sem ele um `://` seria lido como início de comentário e cortaria
 * o resto da linha.
 */
function semComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // blocos /* ... */
    .replace(/(?<!:)\/\/.*$/gm, "");    // linha // ... (preservando :// de URLs)
}

function idxOuFalha(codigo: string, agulha: string, rotulo: string): number {
  const i = codigo.indexOf(agulha);
  if (i < 0) {
    throw new Error(
      `nao encontrei ${rotulo} (${agulha}) no codigo da edge. ` +
      `Se o trecho foi renomeado, ATUALIZE este guard — nao o remova: ele e a unica prova de que o ` +
      `claim precede a leitura do snapshot.`,
    );
  }
  return i;
}

Deno.test("o claim do lease precede a leitura do snapshot de farmer_client_scores", () => {
  const codigo = semComentarios(Deno.readTextFileSync(FONTE));
  const claim = idxOuFalha(codigo, "claim_calculate_scores", "a chamada do claim");
  const snapshot = idxOuFalha(codigo, "from('farmer_client_scores')", "a leitura do snapshot");
  if (claim >= snapshot) {
    throw new Error(
      `ORDEM QUEBRADA: o snapshot (indice ${snapshot}) e lido ANTES do claim (indice ${claim}). ` +
      `O payload passaria a carregar valores lidos fora da exclusao mutua e a corrida ` +
      `last-writer-wins volta inteira.`,
    );
  }
});

// O Codex foi explícito: o claim deve preceder QUALQUER leitura que influencie o payload, não só o
// snapshot. Os pesos de farmer_algorithm_config entram no health_score de todas as 6.633 linhas.
Deno.test("o claim do lease precede a leitura dos pesos (farmer_algorithm_config)", () => {
  const codigo = semComentarios(Deno.readTextFileSync(FONTE));
  const claim = idxOuFalha(codigo, "claim_calculate_scores", "a chamada do claim");
  const config = idxOuFalha(codigo, "farmer_algorithm_config", "a leitura dos pesos");
  if (claim >= config) {
    throw new Error(`ORDEM QUEBRADA: os pesos (indice ${config}) sao lidos ANTES do claim (indice ${claim}).`);
  }
});

Deno.test("o lease e liberado (finalizar_calculate_scores presente)", () => {
  const codigo = semComentarios(Deno.readTextFileSync(FONTE));
  idxOuFalha(codigo, "finalizar_calculate_scores", "a liberacao do lease");
});

// Sem `.order()` o fatiamento por .range() pode repetir uma linha e OMITIR outra — e a omitida sai do
// recompute sem nenhum sinal. Os DOIS selects paginados de farmer_client_scores (o inicial e o
// re-fetch pos-seed) precisam da ordem estavel.
Deno.test("todo select paginado de farmer_client_scores tem .order() estavel", () => {
  const codigo = semComentarios(Deno.readTextFileSync(FONTE));
  const selects = [...codigo.matchAll(/from\('farmer_client_scores'\)\s*\.select\('\*'\)([\s\S]{0,200}?)\.range\(/g)];
  if (selects.length < 2) {
    throw new Error(
      `esperava >= 2 selects paginados de farmer_client_scores, achei ${selects.length}. ` +
      `Se a paginacao mudou de forma, atualize este guard.`,
    );
  }
  selects.forEach((m, i) => {
    if (!m[1].includes(".order(")) {
      throw new Error(`select paginado #${i + 1} nao tem .order() entre o .select('*') e o .range() — ordem indefinida entre paginas.`);
    }
  });
});
