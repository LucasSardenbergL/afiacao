// Marcador de versão da edge `omie-nfe-recebimento-sync`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: materializa recebimentos de NF-e a partir do Omie pela RPC transacional
// `importar_nfe_recebimento` (cabeçalho + itens numa transação; v1.5). Até a v1.4 eram DUAS escritas
// não-transacionais.
//
// Entrou na 12ª leva (2026-09-05) pelo critério "escrita money-path no NOSSO banco", e é a
// continuação direta da 11ª: ela também estava na CLASSE CEGA do Passo 3 do `/fecho` — fora do
// mapa de fingerprints E importando `_shared/`, logo invisível para as vias (a) e (b) do
// `edges-pendentes.sh`. A via (c) (grafo de imports, #2170) fechou a ENUMERAÇÃO; o `versao.ts` é o
// que dá SUPRESSÃO por evidência positiva servida.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR (a triagem de `docs/agent/deploy.md` §"O CUSTO da sonda, edge a
// edge", que decide `--caro`): CARA — não sonde às cegas. Ela não lê o corpo NENHUM no bundle
// atual: `{"probe":true}` cai direto no laço de sync de todas as credenciais. Pior, a falha dos
// itens só faz `console.error` e o cabeçalho FICA; na retentativa o `omie_id_receb` já está em
// `existingIds` e a NF é PULADA — o recebimento pela metade nunca se conserta sozinho.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-nfe-recebimento-sync");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 * v1.1: NCM gravado em 8 dígitos (o pontuado do Omie estourava `varchar(8)` e zerava os itens de
 * TODA NF-e) e a falha do insert de itens sai em errors[] em vez de contar como importada.
 * v1.2: importação de UMA NF-e pela chave (`{ chave_acesso, warehouse_id }`), o caminho do botão
 * "Importar NF-e" — antes ele chamava o `omie-nfe-webhook`, que dá 401 sem o segredo do Omie.
 * v1.3: a listagem do cron pede `cExibirDetalhes:'S'` e a triagem pula já importada/recebida/
 * cancelada ANTES da única consulta de detalhe (a recebida no topo travava a fila da Oben desde
 * 14/08); o que a listagem não diz vai à consulta como incompleta; a consulta é SORTEADA por hash
 * de (minuto, id) — nenhuma candidata a prende para sempre; "aberta" exige `cRecebido` e
 * `cCancelada` "N" explícitos (estado.ts), no cron e na importação por chave — sem eles, não grava;
 * o corpo de falha do Omie vale com HTTP 200 ou 500 ("não existem registros" é fim); a resposta traz
 * `por_armazem` com o desfecho da consulta (o sensor do cron), mesmo quando algo quebra no meio. O
 * laço mora em rodada.ts, testado no Deno com falsos.
 * v1.5: cabeçalho + itens numa TRANSAÇÃO pela RPC `importar_nfe_recebimento` (lock por chave, 1 writer
 * com o webhook; db/2026-10-18-importar-nfe-recebimento-rpc.sql); a triagem do cron deixa de pular o
 * cabeçalho `pendente` sem itens e sem sinais de uso — a consulta o COMPLETA (reparada) — e pula a
 * chave estacionada em nfe_importacao_falhas (≥3 falhas de dado); o botão "Importar NF-e" idem, sem o
 * DELETE de compensação (podia apagar em cascata itens de outro writer). ⚠️ Deploy SÓ depois da
 * migration: sem a RPC, cron e botão respondem erro nomeando-a (fail-closed), não o caminho antigo.
 */
export const VERSAO = "v1.5-rpc-transacional";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge materializa recebimentos de NF-e (RPC importar_nfe_recebimento: nfe_recebimentos + " +
  "nfe_recebimento_itens numa transação, com lock por chave) e consulta o Omie — 1 consulta de " +
  "detalhe por conta e rodada";
