// Marcador de versão da edge `omie-os-sync`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: LÊ o Omie da Colacor SC (`servicos/os/ListarOS`, só leitura) e GRAVA o espelho das OS em
// `omie_os_espelho` (via RPCs omie_os_sync_*), que alimenta a sombra de crédito das OS (crédito-IA PR 7, opção C).
// Nunca escreve no Omie. A sonda responde antes de tudo; o `action:"probe"` (forma do payload) e o `sync` são só
// do cron/service_role (Codex P0: um employee sem acesso financeiro à SC não pode ver OS real).

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-os-sync");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 * O CHANGELOG de cada versão vive em `docs/historico/versao-omie-os-sync.md`.
 */
export const VERSAO = "v1.0-espelho-os-colacor-sc";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge consulta o Omie da Colacor SC (ListarOS, só leitura) e GRAVA o espelho das ordens de serviço no app " +
  "(omie_os_espelho), base da sombra de crédito das OS; não cria nem altera nada no Omie";
