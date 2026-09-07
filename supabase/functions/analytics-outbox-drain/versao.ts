// Marcador de versão da edge `analytics-outbox-drain`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ELA CHEGOU SEM SENSOR — e o que a omissão custou (medido 2026-08-28): a edge nasceu no
// #2035 (d5d79cf11) já DEPOIS de o padrão existir, e mesmo assim ficou fora dele. Sem `versao.ts`
// ela não entra no `sonda:bump`, não entra no mapa de `_shared/sonda-fingerprints.ts`,
// `bun run sonda:sql analytics-outbox-drain` RECUSA ("Edge não sondável — sem sensor"), e ela some
// das edges de `bun run pendencias:deploy` — cujo denominador sai do MAPA commitado, então edge
// fora do mapa não aparece nem como pendência. Não é que ela reprovasse: ela sumia do radar.
//
// Verificar o deploy dela exigiu um caminho AD-HOC: N1 (`verify-edge.sh`, OPTIONS 200 + controle
// negativo em 404) somado ao N3 passivo lendo `net._http_response`, onde o corpo trazia uma string
// literal exclusiva do `index.ts`. Funcionou por ACASO — a edge respondia 500 com uma mensagem
// distintiva. É a §12 de `docs/historico/verificar-sonda-versao.md` (N3 passivo pela FORMA do JSON)
// com a pré-condição dela satisfeita por sorte, não por desenho: a §13.1 já registra que a forma só
// discrimina se o diff MUDA a forma, e uma fatia futura interna a esta edge não mudaria nada.
//
// EFEITO de um `probe` mal grafado num bundle PRÉ-sensor: ele ignora o parâmetro e roda `drenar()`
// — claim de até `TETO_EVENTOS_POR_LOTE = 200` linhas da `analytics_outbox` (`FOR UPDATE SKIP
// LOCKED`, com o backoff aplicado NO claim), envio ao PostHog, e marcação do desfecho. Evento
// entregue não se retira, e o desfecho de rejeição definitiva (400/401/403/413) põe as linhas em
// QUARENTENA, que PARA de tentar. Ele também grava execução no slug `analytics_outbox.drenar` via
// `comRegistro`, então a sonda às cegas mente no `<UltimaExecucao>` da tela.
//
// ⚠️ A leitura HONESTA desse custo é comparativa, e é ela que define de que lado esta edge cai: o
// cron `analytics-outbox-drain` (`*/5 * * * *`) chama exatamente este caminho a cada 5 minutos, com
// os MESMOS defaults. Sondar o bundle velho aqui ADIANTA um tick — não cria efeito de classe nova.
// Isso a põe ao lado da `omie-analytics-sync` (sondar é barato) e não da `carteira-rebuild`
// (sondar é catastrófico). O que a sonda resolve nesta edge não é risco de efeito colateral: é a
// ausência de DISCRIMINADOR — "qual bundle está no ar?" não tinha resposta nenhuma.
//
// O gate desta edge é o `authorizeCronOrStaff` de `_shared/auth.ts`, que JÁ aceita `x-cron-secret`:
// a sonda entra logo APÓS ele, sem gate próprio — daí ela ficar fora de `GATE_PROPRIO` no contrato.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("analytics-outbox-drain");

/** Nome do diretório da function — o `edge` que o ECO carrega. */
export const EDGE = "analytics-outbox-drain";

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.1-guard-dentro-do-registro";

/**
 * O fingerprint da FONTE, para o ECO carregá-lo também — não só a sonda.
 *
 * Derivado de `respostaSonda`, nunca transcrito: o CI regrava o mapa a cada mudança de `_shared/`,
 * e um hash copiado à mão congelaria e passaria a mentir na primeira fatia que chegasse por lá —
 * exatamente o furo que este campo existe para fechar.
 */
export const FONTE = respostaSonda(VERSAO).fonte;

/**
 * O ECO em TODA resposta — e por que esta edge o merece ainda mais que as cinco que o estrearam.
 *
 * Os 5 steps do `omie-cron-diario` (#2063) ecoam `versao/edge/fonte` porque o ORQUESTRADOR grava o
 * corpo deles em `net._http_response` no tick de 2h: prova de deploy sem chamar nada, sem cron
 * secret e sem pagar efeito. Aqui não há orquestrador — o cron `analytics-outbox-drain` faz
 * `net.http_post` DIRETO nesta edge a cada 5 minutos (`timeout_milliseconds := 55000` explícito),
 * então o corpo que cai em `net._http_response` é o desta função, sem intermediário e sem depender
 * da chave que um pai escolheu. Dentro da janela de ~6 h do `pg_net.ttl` sempre há ~72 amostras:
 * é o N3 passivo mais barato do repo, e é o que garante que a PRÓXIMA fatia desta edge se prove
 * sozinha, sem repetir a arqueologia ad-hoc de 2026-08-28.
 */

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge reivindica até 200 linhas da analytics_outbox (FOR UPDATE SKIP LOCKED, backoff " +
  "aplicado no claim) e as ENVIA ao PostHog — evento entregue não se retira, e a rejeição " +
  "definitiva (400/401/403/413) põe as linhas em QUARENTENA, que para de tentar; ela também grava " +
  "execução no slug analytics_outbox.drenar, então um disparo acidental mente no <UltimaExecucao>. " +
  "O custo é o de ADIANTAR um tick do cron */5, não o de uma operação de classe nova";
