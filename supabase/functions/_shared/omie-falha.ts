// Classificação PURA de falha do Omie + política de retentativa POR PÁGINA. Sem I/O, sem
// dependência de runtime — testes em omie-falha_test.ts (Deno, `--no-remote`).
//
// ── Por que existe ────────────────────────────────────────────────────────────────────────
// No varredor de contas do `sync_all_clients` (omie-cliente) TODO faultstring que não fosse o
// EOF do contrato Omie caía num `break` único: saía do laço SEM avançar `page` e SEM marcar
// fim real. O cursor então devolvia `hasMore=true` apontando para a MESMA conta e a MESMA
// página, e o caller (`useAnalyticsSync`, laço `while (true)`) reinvocava na hora — laço
// quente contra o Omie, e as contas SEGUINTES do array reféns de uma conta quebrada (o sync
// inteiro parava na primeira credencial revogada). Um erro PERMANENTE nunca sai desse estado
// por retentativa: a mesma app_key inválida devolve o mesmo erro para sempre.
//
// ── A assimetria que decide a rotulagem (money-path §1, precisão > recall) ─────────────────
// Errar para PERMANENTE: a conta é abandonada cedo → import parcial, mas REPORTADO no
//   resultado e recuperável no ciclo seguinte (o import é idempotente pelo dedup).
// Errar para TRANSITÓRIO: custa só as retentativas do teto — o teto abandona a conta do mesmo
//   jeito, com o mesmo relatório.
// Logo o caro é declarar PERMANENTE sem prova. Por isso: (a) `permanente` exige marcador
// explícito de credencial/autorização; (b) transitório VENCE o empate quando a mensagem casa
// os dois (uma falha de servidor que cita a chave é falha de servidor); (c) o default é
// `indeterminada`, que NÃO trava (o teto de tentativas trata) e não mente sobre a causa.
//
// ⚠️ Nenhuma classe pode significar "fim": só o EOF do contrato Omie encerra uma conta. Aqui
// as classes decidem RETENTAR ou ABANDONAR-REPORTANDO — nunca "concluído".

/**
 * `fim_de_pagina` é o EOF do contrato Omie, não falha: a conta acabou.
 * `transitorio` vale retentar (servidor/rede/rate-limit).
 * `permanente` não muda por retentativa (credencial/autorização/validação).
 * `indeterminada` = não classificável — trata-se como retentável COM TETO, nunca como fim.
 */
export type ClasseFalhaOmie = "fim_de_pagina" | "transitorio" | "permanente" | "indeterminada";

// Comparação sempre sobre texto normalizado: minúsculo e SEM acento. O Omie mistura
// acentuação e caixa entre mensagens, e casar acento é armadilha recorrente do repo
// (money-path §"a sabotagem não casou nada": padrão escrito `pagina` contra código `página`).
// Os marcadores abaixo são todos ASCII de propósito.
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    // Sequência de ESCAPE, não os combining marks crus: byte/glifo de controle literal no fonte
    // passa em todos os gates e vira blob binário para o git (money-path §"O FONTE mente").
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// EOF do contrato Omie. Mesmo tratamento do callOmieVendasApi (omie-vendas-sync).
const MARCADORES_FIM = ["nao existem registros para a pagina"];

