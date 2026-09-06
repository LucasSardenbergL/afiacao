// Política de retentativa e redação do `callOmie` das edges `cmc-snapshot-smoke` e
// `cmc-snapshot-backfill` — lógica PURA (sem I/O, sem import remoto). Testes em
// `cmc-snapshot-retry_test.ts` (Deno, `--no-remote`).
//
// ── Por que existe, e por que em `_shared` ────────────────────────────────────────────────────
// As duas edges são gêmeas (o backfill nasceu espelhando o smoke) e carregavam o MESMO bloco de
// classificação ad-hoc dentro do `catch` do `callOmie`, com os dois defeitos que o helper canônico
// `omie-falha.ts` já resolve:
//
//   1. códigos HTTP CRUS (`msg.includes("503")`) — o dígito casa DENTRO do identificador que a
//      própria mensagem ecoa. `"Chave de acesso não cadastrada para o aplicativo [1503123456]"`, o
//      erro de credencial mais comum do Omie, contém `503` na app_key: o erro PERMANENTE mais
//      frequente era tratado como transitório e queimava as 4 retentativas (money-path §"O MARCADOR
//      mente", #1614). O helper só aceita código HTTP ANCORADO na forma (`HTTP 503`/`status 503`),
//      e o padrão cobre TODO 5xx + 429 — não a enumeração à mão, que erra pelo avesso (501/505/520).
//   2. marcadores ACENTUADOS (`"já existe uma requisição"`, `"sendo executada"`) comparados contra
//      texto que só passou por `.toLowerCase()`. O Omie mistura acentuação entre mensagens; a mesma
//      frase sem acento não casava e o lock de concorrência — o motivo de TODA chamada destas edges
//      ser serializada — virava falha dura. O helper normaliza NFD e casa marcadores ASCII.
//
// O `index.ts` das duas não é importável sob `--no-remote` (o backfill traz `npm:@supabase/...`),
// então a decisão vive aqui — doutrina do CLAUDE.md: "Precisa de dep? Extraia a lógica PURA e teste
// ela" — e o `callOmie` vira o transporte que a consulta. Fica em `_shared` porque a política é
// literalmente a mesma nas duas: duplicá-la seria recriar, em dois arquivos, a divergência que esta
// entrega existe para fechar.
//
// ── A conta que decide `indeterminada` (REFEITA, não copiada do omie-analytics-sync) ──────────
// Lá a decisão foi retentar SÓ `transitorio`, porque o laço é por PRODUTO com ~825 falhas ABSORVIDAS
// por ciclo (cada uma degrada honesto e o laço segue): o sleep é pago por lote com falha e retentar
// indeterminada custava ~582–935s contra um orçamento de ~150s.
//
// Aqui a unidade de trabalho é OUTRA. `callOmie` LANÇA, `cmcPorData` não captura e o handler devolve
// 500: a primeira falha que esgota o teto ABORTA a invocação inteira. Daí as duas medidas:
//   • o custo é limitado POR CONSTRUÇÃO — no máximo UMA chamada por invocação paga o backoff
//     completo (1+2+4+8 = 15s), já que a que esgota é a que aborta. Contra os 600s de
//     `timeout_milliseconds` do cron mensal do backfill, 2,5%;
//   • o custo de desistir cedo é DESPROPORCIONAL — uma transitória fora do catálogo mata um backfill
//     de 12 meses × 200 páginas no meio, e o cron mensal só volta no mês seguinte.
// E há a evidência direta: o bloco removido retentava `"tente novamente"`, que o helper NÃO cataloga
// como transitório. Com `transitorio`-só, essa mensagem — e toda transitória fora do catálogo —
// deixaria de retentar num laço onde não retentar significa abortar tudo.
//
// Logo, aqui `indeterminada` RETENTA, com teto. O efeito é a equivalência mais forte que esta troca
// pode ter: o único conjunto que para de retentar é exatamente `permanente` — o defeito sendo
// consertado. Quem for mudar isto refaz a conta com o formato do laço, não com este número.
import { type ClasseFalhaOmie, classificarFaultstring, redigirSegredo } from "./omie-falha.ts";

export interface DecisaoRetentativaCmcSnapshot {
  retentar: boolean;
  atrasoMs: number;
  classe: ClasseFalhaOmie;
}

/** Teto por chamada — 1 original + 4 retentativas. É o `maxAttempts = 5` que as duas edges já tinham. */
export const MAX_TENTATIVAS_CMC_SNAPSHOT = 5;

