// Marcador de versão da edge `fin-funding`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Leitura pura, sem escrita — e é NOMEADA na exceção da terceira leva (#1767), que a deixou sem
// sensor porque "chamá-la já é grátis". A exceção continua certa para o problema dela; ela não
// cobre o desta entrega. O #1889 é no-op por DESENHO (docs/historico/deploy-no-op-por-desenho.md):
// enquanto o `max-rows` de prod for 1000, bundle novo e velho devolvem os MESMOS bytes, então
// chamar a edge — de graça ou não — não diz qual dos dois está no ar. O marcador é a única prova
// possível, e por isso ela entra agora, apesar da exceção.
//
// O gate desta edge é `authorizeMaster` (Bearer + role master), que NÃO aceita `x-cron-secret`.
// A sonda entra com gate PRÓPRIO (`authorizeCronOrStaff`) antes do `createClient` — GATE_PROPRIO.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("fin-funding");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge projeta funding e antecipação lendo fin_contas_receber INTEIRA (~44 mil linhas em " +
  "prod); ela não escreve, mas devolve número que a gestão usa para decidir captação — e uma " +
  "leitura truncada não vira erro, vira número menor com a mesma cara de certo";
