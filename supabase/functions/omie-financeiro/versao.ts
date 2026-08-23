// Marcador de versão da edge `omie-financeiro`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Escreve seis tabelas do financeiro no nosso banco — regra da terceira leva (#1767).
//
// Custo do bundle PRÉ-sensor ignorando `probe`: BAIXO, e isso é propriedade do desenho dela, não
// sorte. Ela roteia por `action`, e um corpo sem `action` conhecida cai no default `400 "Ação
// desconhecida"` ANTES de qualquer escrita ou chamada ao Omie — o mesmo formato inócuo que tornou
// barata a sonda da `omie-analytics-sync` (docs/historico/deploy-no-op-por-desenho.md). Logo o
// veredito é limpo dos dois lados:
//     {ok,probe:true,versao,edge}   → bundle COM sensor
//     400 "Ação desconhecida"       → bundle PRÉ-sensor, o deploy não subiu
//
// O gate normal é `validateCaller(req, supabase)`, que ACEITA `x-cron-secret` mas EXIGE o client —
// e o client nasce depois do ponto onde a sonda tem de responder. Por isso a sonda traz gate
// PRÓPRIO (`authorizeCronOrStaff`), antes do `createClient`, e a edge está em GATE_PROPRIO. Sem
// isso a alternativa seria descer a sonda para depois do client, que é exatamente o que o gate
// estrutural proíbe.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-financeiro");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge sincroniza o financeiro do Omie e escreve fin_contas_receber, fin_contas_pagar, " +
  "fin_movimentacoes, fin_categorias, fin_contas_correntes e fin_dre_snapshots — as tabelas que " +
  "alimentam DRE e fluxo de caixa; um run não pedido reescreve saldo e snapshot de DRE com a " +
  "janela de datas que ele resolver sozinho";
