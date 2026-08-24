// Marcador de versão da edge `omie-sync-status-produtos`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Oitava leva (#1889/#1901, paginação): uma das 7 edges dependentes do `_shared/paginate.ts` sem
// sensor nenhum. O #1889 é no-op por DESENHO enquanto o `max-rows` de prod for 1000, então só o
// marcador prova o deploy (`docs/historico/deploy-no-op-por-desenho.md`).
//
// CUSTO DO BUNDLE VELHO IGNORANDO `probe`: ALTO. O gate (`authorizeCronOrStaff`) aceita o
// `x-cron-secret` do SQL Editor, e o corpo é lido só à procura de `empresa` — `probe` é ignorado e
// `resolverEmpresas(null)` devolve `["OBEN"]`, o caminho padrão do cron. O bundle pré-sensor,
// portanto, PAGINA O CATÁLOGO DO OMIE INTEIRO (~25–40 s) e reescreve `sku_status_omie` e o flag
// `ativo` de `omie_products`. Sondar às cegas aqui não é diagnóstico, é um sync. Confirme o deploy
// por outro meio antes.
//
// A sonda vem DEPOIS do gate (que já aceita cron-secret, por comparação de env pura) e ANTES do
// client. ⚠️ Aqui o client nasce de `makeClient()`, uma fábrica de topo de arquivo — o `createClient(`
// literal não aparece no handler. O gate estrutural de FORMA sabe disso por uma âncora declarada
// (`ANCORA_CLIENT` em `_shared/sonda-versao-contrato_test.ts`); renomear a fábrica sem atualizar lá
// deixa o gate VERMELHO por âncora ausente, que é o desfecho certo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-sync-status-produtos");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge pagina o catálogo do Omie e reescreve sku_status_omie (upsert por empresa+sku) e o " +
  "flag ativo de omie_products — o par que o motor de reposição usa para decidir o que ainda pode " +
  "ser comprado; um run não pedido inativa/reativa SKU em massa a partir da leitura do momento, e " +
  "um run parcial deixa metade do catálogo com o status da leitura anterior";
