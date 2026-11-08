// Marcador de versão da edge `radar-ingest`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26, 3ª leva do Lote C (plano de melhorias): edge ATIVA com escrita e sem prova de deploy.
// Contexto: carga mensal do radar (CLI `scripts/radar/carga.ts`), por `action`. O gate
// próprio da edge (`autorizado`) aceita `x-cron-secret` ⇒ sem gate extra.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR: BARATA — `{"probe":true}` não tem `action` e cai no 400 de ação
// desconhecida antes de escrever.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("radar-ingest");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.7-carga-staging-atomica";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge recebe a carga mensal do radar de mercado e GRAVA radar_ingest_state, os registros do mês num" +
  " STAGING (radar_empresas_carga, via radar_carga_*; a foto vira vigente só na publicação atômica do job" +
  " radar-publicar-lote, que também recruza quem já é cliente) e a situação cadastral RFB (radar_situacao_cadastral);" +
  " o finalize só VALIDA a contagem; a situação (descarte de leads baixados e alerta ao gestor) é aplicada depois pelo job" +
  " radar-aplicar-situacao-diario, não por esta edge; e publica a camada de concorrentes do mapa" +
  " (radar_concorrentes_publicar, lote inteiro numa transação) e a camada de sócios PF com CPF mascarado" +
  " (radar_socios_*: manifesto, chunks, publicação por troca de ponteiro, limpeza)";
