// Marcador de versão da edge `omie-nfe-recebimento-sync`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: materializa recebimentos de NF-e a partir do Omie: insere `nfe_recebimentos` e
// depois `nfe_recebimento_itens` em DUAS escritas não-transacionais.
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

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge materializa recebimentos de NF-e (nfe_recebimentos + nfe_recebimento_itens, em " +
  "duas escritas não-transacionais) e o guard de duplicata faz a retentativa PULAR a NF " +
  "importada pela metade em vez de consertá-la";
