// Marcador de versão da edge `enviar-pedido-portal-sayerlack`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito irreversível desta edge: ela SUBMETE o pedido no portal do fornecedor via Browserless —
// o fornecedor recebe de verdade, e não há desfazer. Depois disso ainda chama
// `disparar-pedidos-aprovados` para registrar o PO no Omie. Não existe caminho de diagnóstico
// barato sem a sonda.

export { classificarSonda, erroSondaAmbigua, respostaSonda } from "../_shared/sonda-versao.ts";

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge SUBMETE o pedido no portal do fornecedor (Browserless) — o fornecedor recebe de verdade";
