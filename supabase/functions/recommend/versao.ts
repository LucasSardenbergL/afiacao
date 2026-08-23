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
 *
 * `v1.6`: o #1901 mudou `_shared/paginate.ts`, que esta edge empacota — `fetchAllKeyset` passou a
 * inicializar `anterior` com o `cursor` em vez de `null`, fechando a sobreposição PONTUAL de página
 * (linha já lida reaparecendo no começo da próxima, que a checagem de cursor no fim do laço não
 * alcança porque só olha a ÚLTIMA linha). O bump não é cosmético: `recommend` é a ÚNICA edge com
 * call-site vivo de `fetchAllKeyset` (`order_items` e `omie_products`, via
 * `_shared/recommend-leituras.ts`), então é aqui que o fix importa — e era aqui que ele não tinha
 * como se provar.
 *
 * Por que o bump do #1898 NÃO cobriu isto, que é a armadilha a registrar: o #1905 concluiu que a
 * `recommend` estava "resolvida de graça" porque o #1898 já a levara a `v1.5`. Verdade para o
 * #1889 — mas o #1901 mergeou às 01:26Z, 27 minutos DEPOIS do #1898 (00:59:52Z) e 12 antes do
 * #1905, e não bumpou nada. Resultado medido em 2026-08-23: `main` e prod respondiam ambas
 * `v1.5-denominador-observados`, então a sonda devolvia a mesma string tendo o deploy do #1901
 * acontecido ou não. É exatamente o pré-flight `main`×prod que o `deploy.md` firmou em 765e984ba —
 * e a lição concreta é que o marcador cobre a fatia que o BUMPOU, não a janela de tempo: uma fatia
 * que entra DEPOIS do bump e ANTES do deploy volta a ser invisível.
 */
export const VERSAO = "v1.6-keyset-cursor-na-primeira-linha";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge roda o motor de recomendação do cliente (seis leituras paginadas: catálogo, custos, " +
  "histórico de compras, regras de associação e score) e GRAVA `recommendation_log` — o sensor de " +
  "desfecho que mede se a recomendação virou venda; uma linha inventada por sondagem entra no " +
  "denominador dessa medição e a enviesa";
