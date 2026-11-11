// Desfecho do `catch` do `buscar_cliente_por_documento`. O `callOmieApi` desta edge lança `Erro Omie:
// <faultstring>` para QUALQUER faultstring, inclusive o EOF ("Não existem registros para a página"),
// que é como o Omie responde a uma busca vazia. Antes, todo erro virava `codigo_cliente: null`: um 503
// ou uma credencial recusada eram lidos como "o cliente não existe" e o front tentava
// `criar_cliente_afiacao` sobre uma falsa ausência (Codex retroativo do #3311, 2026-10-27).
// Agora só o EOF é ausência; transitório, permanente e indeterminado falham alto (500).
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import type { ListarPagina } from "../_shared/lookup-cliente-estrito.ts";
import { atrasoRetentativaMs, classificarExcecao, classificarFaultstring } from "../_shared/omie-falha.ts";

/** true só quando o erro é o EOF do Omie, a única falha que significa "não há cliente com esse documento". */
export function buscaPorDocumentoNaoAchou(erro: unknown): boolean {
  return classificarFaultstring(mensagemDeErro(erro)) === "fim_de_pagina"; // null → "indeterminada"
}

/**
 * 1º cliente de um `ListarClientes` por documento, com o desfecho decidido num lugar só (as duas
 * leituras da edge, `buscar_cliente_por_documento` e a reconsulta do `criar_cliente_afiacao`):
 *   · EOF do Omie ("Não existem registros") ou página vazia → `undefined` (ausência);
 *   · resposta sem `clientes_cadastro` em array (`{}`, `{"error":…}`, objeto no lugar da lista) → LANÇA
 *     `OMIE_RESPOSTA_MALFORMADA` — virava "não existe" e liberava cadastro sobre falsa ausência;
 *   · qualquer outro erro → relança.
 * A reconsulta do criar_cliente_afiacao lia o EOF como falha e devolvia success:false: cliente novo
 * nunca era cadastrado na Afiação (Codex 2026-10-27).
 */
export async function primeiroClientePorDocumento<T>(chamar: () => Promise<unknown>): Promise<T | undefined> {
  let resposta: unknown;
  try {
    resposta = await chamar();
  } catch (erro) {
    if (buscaPorDocumentoNaoAchou(erro)) return undefined;
    throw erro;
  }
  const lista = (resposta as { clientes_cadastro?: unknown } | null | undefined)?.clientes_cadastro;
  if (!Array.isArray(lista)) {
    throw new Error("OMIE_RESPOSTA_MALFORMADA: ListarClientes sem clientes_cadastro em lista — não dá pra afirmar ausência");
  }
  return lista[0] as T | undefined;
}

/**
 * SÓ a recusa por chamada simultânea ou rate-limit do Omie, que passa em segundos. Timeout, 5xx e o resto do
 * "transitório" NÃO entram: cada `callOmieApi` tem relógio próprio de 140s, e retentar um timeout empilharia 3×140s
 * até a plataforma matar a edge (revisão adversarial do Fable, 2026-11-11). Esses sobem na 1ª, como antes.
 */
export function recusaPorConcorrencia(erro: unknown): boolean {
  const t = (erro instanceof Error ? erro.message : String(erro)).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return classificarExcecao(erro) === "transitorio"
    && ["ja existe uma requisicao desse metodo", "consumo redundante", "redundant"].some((m) => t.includes(m));
}

/**
 * Leitura com até `tentativas` chamadas, retentando SÓ a recusa por concorrência (`recusaPorConcorrencia`): a consulta da razão fiscal do `criar_cliente_afiacao` corre em paralelo com a do `criar_cliente` da
 * Colacor na MESMA conta Oben (o front dispara os dois cadastros juntos), e o Omie recusa a 2ª chamada simultânea do
 * método. Sem isto, a busca ao vivo mascarada (M1, 2026-11-11) fazia o cadastro da Afiação falhar onde antes não havia
 * consulta. Só para LEITURA: a escrita indeterminada nunca se repete. Timeout/5xx/permanente sobem na 1ª.
 */
export async function lerComRetentativa<T>(
  ler: () => Promise<T>,
  opcoes: { tentativas?: number; esperar?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const tentativas = opcoes.tentativas ?? 3;
  const esperar = opcoes.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await ler();
    } catch (erro) {
      if (tentativa >= tentativas || !recusaPorConcorrencia(erro)) throw erro;
      await esperar(atrasoRetentativaMs(tentativa, erro instanceof Error ? erro.message : String(erro)));
    }
  }
}

/**
 * Página do ListarClientes por documento no formato que o lookup ESTRITO (`_shared/lookup-cliente-estrito.ts`) consome,
 * para o `criar_cliente_afiacao` (MÉDIO 2 do Codex no #3803): o lookup de antes lia só o 1º registro de UMA página e
 * não via um 2º código para o mesmo documento nem a contradição `{registros:1, clientes_cadastro:[]}`.
 *   · EOF do Omie ("Não existem registros") → `null`, o fim real que o lookup estrito espera;
 *   · recusa por concorrência ("Já existe uma requisição desse método") → retentada (`lerComRetentativa`);
 *   · qualquer outro erro → sobe: "não consegui ver" nunca é "não existe".
 * O `callOmieApi` desta edge não recebe prazo externo: o orçamento de 40s do lookup é conferido depois de cada página.
 */
export function paginaDeClientesPorDocumento(
  chamar: (pagina: number, porPagina: number) => Promise<unknown>,
  opcoes: { esperar?: (ms: number) => Promise<void> } = {},
): ListarPagina {
  return (pagina, porPagina) =>
    lerComRetentativa(async () => {
      try {
        return await chamar(pagina, porPagina);
      } catch (erro) {
        if (buscaPorDocumentoNaoAchou(erro)) return null;
        throw erro;
      }
    }, opcoes);
}
