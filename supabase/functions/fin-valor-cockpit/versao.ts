// Marcador de versão da edge `fin-valor-cockpit`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Esta edge NÃO escreve: é o cockpit de valor, leitura pura. A terceira leva (#1767) deixou a
// leitura pura de fora DE PROPÓSITO, com o argumento registrado no gate de contrato — "chamá-la já
// é grátis, então a sonda não resolve problema que ela tenha". Esse argumento resolve o problema
// que ELE tinha (efeito colateral caro), e não é o problema desta entrega: o #1889 é no-op por
// DESENHO nos dados de hoje (docs/historico/deploy-no-op-por-desenho.md), então chamar a edge e ler
// a resposta NÃO discrimina bundle novo de velho — os dois devolvem bytes idênticos enquanto o
// `max-rows` de prod for 1000. Grátis de chamar e possível de verificar são propriedades
// diferentes; a exceção da terceira leva garante a primeira e é MUDA sobre a segunda.
//
// "Grátis" também é generoso: são 9 leituras COMPLETAS por chamada, a maior delas `order_items`
// (~67 mil linhas em prod) — a maior varredura de qualquer edge deste recorte.
//
// O gate desta edge é `authorizeGestorOuMaster` (Bearer + role comercial), que NÃO aceita
// `x-cron-secret` — que é como o founder invoca do SQL Editor. Por isso a sonda entra com gate
// PRÓPRIO (`authorizeCronOrStaff`), antes do `createClient`, e a edge está em GATE_PROPRIO.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("fin-valor-cockpit");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
//
// Nasce em `v1.0-sensor-inicial` como a leva anterior, e aqui o discriminante do deploy é a
// EXISTÊNCIA da resposta, não o valor dela: um bundle sem esta sonda IGNORA `probe` e executa o
// cockpit inteiro, devolvendo o payload do fluxo real — sem `probe:true`. O veredito é binário
// mesmo com as cinco edges desta leva nascendo na mesma string (o campo `edge` da resposta desfaz
// o empate entre elas; ver `criarRespostaSonda`).
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge monta o cockpit de valor com 9 leituras COMPLETAS do banco — entre elas order_items " +
  "(~67 mil linhas), fin_contas_receber (~44 mil) e sales_orders (~31 mil); ela não escreve nada, " +
  "mas cada chamada paga a varredura inteira e concorre com a carga de produção";
