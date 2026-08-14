// Gate de REGRESSÃO do marco causal de existência do PO (money-path).
//
// O invariante desta entrega é de ORDEM e de PROCEDÊNCIA, e nenhum dos dois sobrevive num teste de
// comportamento: o SQL não enxerga QUANDO a edge leu o marco nem DE ONDE ele veio, e a prova PG17
// (db/test-po-inexistente-antes-de.sh) só mostra o que o guard faz com um valor já gravado. Se alguém
// trocar a leitura do relógio do BANCO por um relógio da edge, ou movê-la para DEPOIS da resposta do
// Omie, o banco continua verde e a coluna volta a carregar o defeito do #1718 — carimbo POSTERIOR ao
// nascimento do PO, com o qual a supressão do card deixa de ser dedutível (docs/agent/money-path.md §2,
// "o RELÓGIO DA TRANSAÇÃO mente"). Daí um gate sobre a FONTE.
//
// Os predicados são substring pura sobre linha sem comentário — a lição recorrente do money-path é que
// assert esperto sobre texto mente (§"O ALVO mente", §"O DETECTOR mente"). Cada um roda contra o arquivo
// REAL e contra fixtures de controle: o pós-fix (tem de passar) e a sabotagem (tem de reprovar). Sem o
// par de controles, um predicado que não casa nada ficaria verde para sempre.
//
// Sem import remoto (`jsr:`/`npm:`): `test:edges` roda com --no-remote e o jsr.io entraria no caminho de
// entrega de TODO PR (CLAUDE.md). Asserção é `throw new Error`, como nos outros gates de fonte.

const ALVO = "disparar-pedidos-aprovados";
const COLUNA = "omie_po_inexistente_antes_de";
const RPC = "reposicao_marco_pre_omie";

/**
 * Neutraliza comentário antes de qualquer predicado. Sem isto o gate mede PROSA: este arquivo e o
 * `index.ts` CITAM o relógio da edge de propósito, para explicar por que ele não serve aqui — e a
 * citação dispararia o gate com o código íntegro (falso-VERMELHO). "" quando a linha é só comentário.
 */
function semComentario(linha: string): string {
  const t = linha.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  return linha.replace(/\/\/.*$/, "");
}

const codigo = (fonte: string): string[] => fonte.split("\n").map(semComentario);

/** Linhas (1-indexed) em que a coluna do marco recebe valor. */
function atribuicoesDaColuna(fonte: string): number[] {
  return codigo(fonte)
    .map((l, i) => (l.includes(`${COLUNA}:`) ? i + 1 : 0))
    .filter((n) => n > 0);
}

/** Linhas em que a coluna do marco recebe um relógio da EDGE — o defeito que esta entrega elimina. */
function atribuicoesComRelogioDaEdge(fonte: string): number[] {
  return codigo(fonte)
    .map((l, i) => (l.includes(`${COLUNA}:`) && l.includes("new Date(") ? i + 1 : 0))
    .filter((n) => n > 0);
}

/** Primeira ocorrência (1-indexed) de uma substring em linha de CÓDIGO; 0 se não houver. */
function primeiraLinha(fonte: string, agulha: string): number {
  const i = codigo(fonte).findIndex((l) => l.includes(agulha));
  return i < 0 ? 0 : i + 1;
}

async function lerAlvo(): Promise<string> {
  const fonte = await Deno.readTextFile(new URL(`../${ALVO}/index.ts`, import.meta.url));
  if (fonte.length < 10_000) {
    throw new Error(`${ALVO}/index.ts tem ${fonte.length} bytes — arquivo errado?`);
  }
  return fonte;
}

Deno.test("G1 o marco NUNCA vem do relógio da edge", async () => {
  const ofensas = atribuicoesComRelogioDaEdge(await lerAlvo());
  if (ofensas.length > 0) {
    throw new Error(
      `${ALVO}/index.ts:${ofensas.join(",")} — ${COLUNA} recebeu new Date(). Esse é o carimbo ` +
        `POSTERIOR ao nascimento do PO, o defeito do #1718: comparado com finalizado_em ele suprime ` +
        `alerta VERDADEIRO (caso 281/286, ~R$3.060 comprados em dobro). O valor tem de vir de ` +
        `lerMarcoPreOmie() — RPC ${RPC}, clock_timestamp() do banco.`,
    );
  }
});

