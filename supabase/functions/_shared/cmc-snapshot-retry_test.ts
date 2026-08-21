// Política de retentativa do `callOmie` das edges `cmc-snapshot-smoke` e `cmc-snapshot-backfill` —
// prova de EQUIVALÊNCIA. Roda com:
//   deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/cmc-snapshot-retry_test.ts
//
// ── O que este arquivo protege ────────────────────────────────────────────────────────────────
// As duas edges classificavam falha do Omie com um bloco ad-hoc IDÊNTICO, com dois defeitos que o
// helper canônico `omie-falha.ts` já resolve:
//   1. códigos HTTP CRUS ("502"/"503"/"504"/"500") — o dígito casa DENTRO do identificador que a
//      própria mensagem ecoa (money-path §"O MARCADOR mente", #1614): a app_key de
//      `"Chave de acesso não cadastrada para o aplicativo [1503123456]"` contém `503`, então o erro
//      PERMANENTE mais comum do Omie era lido como transitório e queimava as 4 retentativas;
//   2. marcadores ACENTUADOS ("já existe uma requisição") contra texto que só passou por
//      `.toLowerCase()` — sem NFD, a mesma frase emitida sem acento não casava nada.
//
// Trocar um classificador por outro exige mais do que "o helper é melhor": exige que NENHUMA falha
// de transporte que retentava deixe de retentar. É o que os testes abaixo MEDEM — executando a
// política real, não procurando palavras no fonte (o gate de fonte no fim é só a amarra de
// delegação, e diz isso de si mesmo).
import {
  decidirRetentativaCmcSnapshot,
  MAX_TENTATIVAS_CMC_SNAPSHOT,
  mensagemFaultstringOmie,
  mensagemHttpOmie,
} from "./cmc-snapshot-retry.ts";
import { classificarFaultstring, redigirSegredo } from "./omie-falha.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

/**
 * Réplica FIEL do classificador ad-hoc que este PR REMOVE (fonte: o `catch` do `callOmie`, idêntico
 * nos dois `index.ts`, pré-fix).
 *
 * Não é um helper espelhado — é um artefato HISTÓRICO congelado: o código que ele copia deixa de
 * existir no mesmo commit, então não há do que divergir. Existe para que "quem retentava continua
 * retentando" seja MEDIDO contra o comportamento real de ontem, e não afirmado de memória.
 */
function transitorioLegado(mensagem: string): boolean {
  const msg = mensagem.toLowerCase();
  return msg.includes("broken response") || msg.includes("soap-error") ||
    msg.includes("timeout") || msg.includes("timed out") || msg.includes("network") ||
    msg.includes("connection") || msg.includes("fetch failed") ||
    msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("500") ||
    msg.includes("já existe uma requisição") || msg.includes("sendo executada") ||
    msg.includes("tente novamente");
}

/** Retenta de verdade? (1ª tentativa, longe do teto — isola a CLASSE do esgotamento.) */
const retenta = (msg: string) => decidirRetentativaCmcSnapshot(msg, 1).retentar;
const classe = (msg: string) => decidirRetentativaCmcSnapshot(msg, 1).classe;

// Falhas de TRANSPORTE reais, na forma exata em que o `callOmie` as emite (`Omie (<conta>) HTTP <n>:`
// para não-2xx, `Omie (<conta>): <faultstring>` para o resto) ou em que o runtime as lança. Toda
// linha daqui retentava ontem e TEM de retentar hoje.
const TRANSPORTE = [
  "Omie (vendas) HTTP 500: <html>Internal Server Error</html>",
  "Omie (vendas) HTTP 502: ",
  "Omie (vendas) HTTP 503: Service Unavailable",
  "Omie (colacor_vendas) HTTP 504: gateway timeout",
  "Omie (servicos): SOAP-ERROR: Broken response from Application Server",
  "Omie (colacor_vendas): ERROR: Request timeout",
  "Omie (vendas): Já existe uma requisição desse método sendo executada",
  "Omie (vendas): Erro temporário no servidor. Tente novamente.",
  "TypeError: network error",
  "fetch failed",
  "error sending request for url (https://app.omie.com.br/api/v1/estoque/consulta/): connection closed",
];

