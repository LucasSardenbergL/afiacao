// Política de retentativa do `callOmie` (omie-analytics-sync) — prova de EQUIVALÊNCIA.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-analytics-sync/
//
// ── O que este arquivo protege ────────────────────────────────────────────────────────────────
// O `callOmie` classificava falha do Omie com marcadores de texto PRÓPRIOS, contendo os códigos
// HTTP CRUS ("502"/"503"/"504"/"500"/"429"). Dois defeitos, os dois já resolvidos no helper
// canônico `_shared/omie-falha.ts`:
//   1. dígito solto casa DENTRO do identificador que a própria mensagem ecoa (money-path
//      §"O MARCADOR mente", #1614) — a app_key e o idProduto contêm 503;
//   2. a enumeração à mão de 5xx não cobre 501/505/520 (challenge Codex do #1623).
// Trocar um classificador por outro num caminho com 7 crons ativos exige mais do que "o helper é
// melhor": exige que NENHUMA falha de transporte que retentava antes deixe de retentar. É essa
// implicação que os testes abaixo medem, mais o gate de fonte que impede a volta do dígito cru.
//
// Este teste não importa o `index.ts` (ele traz `https://deno.land/...` e `npm:`, e `test:edges`
// roda com `--no-remote`): a lógica sob teste é a do helper puro, e o WIRING é medido lendo o
// FONTE — o mesmo padrão do `paginacao-artesanal-gate` (money-path §9).
import { atrasoRetentativaMs, classificarFaultstring } from "../_shared/omie-falha.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

/**
 * Réplica FIEL do classificador ad-hoc que este PR REMOVE (fonte: `callOmie`, index.ts, pré-fix).
 *
 * Não é um helper espelhado — é um artefato HISTÓRICO congelado: o código que ele copia deixa de
 * existir no mesmo commit, então não há do que divergir. Ele existe para que a afirmação "quem
 * retentava continua retentando" seja MEDIDA contra o comportamento real de ontem, e não afirmada
 * de memória.
 */
function transitorioLegado(mensagem: string): boolean {
  const msg = mensagem.toLowerCase();
  return msg.includes("broken response") || msg.includes("soap-error") ||
    msg.includes("timeout") || msg.includes("timed out") || msg.includes("network") ||
    msg.includes("connection") || msg.includes("fetch failed") ||
    msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("500") ||
    msg.includes("429") || msg.includes("too many") || msg.includes("rate limit");
}

// Falhas de TRANSPORTE reais, na forma exata em que o `callOmie` as emite (`Omie (<conta>): …`)
// ou em que o runtime as lança. Toda linha daqui retentava ontem e TEM de retentar hoje.
const TRANSPORTE = [
  "Omie (vendas): SOAP-ERROR: Broken response from Application Server",
  "Omie (servicos): Timeout na consulta",
  "Omie (colacor_vendas): HTTP 500",
  "Omie (vendas): HTTP 502",
  "Omie (vendas): HTTP 503",
  "Omie (vendas): HTTP 504",
  "Omie (vendas): HTTP 429",
  "Omie (vendas): Rate limit atingido",
  "Omie (vendas): too many requests",
  "error sending request for url (https://app.omie.com.br/api/v1/geral/produtos/): connection closed",
  "TypeError: network error",
  "fetch failed",
];

// Transporte que o classificador ad-hoc NÃO reconhecia e passa a retentar. Direção segura (o
// caro é declarar permanente sem prova), e nenhuma delas é falha de negócio: são as formas em
// que o próprio Omie pede espera ("Aguarde", "consumo redundante") ou em que o gateway responde.
const ALARGAMENTO = [
  "Omie (vendas): Ja existe uma requisicao desse metodo em andamento, aguarde",
  "Omie (vendas): ERROR: Consumo redundante detectado",
  "Omie (vendas): Service Unavailable",
  "Omie (vendas): Bad Gateway",
  "TypeError: error sending request",
  "ECONNRESET",
];

// ⚠️ A implicação que autoriza a troca. Não é "as duas listas são iguais" (não são, e não podem
// ser — a desigualdade é o conserto): é "o conjunto que RETENTAVA não encolheu por transporte".
Deno.test("EQUIVALÊNCIA — toda falha de transporte que retentava no classificador ad-hoc segue retentando", () => {
  for (const msg of TRANSPORTE) {
    assertEquals(
      transitorioLegado(msg),
      true,
      `fixture inválida: o classificador ANTIGO não retentava isto — o corpus não mede o que promete: ${msg}`,
    );
    assertEquals(
      classificarFaultstring(msg),
      "transitorio",
      `REGRESSÃO: retentava ontem e não retenta hoje — transitório virando falha diária: ${msg}`,
    );
  }
});

Deno.test("ALARGAMENTO — transporte que o classificador ad-hoc não reconhecia passa a retentar", () => {
  for (const msg of ALARGAMENTO) {
    assertEquals(
      transitorioLegado(msg),
      false,
      `fixture inválida: o classificador ANTIGO já retentava isto — não é alargamento: ${msg}`,
    );
    assertEquals(classificarFaultstring(msg), "transitorio", `deixou de ser reconhecido: ${msg}`);
  }
});

