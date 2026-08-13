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
// melhor": exige que NENHUMA falha de transporte que retentava antes deixe de retentar.
//
// ⚠️ Estes testes EXECUTAM a política real (`./politica-retry.ts`), não procuram palavras no
// fonte. A 1ª versão fazia o contrário — três gates que liam o `index.ts` atrás de tokens — e o
// challenge do Codex passou pelos três com mutações triviais (regex de dígito cru no lugar do
// `includes`, `classe` fixada em "permanente" com o helper importado sem uso, `redigirSegredo`
// num ramo morto). O gate de fonte que sobrou no fim do arquivo é só a amarra de DELEGAÇÃO: ele
// não afirma comportamento nenhum, e diz isso.
import {
  decidirRetentativaOmie,
  MAX_TENTATIVAS_OMIE,
  mensagemCorpoNaoJson,
  mensagemFalhaOmie,
} from "./politica-retry.ts";
import { classificarFaultstring, redigirSegredo } from "../_shared/omie-falha.ts";

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

/** Retenta de verdade? (1ª tentativa, longe do teto — isola a CLASSE do esgotamento.) */
const retenta = (msg: string) => decidirRetentativaOmie(msg, 1, MAX_TENTATIVAS_OMIE).retentar;

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
  // ⚠️ O 5xx de gateway com corpo NÃO-JSON. O `res.json()` roda antes do guard de status, então
  // esta é a forma em que um 503 de CDN realmente chega ao catch — e o classificador antigo a
  // retentava por ver o `503` solto na mensagem do parser. Foi a regressão que o challenge do
  // Codex achou: sem `mensagemCorpoNaoJson` ancorando o status, as 4 tentativas viravam 1.
  mensagemCorpoNaoJson("vendas", 503, new SyntaxError(`Unexpected token 'E', "ERROR 503" is not valid JSON`)),
  mensagemCorpoNaoJson("vendas", 502, new SyntaxError(`Unexpected token '<', "<html>" is not valid JSON`)),
  // `status code <n>` é a forma que cliente HTTP de terceiro emite. O legado a retentava (por ver
  // o dígito solto); a 1ª versão do padrão ancorado NÃO a reconhecia — era uma regressão de
  // equivalência escondida, achada pelo challenge do Codex. O `(?:\s+code)?` do padrão é o que a
  // devolve ao lado certo.
  "Request failed with status code 503",
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

// Mensagens que PARAM de retentar. Cada uma é o defeito sendo consertado, não efeito colateral.
const BAIT: Array<[string, string]> = [
  // A família de mensagem de credencial MAIS comum do Omie: a app_key contém 503.
  ["Omie (vendas): Chave de acesso não cadastrada para o aplicativo [1503123456]", "permanente"],
  ["Omie (servicos): app_key [4290384756] inválida", "permanente"],
  // Mesma armadilha, outra família: o idProduto ecoado. É o caminho do `ConsultarEstrutura`,
  // onde 825 dos ~1.334 alvos JÁ falham por ciclo em produção (medido 2026-07-31) — os que por
  // acaso carregam 500/502/503/504/429 no código queimavam 4 chamadas cada, por acidente de dígito.
  ["Omie (colacor_vendas): idProduto=1503498712 nao possui estrutura", "indeterminada"],
  ["Omie (colacor_vendas): Produto 1502938475 sem malha cadastrada", "indeterminada"],
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
    assertEquals(retenta(msg), true, `REGRESSÃO: retentava ontem e não retenta hoje: ${msg}`);
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
  }
});

Deno.test("O CONSERTO — dígito ecoado dentro de identificador para de comprar 4 tentativas", () => {
  for (const [msg, esperado] of BAIT) {
    assertEquals(
      transitorioLegado(msg),
      true,
      `fixture inválida: se o classificador ANTIGO já não retentava isto, não há defeito a consertar: ${msg}`,
    );
    assertEquals(retenta(msg), false, `deveria falhar rápido: ${msg}`);
    assertEquals(decidirRetentativaOmie(msg, 1).classe, esperado, `classe errada para: ${msg}`);
  }
});

Deno.test("O CONSERTO — 5xx de gateway/CDN (501/505/520) passa a ganhar backoff", () => {
  for (const codigo of [501, 505, 520, 521, 522]) {
    const msg = `Omie (vendas): HTTP ${codigo}`;
    assertEquals(
      transitorioLegado(msg),
      false,
      `fixture inválida: o classificador ANTIGO já retentava ${codigo} — não há defeito a consertar`,
    );
    assertEquals(retenta(msg), true, `HTTP ${codigo} tinha de retentar`);
  }
});

// O backoff é parte do contrato que não pode mudar: o `callOmie` dormia `800 * 2^(n-1)` ms.
Deno.test("EQUIVALÊNCIA — o atraso reproduz os 0,8s / 1,6s / 3,2s do callOmie", () => {
  const msg = "Omie (vendas): HTTP 503";
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    assertEquals(
      decidirRetentativaOmie(msg, tentativa).atrasoMs,
      800 * Math.pow(2, tentativa - 1),
      `backoff divergiu na tentativa ${tentativa}`,
    );
  }
});