// ⚠️ O corpus que MEDE a decisão sobre `indeterminada` (ver a conta no topo de cmc-snapshot-retry.ts).
// O bloco removido retentava `"tente novamente"`; o helper NÃO cataloga essa frase como transitório.
// Se esta edge retentasse só `transitorio` — como o omie-analytics-sync, cujo laço é outro —, estas
// linhas parariam de retentar, e aqui não retentar significa ABORTAR a invocação inteira.
const SO_INDETERMINADA_SALVA = [
  "Omie (vendas): Falha ao processar a solicitacao. Tente novamente mais tarde.",
  "Omie (vendas): Ocorreu um erro inesperado, tente novamente",
];

// Transporte que o classificador ad-hoc NÃO reconhecia e passa a retentar. Direção segura (o caro é
// declarar permanente sem prova), e nenhuma é falha de negócio: são as formas em que o próprio Omie
// pede espera ou em que gateway/CDN respondem.
const ALARGAMENTO = [
  "Omie (vendas): Consumo redundante detectado",
  "Omie (vendas): Rate limit atingido",
  "Omie (vendas) HTTP 429: too many requests",
  "Omie (vendas) HTTP 520: web server returned an unknown error",
  "Omie (vendas) HTTP 501: not implemented",
  "Omie (vendas) HTTP 505: ",
  "Omie (vendas): Bad Gateway",
  "Omie (vendas): Servico indisponivel no momento",
  "ECONNRESET",
];

// O lock de concorrência do Omie SEM acento — o defeito nº 2 isolado. É o erro que as duas edges
// mais esperam encontrar (cada uma serializa TODAS as chamadas justamente por causa dele).
const SEM_ACENTO = [
  "Omie (vendas): Ja existe uma requisicao desse metodo em andamento, aguarde",
  "Omie (colacor_vendas): JA EXISTE UMA REQUISICAO DESSE METODO [ListarPosEstoque]",
];

// Mensagens que PARAM de retentar. Cada uma é o defeito sendo consertado, não efeito colateral: o
// dígito HTTP está DENTRO da app_key / do código de aplicativo que o Omie ecoa de volta.
const BAIT = [
  "Omie (vendas): Chave de acesso não cadastrada para o aplicativo [1503123456]",
  "Omie (servicos): Acesso negado para o aplicativo [2504987361]",
  "Omie (colacor_vendas): app_key [1500233199] nao autorizada para o metodo ListarPosEstoque",
  "Omie (vendas): app_secret [9500123478] invalido",
  "Omie (vendas): Cliente nao autorizado — assinatura invalida [5020394857]",
];

// EOF do contrato Omie. Estas edges paginam por `nTotPaginas` + os guards de `omie-paginacao.ts`,
// então esta faultstring chegando ao `callOmie` já é anomalia — e anomalia deve PROPAGAR, não dormir.
const EOF_OMIE = [
  "Omie (vendas): Não existem registros para a página [5]!",
  "Omie (vendas): ERROR: Não existem registros para a página [140]!",
];

const CORPUS = [...TRANSPORTE, ...SO_INDETERMINADA_SALVA, ...ALARGAMENTO, ...SEM_ACENTO, ...BAIT, ...EOF_OMIE];

// ── Equivalência ───────────────────────────────────────────────────────────────────────────────

