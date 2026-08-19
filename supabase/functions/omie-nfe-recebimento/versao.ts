// Marcador de versão da edge `omie-nfe-recebimento`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito irreversível desta edge: ela EFETIVA a NF-e no Omie em três passos encadeados —
// `AlterarRecebimento` (reescreve as quantidades dos itens), `AlterarEtapaRecebimento` com
// `cEtapa: "40"` e `ConcluirRecebimento`. O resultado é entrada de estoque e lançamento fiscal
// no ERP, não um registro nosso: desfazer é trabalho manual do escritório contábil. No caminho
// ela ainda toma o lock (`claim_nfe_efetivacao_lock`) e consome uma `efetivacao_tentativas`.
//
// ⚠️ O modo `{"diagnostico":true}` desta edge é read-only DE VERDADE (confirmado no código: só
// lê `nfe_recebimentos` + `ConsultarRecebimento` e retorna) — mas ele não responde "qual bundle
// está no ar", e custa 1 chamada ao Omie. A sonda responde isso sem tocar em nada.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-nfe-recebimento");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge EFETIVA a NF-e no Omie (AlterarRecebimento + AlterarEtapaRecebimento etapa 40 + " +
  "ConcluirRecebimento) — dá entrada de estoque e fiscal no ERP, toma o lock de efetivação e " +
  "queima uma tentativa";