// Backoff das edges preservado VERBATIM: 1s / 2s / 4s / 8s (15s se esgotar).
//
// ⚠️ `atrasoRetentativaMs` do helper NÃO é usado, de propósito. Ele tem base 800ms e TETO de 5s,
// calibrados para o orçamento de ~150s do `omie-cliente`; aplicá-lo aqui encurtaria as quatro esperas
// (0,8 / 1,6 / 3,2 / 5,0 = 10,6s). E esperar MENOS é exatamente o que reencosta no lock de
// concorrência do Omie ("Já existe uma requisição desse método sendo executada") — o motivo de todas
// as chamadas destas edges serem serializadas. Trocar a política de ESPERA não é o objetivo desta
// entrega: aqui só a CLASSIFICAÇÃO muda. O orçamento local é o do cron (600s), não os 150s de lá.
const ATRASO_BASE_MS = 1000;

function atrasoRetentativaCmcMs(tentativa: number): number {
  return ATRASO_BASE_MS * 2 ** (Math.max(1, Math.floor(tentativa)) - 1);
}

/**
 * Decide se a chamada ao Omie deve ser repetida.
 *
 * ⚠️ Usa `classificarFaultstring`, não `classificarExcecao`, embora o texto chegue sempre de um
 * `catch`. A única diferença entre as duas é o tratamento de `fim_de_pagina`, e ela importa: a versão
 * de exceção o converte em `indeterminada`, que AQUI retenta — a mensagem de EOF do Omie ("Não
 * existem registros para a página [5]!") passaria a comprar 4 chamadas e 15s. Ela não retentava antes
 * (não casa marcador nenhum do bloco removido) e não pode passar a retentar: fim não muda por
 * retentativa. Estas edges paginam por `nTotPaginas` + os guards de `omie-paginacao.ts`, então a
 * faultstring de EOF chegando ao `callOmie` já é anomalia — que deve propagar rápido, não dormir.
 *
 * @param tentativa 1-based, já contando a que acabou de falhar.
 */
export function decidirRetentativaCmcSnapshot(
  mensagem: string,
  tentativa: number,
  maxTentativas: number = MAX_TENTATIVAS_CMC_SNAPSHOT,
): DecisaoRetentativaCmcSnapshot {
  const classe = classificarFaultstring(mensagem);
  const retentavel = classe === "transitorio" || classe === "indeterminada";
  const retentar = retentavel && tentativa < maxTentativas;
  return { retentar, atrasoMs: retentar ? atrasoRetentativaCmcMs(tentativa) : 0, classe };
}

/**
 * Monta a mensagem de faultstring do Omie com a credencial ecoada MASCARADA.
 *
 * ⚠️ Não é higiene: a faultstring de credencial CONTÉM a app_key ("Chave de acesso não cadastrada
 * para o aplicativo [1503123456]"), e daqui o texto ia cru para o corpo da resposta 500 das duas
 * edges. No `cmc-snapshot-backfill` esse corpo é o de uma invocação por CRON, e o corpo da resposta
 * de um `net.http_post` fica PERSISTIDO em `net._http_response.content` — credencial em tabela não é
 * diagnóstico. O que se preserva é a conta e a FORMA da mensagem, que é o que a torna acionável.
 */
export function mensagemFaultstringOmie(account: string, faultstring: unknown): string {
  return `Omie (${account}): ${redigirSegredo(String(faultstring))}`;
}

/**
 * Mensagem de resposta HTTP não-2xx. Preserva a forma que as duas edges já emitiam
 * (`Omie (<conta>) HTTP <n>: <corpo>`) — que é ANCORADA, e é o que permite ao padrão do helper
 * reconhecer o 5xx sem depender de dígito solto.
 *
 * ⚠️ Redige ANTES de truncar. Truncar primeiro pode PARTIR a app_key na borda dos 300 caracteres,
 * deixando um resto de 7 dígitos que escapa da máscara `\d{8,}`: o segredo sairia pela metade, o que
 * para efeito de vazamento é sair.
 *
 * O `status` vem do runtime (`res.status`), não do Omie — não é redigido de propósito: número curto é
 * o que torna o motivo acionável, e mascará-lo sugeriria um risco que não existe.
 */
export function mensagemHttpOmie(account: string, status: number, corpo: string): string {
  return `Omie (${account}) HTTP ${status}: ${redigirSegredo(corpo).slice(0, 300)}`;
}
