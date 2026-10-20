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
export const VERSAO = "v1.2-situacao-cadastral";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge recebe a carga mensal do radar de mercado e GRAVA radar_ingest_state, os registros do mês e a" +
  " situação cadastral RFB (radar_situacao_cadastral), recruza quem já é cliente (radar_recruzar_ja_cliente)" +
  " e aplica a situação no finalize (radar_aplicar_situacao: descarta leads baixados e abre alerta ao gestor)";