// Servidor/rede/rate-limit — o que o retry das edges irmãs (callOmie do omie-analytics-sync,
// callOmieVendasApi do omie-vendas-sync) já retentava.
//
// ⚠️ A 1ª versão trazia os códigos "429"/"502"/"503"/"504" CRUS, com a justificativa de que
// casar um número de negócio "só" rotularia um permanente como transitório. O challenge do
// Codex (xhigh) derrubou isso EXECUTANDO o helper: `"Chave de acesso não cadastrada para o
// aplicativo [1503123456]"` — o erro de credencial mais comum do Omie — casa `503` DENTRO da
// app_key ecoada e vira `transitorio`, apesar de casar também `chave de acesso`. Não é um
// número de negócio improvável: é a própria chave, presente em toda mensagem dessa família.
// Por isso os códigos só valem ANCORADOS na forma HTTP, que é como o wrapper desta edge os
// emite (`Erro HTTP 503 do Omie`).
const MARCADORES_TRANSITORIOS = [
  "soap-error",
  "broken response",
  "application server",
  "timeout",
  "timed out",
  "time out",
  "tempo esgotado",
  "ja existe uma requisicao desse metodo",
  "consumo redundante",
  "redundant",
  "aguarde",
  "rate limit",
  "too many",
  "http 429",
  "http 500",
  "http 502",
  "http 503",
  "http 504",
  "status 429",
  "status 500",
  "status 502",
  "status 503",
  "status 504",
  "bad gateway",
  "service unavailable",
  "internal server error",
  "servico indisponivel",
  "servidor indisponivel",
  // "temporari" cobre temporária/temporário/temporarily — e precisa vir ANTES do teste de
  // permanente, senão "Falha temporária ao validar credenciais" casaria `credencia` e viraria
  // permanente, abandonando a conta por um erro que passa sozinho (achado Codex P2).
  "temporari",
  "network",
  "connection",
  "econnreset",
  "fetch failed",
  "error sending request",
  "socket",
];

// Credencial/autorização/validação de acesso: a próxima chamada devolve exatamente o mesmo
// erro. "Chave de acesso não cadastrada para o aplicativo" é o clássico do Omie quando a
// app_key/app_secret está errada ou foi revogada. `bloqueado` entra só nas formas que falam do
// ACESSO — "cliente bloqueado" é dado do cadastro, não credencial.
const MARCADORES_PERMANENTES = [
  "chave de acesso",
  "app_key",
  "app key",
  "appkey",
  "app_secret",
  "app secret",
  "appsecret",
  "credencia",
  "nao autorizado",
  "nao autorizada",
  "unauthorized",
  "forbidden",
  "acesso negado",
  "acesso bloqueado",
  "aplicativo bloqueado",
  "sem permissao",
  "nao tem permissao",
  "permission denied",
  "assinatura invalida",
];

/**
 * Classifica o texto de uma falha do Omie (faultstring ou mensagem de exceção — os dois são
 * só texto). Ordem deliberada: fim → transitório → permanente → indeterminada.
 *
 * O fim vem primeiro porque a mensagem de EOF cita o número da página e um número de página
 * poderia casar um marcador HTTP. O transitório vem antes do permanente porque o empate tem
 * de cair no lado barato (ver a assimetria no topo do arquivo).
 */
export function classificarFaultstring(texto: string | null | undefined): ClasseFalhaOmie {
  if (!texto) return "indeterminada";
  const t = normalizar(String(texto));
  if (MARCADORES_FIM.some((m) => t.includes(m))) return "fim_de_pagina";
  if (MARCADORES_TRANSITORIOS.some((m) => t.includes(m))) return "transitorio";
  if (MARCADORES_PERMANENTES.some((m) => t.includes(m))) return "permanente";
  return "indeterminada";
}

/**
 * Mascara credencial ecoada pelo Omie antes de o texto sair da edge.
 *
 * ⚠️ Não é higiene: a mensagem de erro mais comum desta família é `"Chave de acesso não
 * cadastrada para o aplicativo [1503123456]"` — ela **contém a app_key**. Esse texto ia cru
 * para o resultado da edge, de onde é persistido em `acoes_execucoes.detalhes` e exibido num
 * toast; publicar credencial em tabela e em tela é vazamento, não diagnóstico (achado Codex
 * P2, provado com a própria fixture do teste). O operador ainda precisa distinguir uma conta
 * da outra, então o que se preserva é a CLASSE e a forma da mensagem, não o segredo.
 *
 * Mascara sequências longas de dígitos (app_key) e de hex (app_secret). Sequências curtas —
 * número de página, código de cliente, código HTTP — passam intactas de propósito: são o que
 * torna o motivo acionável.
 */
