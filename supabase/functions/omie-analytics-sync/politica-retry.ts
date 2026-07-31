// Política de retentativa e redação do `callOmie` (omie-analytics-sync) — lógica PURA.
//
// ── Por que este módulo existe separado do index.ts ────────────────────────────────────────────
// O `index.ts` importa `https://deno.land/...` e `npm:@supabase/supabase-js`, e a suíte de edge
// roda com `--no-remote` — logo ele NÃO é importável por teste. A 1ª versão desta entrega tentou
// contornar isso com gates que liam o FONTE procurando tokens (`includes("503")`,
// `=== "transitorio"`, a palavra `redigirSegredo`). O challenge do Codex derrubou os três
// executando mutações contra os próprios predicados: trocar a classificação por um REGEX de
// dígito cru passava; fixar `classe = "permanente"` e deixar o helper importado sem uso passava;
// emitir o segredo cru com `redigirSegredo` num ramo morto passava. Gate de token não tem vínculo
// semântico com o que a edge faz.
//
// A correção é a doutrina do repo (CLAUDE.md: "Precisa de dep? Extraia a lógica PURA e teste
// ela"): a decisão vive aqui, sem I/O e sem import remoto, e o `callOmie` vira o transporte que a
// consulta. O teste passa a medir COMPORTAMENTO (dada a mensagem e a tentativa, retenta? quanto
// dorme? o texto sai redigido?) em vez de procurar palavras no fonte.
import { atrasoRetentativaMs, type ClasseFalhaOmie, classificarFaultstring, redigirSegredo } from "../_shared/omie-falha.ts";

export interface DecisaoRetentativa {
  retentar: boolean;
  atrasoMs: number;
  classe: ClasseFalhaOmie;
}

/** Teto de tentativas por chamada — 1 original + 3 retentativas (backoff 0,8s / 1,6s / 3,2s). */
export const MAX_TENTATIVAS_OMIE = 4;

/**
 * Decide se a chamada ao Omie deve ser repetida.
 *
 * ⚠️ Só `transitorio` retenta. `indeterminada` falha RÁPIDO, e essa é uma divergência DELIBERADA
 * de `decidirDesfechoFalha` (a política do helper, onde indeterminada retenta) — a unidade de
 * trabalho é outra. Lá o retry é por PÁGINA e desistir custa uma conta inteira. Aqui o
 * `ConsultarEstrutura` roda por PRODUTO num laço de ~1.334 alvos em lotes de 8, com o caller
 * degradando honesto (`custo_producao_status='erro_api'`), e o orçamento do worker é de ~150s.
 *
 * A conta, medida em produção 2026-07-31 (825 dos ~1.334 alvos falhando por ciclo): o sleep é
 * pago por LOTE que contenha ao menos uma falha, então o custo de retentar indeterminada fica
 * entre `ceil(825/8) × 5,6s ≈ 582s` (empacotamento perfeito, todas as falhas juntas) e
 * `ceil(1334/8) × 5,6s ≈ 935s` (falhas espalhadas, todo lote com uma) — sem contar as chamadas
 * HTTP extras. Os dois extremos estouram os ~150s, o que troca uma falha parcial REPORTADA pelo
 * WORKER_RESOURCE_LIMIT que o lote paralelo existe para evitar, com o sync_state preso em
 * 'running'. Quem for mudar isto refaz a conta com o número de falhas do ciclo, não com este.
 *
 * @param tentativa 1-based, já contando a que acabou de falhar.
 */
export function decidirRetentativaOmie(
  mensagem: string,
  tentativa: number,
  maxTentativas: number = MAX_TENTATIVAS_OMIE,
): DecisaoRetentativa {
  const classe = classificarFaultstring(mensagem);
  const retentar = classe === "transitorio" && tentativa < maxTentativas;
  // ⚠️ `atrasoRetentativaMs` SEM a faultstring, de propósito: com ela, o helper honra o
  // "Aguarde N segundos" do rate-limit do Omie (teto de 5s POR TENTATIVA), e o challenge do Codex
  // mediu o efeito — "Aguarde 3 segundos" leva o total de 5,6s para 10,5s, e "Aguarde 90" para
  // 15s. Num laço de 167 lotes isso é orçamento do worker, não cortesia. A curva fica idêntica à
  // que esta edge já tinha (0,8s / 1,6s / 3,2s). Honrar o pedido do servidor é melhora legítima,
  // mas exige medir o custo no laço de lotes primeiro — follow-up, não carona nesta entrega.
  return { retentar, atrasoMs: retentar ? atrasoRetentativaMs(tentativa) : 0, classe };
}

/**
 * Monta a mensagem de falha que SAI da edge, redigindo o texto produzido pelo Omie.
 *
 * ⚠️ Não é higiene: a faultstring de credencial ECOA a app_key ("Chave de acesso não cadastrada
 * para o aplicativo [1503123456]"), e daqui o texto vai para três sinks — `sync_state.error_message`
 * (PERSISTIDO, nos catch de syncCustomers/syncProducts/syncInventory/syncCustoProducao), o
 * `console.error` do laço de `ConsultarEstrutura`, e o corpo da resposta 500 do handler.
 * Redigir na CONSTRUÇÃO da mensagem cobre os três de uma vez.
 *
 * `origem` diz quem produziu o texto: só `omie` é redigido. `runtime` é para valor que a própria
 * edge produz (o `res.status` do fetch) — redigi-lo seria código morto sugerindo um risco que não
 * existe, e número curto é justamente o que torna o motivo acionável.
 */
export function mensagemFalhaOmie(
  account: string,
  texto: string,
  origem: "omie" | "runtime" = "omie",
): string {
  return `Omie (${account}): ${origem === "omie" ? redigirSegredo(String(texto)) : String(texto)}`;
}

/**
 * Mensagem para resposta cujo CORPO não é JSON — página de erro de gateway/CDN no caminho.
 *
 * ⚠️ O `callOmie` chama `res.json()` ANTES de testar `res.ok`, então um 5xx com corpo de texto
 * estoura no parser e nunca chega ao guard de status. A mensagem do parser do Deno ecoa o corpo
 * ("Unexpected token 'E', \"ERROR 503\" is not valid JSON") — o classificador ANTIGO via o `503`
 * solto ali e retentava; o novo, que exige a forma ancorada, não veria nada e falharia na 1ª
 * tentativa. Regressão real de transporte, achada pelo challenge do Codex.
 *
 * Por isso, quando o corpo não parseia, o STATUS é o único sinal confiável e ele sai na forma
 * ANCORADA (`HTTP <n>`) — que é o que faz um 502/503/520 de gateway voltar a ganhar backoff.
 *
 * Num 2xx com corpo não-JSON o status não diz nada (é 200), então não há o que ancorar: a
 * mensagem sai como falha indeterminada e falha rápido — mesmo desfecho que o classificador
 * antigo dava a essa forma, já que a mensagem do parser não carrega código HTTP nenhum.
 */
export function mensagemCorpoNaoJson(account: string, status: number, erro: unknown): string {
  const detalhe = redigirSegredo(erro instanceof Error ? erro.message : String(erro)).slice(0, 200);
  return status >= 200 && status < 300
    ? `Omie (${account}): resposta HTTP ${status} com corpo não-JSON — ${detalhe}`
    : `Omie (${account}): HTTP ${status} (corpo não-JSON) — ${detalhe}`;
}