// ⚠️ O helper SABE honrar o "Aguarde N segundos" do Omie, e esta edge deliberadamente NÃO usa.
// Medido no challenge do Codex: "Aguarde 3 segundos" levaria o total de 5,6s para 10,5s e
// "Aguarde 90" para 15s (o teto de 5s é POR TENTATIVA). Num laço de 167 lotes isso é orçamento
// do worker. Sem este teste, alguém "melhora" a chamada passando a faultstring e ninguém vê.
Deno.test("O 'Aguarde N segundos' do Omie NÃO alonga o sleep desta edge (decisão, não esquecimento)", () => {
  const comPedido = "Omie (vendas): Rate limit. Aguarde 90 segundos.";
  assertEquals(decidirRetentativaOmie(comPedido, 1).retentar, true);
  assertEquals(
    decidirRetentativaOmie(comPedido, 1).atrasoMs,
    800,
    "o atraso passou a honrar o 'Aguarde N' — mede o custo no laço de lotes antes de ligar isso",
  );
});

Deno.test("TETO — a última tentativa não retenta, mesmo sendo transitória", () => {
  const msg = "Omie (vendas): HTTP 503";
  assertEquals(decidirRetentativaOmie(msg, MAX_TENTATIVAS_OMIE - 1).retentar, true);
  assertEquals(decidirRetentativaOmie(msg, MAX_TENTATIVAS_OMIE).retentar, false, "estourou o teto");
  assertEquals(decidirRetentativaOmie(msg, MAX_TENTATIVAS_OMIE).atrasoMs, 0, "não dorme sem retentar");
});

// ── Redação ────────────────────────────────────────────────────────────────────────────────────
Deno.test("REDAÇÃO — a app_key ecoada pelo Omie não sai da edge", () => {
  const cru = "Chave de acesso não cadastrada para o aplicativo [1503123456]";
  const saida = mensagemFalhaOmie("vendas", cru);
  if (saida.includes("1503123456")) throw new Error(`app_key vazando: ${saida}`);
  if (!saida.includes("Omie (vendas)")) throw new Error(`perdeu a conta, que é o que distingue a falha: ${saida}`);
  // O motivo tem de continuar acionável: a forma da mensagem sobrevive à máscara.
  if (!saida.includes("Chave de acesso")) throw new Error(`motivo virou inútil: ${saida}`);
});

Deno.test("REDAÇÃO — valor produzido pelo RUNTIME passa intacto (código HTTP é o motivo acionável)", () => {
  assertEquals(mensagemFalhaOmie("vendas", "HTTP 503", "runtime"), "Omie (vendas): HTTP 503");
});

// ⚠️ A redação acontece ANTES da classificação (o throw redige, o catch classifica o texto já
// redigido). Se mascarar dígito longo pudesse mudar a CLASSE, a política dependeria da ordem —
// e o challenge do Codex mostrou exatamente isso na 1ª versão do padrão, sem a fronteira `(?!\d)`
// (`"status 503123456"` era transitorio antes de redigir e indeterminada depois).
Deno.test("INVARIANTE — redigir o segredo não muda a classe de nenhuma mensagem do corpus", () => {
  const corpus = [...TRANSPORTE, ...ALARGAMENTO, ...BAIT.map(([m]) => m), "status 503123456 dentro do identificador"];
  for (const msg of corpus) {
    assertEquals(
      classificarFaultstring(redigirSegredo(msg)),
      classificarFaultstring(msg),
      `a classe MUDOU ao redigir — a política passa a depender da ordem: ${msg}`,
    );
  }
});

// ── Gate de DELEGAÇÃO ──────────────────────────────────────────────────────────────────────────
// ⚠️ Este gate NÃO prova comportamento — quem prova são os testes acima, que executam a política.
// Ele só amarra o `index.ts` (não importável sob `--no-remote`) ao módulo testado, para que a
// política não volte a ser reimplementada inline, onde nenhum teste a alcança. Medido com os
// comentários REMOVIDOS: este arquivo e o `callOmie` citam a forma do bug de propósito, e um
// predicado que lê a prosa acusa a documentação (money-path §"o ALVO mente").
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((linha) => !/^\s*\/\//.test(linha))
    .join("\n");
}

const FONTE_EDGE = semComentarios(await Deno.readTextFile(new URL("./index.ts", import.meta.url)));

Deno.test("GATE — o callOmie delega a política, em vez de reimplementá-la fora do alcance do teste", () => {
  if (!/from\s+["']\.\/politica-retry\.ts["']/.test(FONTE_EDGE)) {
    throw new Error("omie-analytics-sync parou de importar ./politica-retry.ts — a política saiu do alcance do teste");
  }
  // Os três pontos de delegação. `mensagemCorpoNaoJson` é o que mais importa amarrar aqui: ele é
  // o único cujo COMPORTAMENTO os testes acima cobrem mas cuja CHAMADA depende de o `res.json()`
  // continuar dentro de um try — e essa parte só existe no index.ts.
  for (const simbolo of ["decidirRetentativaOmie", "mensagemFalhaOmie", "mensagemCorpoNaoJson"]) {
    if (!new RegExp(`${simbolo}\\s*\\(`).test(FONTE_EDGE)) {
      throw new Error(`o callOmie não chama mais \`${simbolo}\` — a decisão saiu do alcance do teste`);
    }
  }
  // Classificar/atrasar por conta própria é o que este PR remove; reintroduzir devolve a decisão
  // para um arquivo que nenhum teste consegue importar.
  const inline = FONTE_EDGE.match(
    /classificarFaultstring\s*\(|atrasoRetentativaMs\s*\(|includes\(\s*["']\d{3}["']\s*\)|\/[^\n/]*\b\d{3}\b[^\n/]*\/\s*\.test\(/g,
  );
  if (inline) {
    throw new Error(`classificação/atraso reimplementados dentro da edge (${inline.join(", ")}) — mova para politica-retry.ts`);
  }
});