Deno.test("G1b o predicado de G1 tem dente", () => {
  const sabotado = `        ${COLUNA}: new Date().toISOString(),`;
  if (atribuicoesComRelogioDaEdge(sabotado).length !== 1) {
    throw new Error("G1 não acusaria o relógio da edge — predicado sem dente");
  }
  // ...e a MESMA linha em comentário não pode acusar: é assim que o index.ts documenta o defeito.
  if (atribuicoesComRelogioDaEdge(`        // ${COLUNA}: new Date().toISOString(),`).length !== 0) {
    throw new Error("G1 acusa comentário — mediria a prosa, não o código");
  }
});

Deno.test("G2 o marco é lido ANTES de IncluirPedCompra", async () => {
  const fonte = await lerAlvo();
  const leitura = primeiraLinha(fonte, "lerMarcoPreOmie(db,");
  const chamada = primeiraLinha(fonte, '"IncluirPedCompra"');
  if (leitura === 0) throw new Error(`${ALVO}/index.ts: não achei a leitura do marco (lerMarcoPreOmie(db, ...))`);
  if (chamada === 0) throw new Error(`${ALVO}/index.ts: não achei a chamada IncluirPedCompra`);
  if (leitura >= chamada) {
    throw new Error(
      `${ALVO}/index.ts: o marco é lido na linha ${leitura}, DEPOIS de IncluirPedCompra (linha ` +
        `${chamada}). Lido depois ele deixa de preceder o nascimento do PO, e a supressão do card ` +
        `volta a ser indedutível. A ORDEM é o invariante — não a existência da chamada.`,
    );
  }
});

Deno.test("G2b o predicado de G2 tem dente", () => {
  const invertido = [
    'const r = await omieCall(u, "IncluirPedCompra", p, c);',
    "const m = await lerMarcoPreOmie(db, pedido.id);",
  ].join("\n");
  const leitura = primeiraLinha(invertido, "lerMarcoPreOmie(db,");
  const chamada = primeiraLinha(invertido, '"IncluirPedCompra"');
  if (!(leitura > chamada)) throw new Error("G2 não veria a ordem invertida — predicado sem dente");
});

Deno.test("G3 só o caminho de INCLUSÃO carimba (a reconciliação, não)", async () => {
  const linhas = atribuicoesDaColuna(await lerAlvo());
  if (linhas.length !== 1) {
    throw new Error(
      `${ALVO}/index.ts: ${COLUNA} é atribuída em ${linhas.length} lugar(es) (linha(s) ` +
        `${linhas.join(", ")}); esperado exatamente 1. Só o UPDATE de sucesso do IncluirPedCompra pode ` +
        `carimbar: no caminho de reconciliação o Omie já recusou por "já cadastrado", então o PO nasceu ` +
        `ANTES da chamada e um marco lido ali é limite inferior INVÁLIDO — suprimiria o card de um PO ` +
        `possivelmente excluído.`,
    );
  }
});

Deno.test("G3b o predicado de G3 tem dente", () => {
  const dois = [`  ${COLUNA}: marco,`, `  ${COLUNA}: marcoDaReconciliacao,`].join("\n");
  if (atribuicoesDaColuna(dois).length !== 2) {
    throw new Error("G3 não contaria o 2º carimbo — predicado sem dente");
  }
});

Deno.test("G4 o nome da RPC casa com o da migration", async () => {
  if (primeiraLinha(await lerAlvo(), `db.rpc("${RPC}")`) === 0) {
    throw new Error(
      `${ALVO}/index.ts: não achei db.rpc("${RPC}"). O nome é contrato com a migration ` +
        `20260814022626 — renomear de um lado só deixa a edge sem marco (fail-closed, mas silencioso).`,
    );
  }
});
