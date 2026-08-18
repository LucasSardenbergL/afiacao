// Marcador de versão da edge `process-nfe`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito irreversível desta edge: é a GÊMEA da `omie-nfe-recebimento` — roda a mesma tríade de
// efetivação no Omie (`AlterarRecebimento` → `AlterarEtapaRecebimento` `cEtapa:"40"` →
// `ConcluirRecebimento`), com entrada de estoque e lançamento fiscal no ERP.
//
// ⚠️ Ela NÃO tem modo de teste nenhum — nem `dry_run`, nem `diagnostico`, nem simulação: quem
// chama com um `nf_number` válido efetiva a nota. Verificado no código, não no comentário
// (`docs/agent/deploy.md`: comentário que promete caminho seguro inexistente já mordeu 2×).
// Antes desta sonda não havia NENHUMA forma de perguntar qual bundle estava no ar.

export { classificarSonda, erroSondaAmbigua, respostaSonda } from "../_shared/sonda-versao.ts";

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge EFETIVA a NF-e no Omie (AlterarRecebimento + AlterarEtapaRecebimento etapa 40 + " +
  "ConcluirRecebimento), dando entrada de estoque e fiscal no ERP — e não existe dry_run nem " +
  "modo de simulação neste código";