Deno.test("EQUIVALÊNCIA — toda falha de transporte que retentava no classificador ad-hoc segue retentando", () => {
  for (const msg of TRANSPORTE) {
    assertEquals(
      transitorioLegado(msg),
      true,
      `fixture inválida: o classificador ANTIGO não retentava isto — o corpus não mede o que promete: ${msg}`,
    );
    assertEquals(retenta(msg), true, `REGRESSÃO: retentava ontem e não retenta hoje: ${msg}`);
    assertEquals(classe(msg), "transitorio", `deveria ser transporte reconhecido: ${msg}`);
  }
});

// ⚠️ A implicação que AUTORIZA a troca, sobre o corpus inteiro. Não é "as duas listas são iguais"
// (não são, e não podem ser — a desigualdade é o conserto): é "o único jeito de sair do conjunto
// retentável é ser PERMANENTE". Qualquer outra saída é regressão, e este teste a nomeia.
Deno.test("EQUIVALÊNCIA — o único conjunto que para de retentar é `permanente`", () => {
  const violacoes = CORPUS.filter((m) => transitorioLegado(m) && !retenta(m) && classe(m) !== "permanente");
  assertEquals(
    violacoes,
    [],
    `retentava ontem, não retenta hoje, e NÃO é permanente — isto é regressão de transporte:\n  ${violacoes.join("\n  ")}`,
  );
});

// ⚠️ Este teste é a CONTA da decisão sobre `indeterminada`, não um detalhe. Se alguém alinhar esta
// edge ao omie-analytics-sync (`transitorio`-só) por simetria, estas linhas param de retentar — e
// aqui, onde a falha do callOmie ABORTA a invocação inteira, isso troca 15s de backoff por um
// backfill de 12 meses morto no meio. Refaça a conta com o formato do laço antes de mexer.
Deno.test("A CONTA — `indeterminada` retenta, e é só por isso que 'tente novamente' sobrevive à troca", () => {
  for (const msg of SO_INDETERMINADA_SALVA) {
    assertEquals(transitorioLegado(msg), true, `fixture inválida: o ANTIGO já não retentava isto: ${msg}`);
    assertEquals(
      classe(msg),
      "indeterminada",
      `fixture inválida: se o helper classifica isto como transitorio, ela não mede a decisão: ${msg}`,
    );
    assertEquals(retenta(msg), true, `REGRESSÃO: 'indeterminada' parou de retentar nesta edge: ${msg}`);
  }
});

Deno.test("ALARGAMENTO — transporte que o classificador ad-hoc não reconhecia passa a retentar", () => {
  for (const msg of ALARGAMENTO) {
    assertEquals(
      transitorioLegado(msg),
      false,
      `fixture inválida: o classificador ANTIGO já retentava isto — não é alargamento: ${msg}`,
    );
    assertEquals(retenta(msg), true, `deixou de ser reconhecido: ${msg}`);
    assertEquals(classe(msg), "transitorio", `deveria ser transporte reconhecido: ${msg}`);
  }
});

// ── Os dois defeitos ───────────────────────────────────────────────────────────────────────────

Deno.test("O CONSERTO nº1 — dígito ecoado dentro de identificador para de comprar 4 tentativas", () => {
  for (const msg of BAIT) {
    assertEquals(
      transitorioLegado(msg),
      true,
      `fixture inválida: se o classificador ANTIGO já não retentava isto, não há defeito a consertar: ${msg}`,
    );
    assertEquals(retenta(msg), false, `deveria falhar rápido: ${msg}`);
    assertEquals(classe(msg), "permanente", `classe errada para: ${msg}`);
  }
});

Deno.test("O CONSERTO nº2 — o lock de concorrência SEM acento volta a ser reconhecido (NFD)", () => {
  for (const msg of SEM_ACENTO) {
    assertEquals(
      transitorioLegado(msg),
      false,
      `fixture inválida: o marcador acentuado do classificador ANTIGO já casava isto: ${msg}`,
    );
    assertEquals(classe(msg), "transitorio", `o lock sem acento tem de ser transitório: ${msg}`);
  }
});

