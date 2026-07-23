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
      const semComentario = linha.replace(/\/\/.*$/, "");
      if (semComentario.includes(".range(")) {
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

// Guard do próprio gate: se um arquivo vigiado for renomeado/movido, o `readTextFile`
// acima lança e o teste fica vermelho — mas por "não achei", não por "está limpo". Este
// teste separa os dois casos, para que "o detector morreu" nunca se leia como aprovação.
Deno.test("gate: os arquivos vigiados existem e foram de fato lidos", async () => {
  for (const edge of VIGIADAS) {
    const url = new URL(`../${edge}/index.ts`, import.meta.url);
    const fonte = await Deno.readTextFile(url);
    if (fonte.length < 500) {
      throw new Error(`${edge}/index.ts tem ${fonte.length} bytes — arquivo errado?`);
    }
  }
});