export function redigirSegredo(texto: string): string {
  return texto
    .replace(/[0-9a-f]{24,}/gi, "[redigido]")
    .replace(/\d{8,}/g, "[redigido]");
}

/**
 * Classifica uma EXCEÇÃO (não uma resposta do Omie). Nunca devolve `fim_de_pagina`.
 *
 * Existe separada porque `fim_de_pagina` é a única classe cujo desfecho NÃO TERMINA — não
 * retenta e não abandona, de propósito, já que o fim de conta é decidido antes por quem lê a
 * resposta. Um `catch` que recebesse essa classe (basta o texto do erro citar a mensagem de EOF)
 * nem sairia do laço nem avançaria a página: o laço quente original de volta, por outra porta.
 * O fim de conta SÓ chega como `faultstring` numa resposta normal, jamais como throw.
 */
export function classificarExcecao(erro: unknown): ClasseFalhaOmie {
  const texto = erro instanceof Error ? erro.message : String(erro);
  const classe = classificarFaultstring(texto);
  return classe === "fim_de_pagina" ? "indeterminada" : classe;
}

export interface DesfechoFalhaPagina {
  /** Tentar a MESMA página de novo nesta invocação (o cursor não avança). */
  retentarPagina: boolean;
  /** Desistir desta conta: o cursor vai para a próxima e a falha viaja no resultado. */
  abandonarConta: boolean;
}

/**
 * Decide o que fazer com uma página que falhou.
 *
 * ⚠️ `abandonarConta` NUNCA significa "conta concluída" — significa "conta com import parcial,
 * e a falha tem de aparecer no resultado". Quem chama é obrigado a propagar o motivo: abandonar
 * em silêncio seria trocar o laço quente por uma mentira de sucesso, que é pior (money-path §8).
 *
 * @param tentativasNaPagina já contando a tentativa que acabou de falhar.
 */
export function decidirDesfechoFalha(input: {
  classe: ClasseFalhaOmie;
  tentativasNaPagina: number;
  maxTentativas: number;
}): DesfechoFalhaPagina {
  // EOF não é falha — o caller o trata antes. Chegar aqui significa encaminhamento por engano:
  // não retenta (não há o que ler) e não abandona (senão fim REAL viraria falha reportada).
  if (input.classe === "fim_de_pagina") return { retentarPagina: false, abandonarConta: false };
  // Permanente: retentar só queima chamada Omie e tempo — e, sem abandonar, PRENDE as contas
  // seguintes. É exatamente o bug que este helper existe para fechar.
  if (input.classe === "permanente") return { retentarPagina: false, abandonarConta: true };
  const esgotou = input.tentativasNaPagina >= input.maxTentativas;
  return { retentarPagina: !esgotou, abandonarConta: esgotou };
}

const ATRASO_BASE_MS = 800;
// Teto curto de propósito: a invocação inteira divide um orçamento de ~150s com o trabalho de
// banco (dedup por conta + por documento) e com até 3 páginas. Um backoff generoso aqui viraria
// timeout da edge — que reintroduz, por outra porta, o "não sei se terminou".
const ATRASO_TETO_MS = 5000;

/** Backoff da retentativa. Honra o "Aguarde N segundos" do rate-limit do Omie, com teto. */
export function atrasoRetentativaMs(tentativa: number, faultstring?: string | null): number {
  const pedido = faultstring ? /aguarde\s+(\d+)\s*segundo/.exec(normalizar(String(faultstring))) : null;
  if (pedido) {
    const segundos = Number(pedido[1]);
    if (Number.isFinite(segundos) && segundos > 0) {
      return Math.min(segundos * 1000 + 500, ATRASO_TETO_MS);
    }
  }
  const expoente = Math.max(1, Math.floor(tentativa)) - 1;
  return Math.min(ATRASO_BASE_MS * 2 ** expoente, ATRASO_TETO_MS);
}