Deno.test("O CONSERTO nº1 (avesso) — 5xx de gateway/CDN (501/505/520) passa a ganhar backoff", () => {
  for (const codigo of [501, 505, 520, 521, 522]) {
    const msg = `Omie (vendas) HTTP ${codigo}: `;
    assertEquals(
      transitorioLegado(msg),
      false,
      `fixture inválida: o classificador ANTIGO já retentava ${codigo} — não há defeito a consertar`,
    );
    assertEquals(retenta(msg), true, `HTTP ${codigo} tinha de retentar`);
  }
});

// ⚠️ `fim_de_pagina` é a razão de a política usar `classificarFaultstring` e NÃO `classificarExcecao`
// (que converteria fim → indeterminada, classe que AQUI retenta). Sem esta trava, a mensagem de EOF
// do Omie passaria a comprar 4 chamadas e 15s de sono por uma resposta que não muda por retentativa.
Deno.test("EOF do contrato Omie não retenta — e também não retentava antes", () => {
  for (const msg of EOF_OMIE) {
    assertEquals(transitorioLegado(msg), false, `fixture inválida: o ANTIGO retentava o EOF: ${msg}`);
    assertEquals(classe(msg), "fim_de_pagina", `o EOF deixou de ser reconhecido: ${msg}`);
    assertEquals(retenta(msg), false, `o EOF passou a dormir e retentar: ${msg}`);
  }
});

// ⚠️ O custo ADMITIDO da decisão, escrito para não virar surpresa: um parâmetro inválido é permanente
// de fato, cai em `indeterminada` e paga o backoff completo. É barato (15s, uma vez, e a invocação já
// ia devolver 500) e não ocorre no cron — o backfill valida a data em `normalizaDataPosicao` antes de
// chamar o Omie, e o cron mensal gera as datas com `to_char`.
Deno.test("CUSTO ADMITIDO — erro de parâmetro cai em indeterminada e paga o backoff, de propósito", () => {
  const msg = "Omie (vendas): Data de posicao invalida";
  assertEquals(classe(msg), "indeterminada");
  assertEquals(retenta(msg), true, "se isto mudar, a política mudou — refaça a conta, não a fixture");
});

// ── Backoff: a curva que NÃO pode mudar nesta entrega ──────────────────────────────────────────

// ⚠️ As duas edges dormiam `1000 * 2^(n-1)` ms — base 1s, sem teto. O helper tem `atrasoRetentativaMs`
// com base 800ms e TETO de 5s (calibrado para o orçamento de ~150s do omie-cliente): usá-lo aqui
// encurtaria as quatro esperas para 0,8/1,6/3,2/5,0. Esperar MENOS é o que reencosta no lock de
// concorrência do Omie, que é o motivo de estas edges serializarem tudo. Esta entrega troca a
// CLASSIFICAÇÃO, não a política de espera.
Deno.test("EQUIVALÊNCIA — o atraso reproduz os 1s / 2s / 4s / 8s das duas edges", () => {
  const msg = "Omie (vendas) HTTP 503: ";
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_CMC_SNAPSHOT - 1; tentativa++) {
    assertEquals(
      decidirRetentativaCmcSnapshot(msg, tentativa).atrasoMs,
      1000 * Math.pow(2, tentativa - 1),
      `backoff divergiu na tentativa ${tentativa}`,
    );
  }
});

// ⚠️ O helper SABE honrar o "Aguarde N segundos" do Omie, e estas edges deliberadamente NÃO usam —
// o `atrasoRetentativaMs` nem é chamado. Sem este teste, alguém "melhora" a chamada passando a
// faultstring e a curva muda sem ninguém ver.
Deno.test("O 'Aguarde N segundos' do Omie NÃO alonga o sleep destas edges (decisão, não esquecimento)", () => {
  const comPedido = "Omie (vendas): Rate limit. Aguarde 90 segundos.";
  assertEquals(decidirRetentativaCmcSnapshot(comPedido, 1).retentar, true);
  assertEquals(
    decidirRetentativaCmcSnapshot(comPedido, 1).atrasoMs,
    1000,
    "o atraso passou a honrar o 'Aguarde N' — mede o custo no laço de páginas antes de ligar isso",
  );
});

