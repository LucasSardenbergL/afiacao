// Marcador de versão da edge `omie-nfe-webhook`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: ela MATERIALIZA o recebimento no nosso banco — `insert` em
// `nfe_recebimentos` (cabeçalho) e depois em `nfe_recebimento_itens`. É a porta de entrada do
// chão de fábrica: a partir daqui a NF-e aparece para conferência e vira candidata à efetivação
// no Omie pela `omie-nfe-recebimento`.
//
// Desde a v1.4 a materialização é UMA transação no banco: a RPC `importar_nfe_recebimento`
// (lock consultivo por chave + FOR UPDATE no cabeçalho + cabeçalho e lote no mesmo commit;
// db/2026-10-18-importar-nfe-recebimento-rpc.sql). Ela COMPLETA um cabeçalho `pendente` que ficou
// sem itens e sem sinal de uso, certifica "já importada" só pelo MESMO CONJUNTO de itens, e fecha
// webhook×sync e reconcile-no-meio — o que a v1.3 (ids determinísticos, sem migration) deixava
// aberto. Erro de dado vai a `nfe_importacao_falhas`. Ver _shared/nfe-importacao.ts e resposta.ts.
// ⚠️ Deploy desta versão SÓ depois da migration aplicada: sem a RPC a edge responde 500 nomeando a
// migration (fail-closed), não cai no caminho antigo.
//
// ⚠️ O gate desta edge é `x-webhook-secret` (segredo compartilhado com o Omie, que não emite
// JWT) — ele NÃO aceita `x-cron-secret`, que é como o founder invoca a sonda pelo SQL Editor.
// Daí o gate próprio da sonda no `index.ts`; ver o comentário lá.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-nfe-webhook");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.4-rpc-transacional";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge INSERE o recebimento no nosso banco (RPC importar_nfe_recebimento: nfe_recebimentos + " +
  "nfe_recebimento_itens numa transação, com lock por chave) e o torna visível para conferência e " +
  "efetivação; erro de dado fica registrado em nfe_importacao_falhas";