// As ÚNICAS mensagens que deixam de retentar — e cada uma é o defeito sendo consertado, não um
// efeito colateral. `transitorioLegado === true` aqui é a prova de que o bug existia de fato.
Deno.test("O CONSERTO — dígito ecoado dentro de identificador para de comprar 4 tentativas", () => {
  const bait: Array<[string, string]> = [
    // A família de mensagem de credencial MAIS comum do Omie: a app_key contém 503.
    ["Omie (vendas): Chave de acesso não cadastrada para o aplicativo [1503123456]", "permanente"],
    ["Omie (servicos): app_key [4290384756] inválida", "permanente"],
    // Mesma armadilha, outra família: o idProduto ecoado. É o caminho do `ConsultarEstrutura`,
    // onde 825 produtos JÁ falham por ciclo em produção (medido 2026-07-31) — os que por acaso
    // carregam 500/502/503/504/429 no código queimavam 4 chamadas cada, por acidente de dígito.
    ["Omie (colacor_vendas): idProduto=1503498712 nao possui estrutura", "indeterminada"],
    ["Omie (colacor_vendas): Produto 1502938475 sem malha cadastrada", "indeterminada"],
  ];
  for (const [msg, esperado] of bait) {
    assertEquals(
      transitorioLegado(msg),
      true,
      `fixture inválida: se o classificador ANTIGO já não retentava isto, não há defeito a consertar: ${msg}`,
    );
    assertEquals(classificarFaultstring(msg), esperado, `classe errada para: ${msg}`);
  }
});

// Defeito 2: 5xx fora da enumeração à mão abortava na 1ª tentativa, SEM backoff.
Deno.test("O CONSERTO — 5xx de gateway/CDN (501/505/520) passa a ganhar backoff", () => {
  for (const codigo of [501, 505, 520, 521, 522]) {
    const msg = `Omie (vendas): HTTP ${codigo}`;
    assertEquals(
      transitorioLegado(msg),
      false,
      `fixture inválida: o classificador ANTIGO já retentava ${codigo} — não há defeito a consertar`,
    );
    assertEquals(classificarFaultstring(msg), "transitorio", `HTTP ${codigo} tinha de retentar`);
  }
});

// O backoff é parte do contrato que não pode mudar: o `callOmie` dormia `800 * 2^(n-1)` ms.
Deno.test("EQUIVALÊNCIA — o backoff do helper reproduz os 0,8s / 1,6s / 3,2s do callOmie", () => {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    assertEquals(
      atrasoRetentativaMs(tentativa),
      800 * Math.pow(2, tentativa - 1),
      `backoff divergiu na tentativa ${tentativa}`,
    );
  }
});

// ── Gate de FONTE: o wiring ────────────────────────────────────────────────────────────────────
// Os testes acima provam o que o HELPER decide; nada neles prova que a edge o CONSULTA. Sem este
// gate, alguém reintroduz o dígito cru no `callOmie` e a suíte inteira segue verde.
// Medido com os comentários REMOVIDOS — este arquivo e o próprio `callOmie` citam a forma do bug
// de propósito, e um predicado que lê a prosa acusa a documentação (money-path §"o ALVO mente").
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((linha) => !/^\s*\/\//.test(linha))
    .join("\n");
}

const FONTE_EDGE = semComentarios(
  await Deno.readTextFile(new URL("./index.ts", import.meta.url)),
);

Deno.test("GATE — o callOmie não classifica falha por código HTTP cru", () => {
  const digitosCrus = FONTE_EDGE.match(/includes\(\s*["'](?:429|4\d\d|5\d\d)["']\s*\)/g);
  if (digitosCrus) {
    throw new Error(
      `código HTTP CRU de volta na classificação (${digitosCrus.join(", ")}) — ele casa dentro da ` +
        `app_key/idProduto que a mensagem ecoa. Use _shared/omie-falha.ts.`,
    );
  }
});

Deno.test("GATE — o callOmie delega a classificação ao helper canônico e retenta só o transitório", () => {
  if (!/from\s+["']\.\.\/_shared\/omie-falha\.ts["']/.test(FONTE_EDGE)) {
    throw new Error("omie-analytics-sync parou de importar _shared/omie-falha.ts");
  }
  if (!FONTE_EDGE.includes('=== "transitorio"')) {
    throw new Error(
      'o callOmie não retenta mais por `=== "transitorio"` — a política de retentativa mudou sem ' +
        "passar por este gate (indeterminada retentando estoura o orçamento do ConsultarEstrutura)",
    );
  }
});

Deno.test("GATE — todo texto PRODUZIDO PELO OMIE é redigido antes de sair da edge", () => {
  // A faultstring de credencial ECOA a app_key, e daqui ela vai para `sync_state.error_message`
  // (persistido), para o console e para o corpo da resposta 500. Redigir no THROW cobre os três.
  //
  // O alvo é o texto que o OMIE produz (`result.faultstring`, `result.faultcode`) — terceiro, e
  // sobre texto de terceiro não se afirma "não tem segredo" sem verificar quem o escreve
  // (money-path §"Garantia de PRIVACIDADE afirmada sem verificar o SINK"). `res.status` fica de
  // fora de propósito: é um número do runtime, e redigi-lo seria código morto sugerindo um risco
  // que não existe — gate não pode ditar código pior do que o que ele protege.
  const throwsOmie = FONTE_EDGE.match(/throw new Error\(`Omie[^`]*`\)/g) ?? [];
  const throwsComTextoDoOmie = throwsOmie.filter((t) => t.includes("result."));
  if (throwsComTextoDoOmie.length < 2) {
    throw new Error(
      `o gate perdeu o alvo: esperava >= 2 throws com texto do Omie (faultstring, faultcode), achei ${throwsComTextoDoOmie.length}`,
    );
  }
  const semRedacao = throwsComTextoDoOmie.filter((t) => !t.includes("redigirSegredo"));
  if (semRedacao.length > 0) {
    throw new Error(
      `mensagem do Omie saindo CRUA da edge (${semRedacao.length}): ${semRedacao.join(" | ")}`,
    );
  }
});