Deno.test("TETO — a última tentativa não retenta, mesmo sendo transitória", () => {
  const msg = "Omie (vendas) HTTP 503: ";
  assertEquals(decidirRetentativaCmcSnapshot(msg, MAX_TENTATIVAS_CMC_SNAPSHOT - 1).retentar, true);
  assertEquals(decidirRetentativaCmcSnapshot(msg, MAX_TENTATIVAS_CMC_SNAPSHOT).retentar, false, "estourou o teto");
  assertEquals(decidirRetentativaCmcSnapshot(msg, MAX_TENTATIVAS_CMC_SNAPSHOT).atrasoMs, 0, "não dorme sem retentar");
  assertEquals(MAX_TENTATIVAS_CMC_SNAPSHOT, 5, "o teto era `maxAttempts = 5` nas duas edges");
});

// ── Redação ────────────────────────────────────────────────────────────────────────────────────

Deno.test("REDAÇÃO — a app_key ecoada pelo Omie não sai da edge", () => {
  const cru = "Chave de acesso não cadastrada para o aplicativo [1503123456]";
  const saida = mensagemFaultstringOmie("vendas", cru);
  if (saida.includes("1503123456")) throw new Error(`app_key vazando: ${saida}`);
  if (!saida.includes("Omie (vendas)")) throw new Error(`perdeu a conta, que é o que distingue a falha: ${saida}`);
  // O motivo tem de continuar acionável: a forma da mensagem sobrevive à máscara.
  if (!saida.includes("Chave de acesso")) throw new Error(`motivo virou inútil: ${saida}`);
});

Deno.test("REDAÇÃO — o status HTTP é produzido pelo RUNTIME e passa intacto (é o motivo acionável)", () => {
  assertEquals(mensagemHttpOmie("vendas", 503, "Service Unavailable"), "Omie (vendas) HTTP 503: Service Unavailable");
});

// ⚠️ A ordem redigir→truncar não é estética. O corpo do não-2xx é cortado em 300 caracteres; truncar
// ANTES parte a app_key na borda e deixa um resto curto que escapa da máscara `\d{8,}` — o segredo
// sairia pela metade, que para efeito de vazamento é sair.
//
// ⚠️ O preenchimento é `x`, e isso é a fixture INTEIRA. A 1ª versão usava `a`, e a mutação
// "trunca antes de redigir" SOBREVIVEU ao teste: `a` é dígito hexadecimal, então a máscara de
// app_secret (`[0-9a-f]{24,}`) engolia os 295 caracteres de enchimento JUNTO com o resto da chave e
// escondia o vazamento. O teste ficava verde por acidente do alfabeto, não por desenho — a mesma
// forma de falso-verde do #1483. Trocar para um caractere não-hex é o que lhe dá poder.
Deno.test("REDAÇÃO — a app_key na borda dos 300 caracteres não escapa pelo truncamento", () => {
  const SEGREDO = "1503123456";
  const saida = mensagemHttpOmie("vendas", 500, `${"x".repeat(295)}${SEGREDO}`);
  // Qualquer PREFIXO do segredo que sobreviva ao corte já é vazamento — não só a chave inteira.
  for (let n = SEGREDO.length; n >= 4; n--) {
    const prefixo = SEGREDO.slice(0, n);
    if (saida.includes(prefixo)) {
      throw new Error(`app_key vazou (prefixo de ${n} dígitos "${prefixo}"): …${saida.slice(-30)}`);
    }
  }
});

