// Gate de REGRESSÃO: as edges abaixo não paginam à mão — delegam a `_shared/paginate.ts`
// (via `fetchAll`) ou aos loaders de `_shared/mapas-paginados.ts`.
//
// Por que um gate de FONTE e não só teste de comportamento: o defeito desta família não
// mora no helper, mora na REESCRITA à mão do laço. `fetchAll` já era testado quando estes
// seis laços foram escritos — e eles reintroduziram o mesmo bug por fora, invisíveis a
// qualquer grep do nome do helper (docs/agent/money-path.md §7). Só um gate que olha o
// call-site pega a reintrodução.
//
// O predicado é substring pura (`.range(`), não regex: a lição recorrente do money-path é
// que assert esperto sobre texto mente (§"O ALVO mente", §"O DETECTOR mente"). Aqui o
// invariante é literal e binário — nestes arquivos a paginação é delegada, ponto. Quem
// precisar de `.range()` numa edge nova não é barrado; só estes arquivos são vigiados.
//
// Falsificado: reintroduzir um `.range(` em qualquer um dos cinco deixa este teste
// VERMELHO nomeando arquivo e linha.

/**
 * Neutraliza comentário antes de qualquer predicado. Sem isto o gate mede PROSA: o próprio
 * `omie-cliente` documenta em JSDoc por que usa keyset "e não `.range()`", e essa frase
 * disparava o teste com o código íntegro (falso-VERMELHO pego na falsificação). É o
 * `stripComments` que o money-path.md §"O ALVO mente" exige de todo assert sobre texto.
 * Devolve "" quando a linha inteira é comentário (`//`, `/*`, ` *`).
 */
function semComentario(linha: string): string {
  const t = linha.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  return linha.replace(/\/\/.*$/, "");
}

// Edges que já tiveram paginação artesanal e foram convertidas.
const VIGIADAS = [
  "carteira-positivacao-snapshot",
  "scoring-recalc-batch",
  "visit-score-recalc-batch",
  "sync-reprocess",
  "omie-vendas-sync",
];

Deno.test("edges convertidas não paginam à mão (sem .range() no call-site)", async () => {
  const ofensas: string[] = [];

  for (const edge of VIGIADAS) {
    const url = new URL(`../${edge}/index.ts`, import.meta.url);
    const fonte = await Deno.readTextFile(url);
    fonte.split("\n").forEach((linha, i) => {
      // Comentário não conta: o arquivo pode (e deve) EXPLICAR por que não usa .range().
      const codigo = semComentario(linha);
      if (codigo.includes(".range(")) {
        ofensas.push(`${edge}/index.ts:${i + 1}: ${linha.trim()}`);
      }
    });
  }

  if (ofensas.length > 0) {
    throw new Error(
      `paginação artesanal reintroduzida em ${ofensas.length} ponto(s) — use fetchAll ` +
        `(_shared/paginate.ts) ou um loader de _shared/mapas-paginados.ts:\n  ` +
        ofensas.join("\n  "),
    );
  }
});

// ── Segunda vigilância: a variante da classe que o gate acima NÃO pega ────────────────
// As VIGIADAS delegam a LOADERS, então "zero `.range(` no call-site" é o predicado certo
// para elas. Já quem chama `fetchAll` DIRETO tem um `.range(from, to)` legítimo dentro do
// callback — proibi-lo seria vermelho por uso correto. Para esses o invariante é o OUTRO
// meio da classe (money-path.md §7): sem `.order()` numa coluna estável, o `.range()` pode
// PULAR ou DUPLICAR linhas entre páginas, e o helper que lança no erro não protege disso.
//
// Foi exatamente o segundo defeito do 7º sítio (#1563, `sync_addresses`): o laço à mão não
// tinha `.order()`, então o Set de user_ids saía não-determinístico a cada execução.
//
// Predicado literal de novo (substring `.order(` na expressão encadeada, 6 linhas de janela)
// — nada de regex esperta sobre texto, pela lição recorrente do §"O ALVO mente".
const VIGIADAS_ORDER = ["omie-cliente"];

Deno.test("edges com fetchAll direto: todo .range( tem .order( na mesma expressão", async () => {
  const ofensas: string[] = [];

  for (const edge of VIGIADAS_ORDER) {
    const url = new URL(`../${edge}/index.ts`, import.meta.url);
    const linhas = (await Deno.readTextFile(url)).split("\n");
    linhas.forEach((linha, i) => {
      if (!semComentario(linha).includes(".range(")) return;
      // `.from().select()...order().range()` cabe folgado em 6 linhas de encadeamento.
      const janela = linhas
        .slice(Math.max(0, i - 6), i + 1)
        .map(semComentario)
        .join("\n");
      if (!janela.includes(".order(")) {
        ofensas.push(`${edge}/index.ts:${i + 1}: ${linha.trim()}`);
      }
    });
  }

  if (ofensas.length > 0) {
    throw new Error(
      `.range() sem .order() estável em ${ofensas.length} ponto(s) — o Postgres não garante ` +
        `a mesma sequência entre páginas, então a paginação pula/duplica linhas ` +
        `(docs/agent/money-path.md §7):\n  ` + ofensas.join("\n  "),
    );
  }
});

// Guard do próprio gate: se um arquivo vigiado for renomeado/movido, o `readTextFile`
// acima lança e o teste fica vermelho — mas por "não achei", não por "está limpo". Este
// teste separa os dois casos, para que "o detector morreu" nunca se leia como aprovação.
Deno.test("gate: os arquivos vigiados existem e foram de fato lidos", async () => {
  for (const edge of [...VIGIADAS, ...VIGIADAS_ORDER]) {
    const url = new URL(`../${edge}/index.ts`, import.meta.url);
    const fonte = await Deno.readTextFile(url);
    if (fonte.length < 500) {
      throw new Error(`${edge}/index.ts tem ${fonte.length} bytes — arquivo errado?`);
    }
  }
});
