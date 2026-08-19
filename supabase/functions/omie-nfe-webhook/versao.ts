// Marcador de versão da edge `omie-nfe-webhook`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: ela MATERIALIZA o recebimento no nosso banco — `insert` em
// `nfe_recebimentos` (cabeçalho) e depois em `nfe_recebimento_itens`. É a porta de entrada do
// chão de fábrica: a partir daqui a NF-e aparece para conferência e vira candidata à efetivação
// no Omie pela `omie-nfe-recebimento`.
//
// ⚠️ As duas inserções NÃO são transacionais e o guard de duplicata é check-then-insert por
// `chave_acesso`: se os itens falharem, sobra cabeçalho órfão — e a retentativa cai no ramo
// "já importada", que devolve 200 sem reinserir nada. Ou seja, a reexecução não conserta: ela
// esconde. Por isso desfazer é trabalho manual no banco, não um retry.
//
// ⚠️ O gate desta edge é `x-webhook-secret` (segredo compartilhado com o Omie, que não emite
// JWT) — ele NÃO aceita `x-cron-secret`, que é como o founder invoca a sonda pelo SQL Editor.
// Daí o gate próprio da sonda no `index.ts`; ver o comentário lá.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-nfe-webhook");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge INSERE o recebimento no nosso banco (nfe_recebimentos + nfe_recebimento_itens) e o " +
  "torna visível para conferência e efetivação — as duas inserções não são transacionais, e como " +
  "o guard de duplicata por chave_acesso responde 'já importada', uma retentativa não conserta " +
  "cabeçalho órfão: esconde";