// ⚠️ A redação acontece ANTES da classificação (o throw redige, o catch classifica o texto já
// redigido). Se mascarar dígito longo pudesse mudar a CLASSE, a política dependeria da ordem.
Deno.test("INVARIANTE — redigir o segredo não muda a classe de nenhuma mensagem do corpus", () => {
  for (const msg of [...CORPUS, "status 503123456 dentro do identificador"]) {
    assertEquals(
      classificarFaultstring(redigirSegredo(msg)),
      classificarFaultstring(msg),
      `a classe MUDOU ao redigir — a política passa a depender da ordem: ${msg}`,
    );
  }
});

// ── Gate de DELEGAÇÃO (as DUAS edges) ──────────────────────────────────────────────────────────
// ⚠️ Este gate NÃO prova comportamento — quem prova são os testes acima, que executam a política.
// Ele só amarra os `index.ts` (não importáveis sob `--no-remote`) ao módulo testado, para que a
// política não volte a ser reimplementada inline, onde nenhum teste a alcança. Medido com os
// comentários REMOVIDOS: este arquivo e os dois `callOmie` citam a forma do bug de propósito, e um
// predicado que lê a prosa acusa a documentação (money-path §"o ALVO mente").
// A limpeza vem do módulo COMPARTILHADO (espelho byte-idêntico de `src/lib/gates/limpeza-fonte.ts`,
// amarrado por `limpeza-fonte.parity.test.ts`). A cópia local que vivia aqui era regex pura, e
// além de não saber o que era string (um abre-bloco dentro de aspas pareava com o próximo
// fecha-bloco REAL e apagava tudo entre os dois — verde por CEGUEIRA,
// docs/historico/gates-textuais-cegos.md), ela só descartava a linha que COMEÇAVA com barra-barra:
// comentário no FIM de uma linha de código continuava sendo medido como se fosse código. O módulo
// remove os dois.
import { removerComentarios as semComentarios } from "./limpeza-fonte.ts";

const EDGES = ["cmc-snapshot-smoke", "cmc-snapshot-backfill"];
const FONTES = new Map<string, string>(
  await Promise.all(
    EDGES.map(async (nome) =>
      [nome, semComentarios(await Deno.readTextFile(new URL(`../${nome}/index.ts`, import.meta.url)))] as [string, string]
    ),
  ),
);

Deno.test("GATE — as duas edges delegam a política, em vez de reimplementá-la fora do alcance do teste", () => {
  for (const [nome, fonte] of FONTES) {
    if (!/from\s+["']\.\.\/_shared\/cmc-snapshot-retry\.ts["']/.test(fonte)) {
      throw new Error(`${nome} parou de importar ../_shared/cmc-snapshot-retry.ts — a política saiu do alcance do teste`);
    }
    for (const simbolo of ["decidirRetentativaCmcSnapshot", "mensagemFaultstringOmie", "mensagemHttpOmie"]) {
      if (!new RegExp(`${simbolo}\\s*\\(`).test(fonte)) {
        throw new Error(`${nome} não chama mais \`${simbolo}\` — a decisão saiu do alcance do teste`);
      }
    }
  }
});

Deno.test("GATE — o dígito HTTP cru não volta para dentro das edges", () => {
  for (const [nome, fonte] of FONTES) {
    // `includes("503")` é a forma exata do defeito; `classificarFaultstring`/`atrasoRetentativaMs`
    // chamados aqui significam política remontada na edge; `2 **`/`Math.pow(2` é o backoff voltando
    // inline, onde a curva pode divergir entre as duas gêmeas sem nenhum teste notar.
    const inline = fonte.match(
      /includes\(\s*["']\d{3}["']\s*\)|classificarFaultstring\s*\(|atrasoRetentativaMs\s*\(|Math\.pow\(\s*2|\b2\s*\*\*/g,
    );
    if (inline) {
      throw new Error(`classificação/atraso reimplementados dentro de ${nome} (${inline.join(", ")}) — mova para _shared/cmc-snapshot-retry.ts`);
    }
  }
});
