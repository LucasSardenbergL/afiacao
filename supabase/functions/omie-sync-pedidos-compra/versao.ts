// Marcador de versão da edge `omie-sync-pedidos-compra`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTA EDGE GANHOU SONDA (2026-08-27): ela é o 1º dos 5 steps do `omie-cron-diario` e era
// INVERIFICÁVEL quanto a deploy — sem `versao.ts`, sem `{"probe":true}` e com um corpo de resposta
// byte-idêntico antes e depois de uma fatia. Verificar o #2031 (a coleira de RELÓGIO no `omieCall`
// dos 5 steps) travou nisso: só o 5º step (`omie-sync-nfes-recebidas`, que já tinha sensor) se
// provou; os outros quatro ficaram como INFERÊNCIA. E o sintoma que a coleira corrige — request
// pendurado — é indistinguível de "o Omie estava lento" quando não se sabe qual bundle está no ar.
//
// Efeito desta edge: ela é a FONTE do espelho de pedidos de compra. Escreve
// `purchase_orders_tracking` (o que a reposição lê como on-order), avança o heartbeat de
// `sync_state` — o marcador de frescor que o Sentinela consulta — e publica o run completo via
// `reposicao_publicar_run_completo`/`reposicao_alocar_run_seq`. Um run supérfluo mexe nos três.
//
// ⚠️ SONDAR UM BUNDLE PRÉ-SENSOR AQUI É CARO. Esta edge não roteia por `action`: um corpo
// desconhecido cai nos defaults (`empresa:"ALL"`, `dias:30`, modo auto) e a varredura roda inteira
// — medida em ~90s no incremental e ~185s no completo. Só sonde DEPOIS de confirmar o deploy — ou
// leia o marcador pelo caminho PASSIVO abaixo, que não custa chamada nenhuma.
//
// O CAMINHO PASSIVO é a metade que dispensa invocação: o `jsonRes` do `index.ts` anexa
// `versao: VERSAO` a TODA resposta, não só à da sonda. O `omie-cron-diario` faz `JSON.parse` do
// corpo de cada step e o devolve inteiro em `resultados.pedidos.body`, então a resposta que o
// jobid 52 já grava em `net._http_response` a cada 2h carrega o marcador — prova de versão sem
// invocar nada (N3 PASSIVO da skill `lovable-deploy-verify`).
// ⚠️ Leia o `modo` ANTES do `versao`: em `modo:"background"` (o orquestrador aborta o cliente em
// 25s pelo `STEP_TIMEOUT_MS`, e ESTE step é o que mais estoura, por ser síncrono de propósito) o
// corpo NÃO foi coletado e `versao` sai vazio — linha INUTILIZÁVEL, não "marcador velho".
//
// O gate desta edge é um `authorizeCronOrStaff` INLINE, e ele JÁ aceita `x-cron-secret`: a sonda
// entra logo APÓS ele, sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-sync-pedidos-compra");

/**
 * A identidade desta edge, para o ECO carregá-la junto do `versao`.
 *
 * Achado do `/codex` sobre o #2063: o eco anexava só `versao`, e as 4 edges da leva nasceram no
 * MESMO marcador — logo o eco não dizia QUEM respondeu. A identidade vinha da CHAVE que o
 * `omie-cron-diario` escolhe (`resultados.ctes`), ou seja, era confiada ao PAI: um pai com step
 * trocado põe a string certa sob a chave errada, e o gate que fixa `key`↔edge protege a `main`, não
 * o bundle do pai em PRODUÇÃO. É o mesmo furo que o campo `edge` de `criarRespostaSonda` já fechava
 * na SONDA — o eco tinha replicado metade do desenho (`verificar-sonda-versao.md` §7: 10 sondas com
 * corpos byte a byte idênticos e nenhum veredito por edge possível).
 */
export const EDGE = "omie-sync-pedidos-compra";

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * O marcador NOMEIA a fatia em vez de dizer `v1.0-sensor-inicial`: o que entra aqui não é só o
 * sensor, é o sensor MAIS o eco passivo de `versao` em toda resposta — a metade que faz o deploy
 * se provar pelo tick do cron, sem ninguém chamar nada.
 */
export const VERSAO = "v1.1-eco-identidade-fonte";

/**
 * O fingerprint da FONTE, para o ECO carregá-lo também — não só a sonda.
 *
 * Fecha o último furo do caminho passivo: fatia que chegue INTEIRA por `_shared/` não move o
 * `VERSAO` (o `sonda:bump` exclui `_shared/` por medição, ~12 bumps à mão por PR), então o eco
 * responderia idêntico nos dois bundles. O `fonte` é derivado do fecho transitivo dos imports —
 * `_shared/` incluso — e o CI o regrava, logo não depende de disciplina nenhuma.
 *
 * Sai de `respostaSonda` em vez de reimportar o mapa: UM lugar decide o que a edge serve como
 * identidade, e o `?? "nao-mapeada"` de `criarRespostaSonda` (auto-denunciante) vale para os dois
 * caminhos sem ser reescrito aqui.
 */
export const FONTE = respostaSonda(VERSAO).fonte;

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge reescreve o espelho de pedidos de compra em purchase_orders_tracking — o on-order que " +
  "o motor de reposição usa para decidir o que comprar —, avança o heartbeat de sync_state que o " +
  "Sentinela lê como frescor e publica o run via reposicao_publicar_run_completo; a varredura " +
  "completa no Omie leva ~185s";
