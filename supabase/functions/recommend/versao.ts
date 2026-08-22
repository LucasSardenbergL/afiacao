// Identidade da edge `recommend` para a sonda de versão (`_shared/sonda-versao.ts`).
//
// Por que esta edge ganhou canária, se a leitura pura ficou de fora de propósito na 3ª leva:
// `recommend` NÃO é leitura pura. Ela grava `recommendation_log`, que é o SENSOR DE DESFECHO do
// motor (#1851) — a tabela que responde "o que o motor recomendou virou venda?". Sondar sem guarda
// inventaria uma recomendação que ninguém pediu e enviesaria a própria medição de acerto, que é a
// evidência com que se decide o futuro do motor.
//
// E há o motivo que trouxe o PR: o deploy do #1856 (keyset) não teve como ser PROVADO. A escada de
// `lovable-deploy-verify` morre no N1 aqui — N2 (Management API) é estruturalmente indisponível
// (o Supabase é da org do Lovable) e N3 não existia porque faltava canária. O melhor que se
// conseguiu dizer foi "servida, e o bundle carrega"; a versão ficou por provar. Esta é a peça que
// faltava para o próximo deploy se provar sozinho, sem depender de alguém abrir a tela.
export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("recommend");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * Nasce em `v1.1` e não em `v1.0-sensor-inicial` de propósito: o bundle em produção JÁ tem o keyset
 * do #1856. Carimbar `v1.0` sugeriria que esta é a primeira versão instrumentada de um código
 * parado, quando o que a sonda passa a distinguir daqui para a frente é justamente o que veio
 * depois dele.
 *
 * `v1.2`: o `sim_score` passou a vir agregado do banco (`recommend_cluster_agregado`) em vez de
 * um teto de 1.000 linhas de `order_items` que zerava clientes com compra real. É a primeira vez
 * que a sonda serve ao propósito para que nasceu — este deploy depende de uma MIGRATION manual,
 * e sem ela "a edge nova está no ar?" e "a função existe no banco?" seriam duas perguntas sem
 * resposta em vez de uma consulta e uma sonda.
 */
export const VERSAO = "v1.3-sonda-com-gate";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge roda o motor de recomendação do cliente (seis leituras paginadas: catálogo, custos, " +
  "histórico de compras, regras de associação e score) e GRAVA `recommendation_log` — o sensor de " +
  "desfecho que mede se a recomendação virou venda; uma linha inventada por sondagem entra no " +
  "denominador dessa medição e a enviesa";
