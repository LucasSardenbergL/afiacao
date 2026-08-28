// Marcador de versão da edge `omie-vendas-sync`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTA EDGE GANHOU SONDA (2026-08-25) — ela era a ÚLTIMA das 6 canárias do repo cuja
// única prova de deploy era o `contrato`, e a auditoria do #2009 a nomeou como o caso restante:
//
//   • NÃO tinha `versao.ts` ⇒ ficava fora do `sonda:bump` (#1993) e do `sonda:fingerprint`
//     (#1998), que só varrem edge instrumentada;
//   • por tabela, era a única entrada de `VERIFICAVEL_POR_CANARIA` — a dispensa explícita que o
//     gate "nenhuma edge que serve o paginate.ts fica SEM prova de deploy" concede a quem tem
//     canária. A dispensa registrava a canária como prova; não dava discriminador de BUNDLE.
//
// O que faltava, em uma frase: o `contrato` é aceso à mão, então uma fatia que mude comportamento
// sem que alguém lembre de bumpá-lo responde a MESMA string. O `fonte` (fingerprint da fonte,
// #1998, servido por `criarRespostaSonda`) não depende de disciplina nenhuma — é ele que separa
// "respondeu" de "é o bundle que eu deployei", e é o que esta fatia instala.
//
// A CANÁRIA NÃO É SUBSTITUÍDA — mesma divisão de papéis que o #2009 assentou na `carteira-rebuild`:
// o `contrato` (`identidade-a2-client-to-user-v3`) nomeia a fatia que a FIXTURE verifica e pode
// ficar estável de forma legítima; o `VERSAO` prova QUAL BUNDLE está no ar e muda a cada fatia.
// Aqui os dois viajam JUNTOS na resposta da canária (o `identidade_probe` passa a ecoar `versao`),
// que é o desenho da `generate-tactical-plan`: quem verifica a canária lê o discriminador de
// bundle no mesmo lugar, sem uma segunda chamada — ressalva medida no #2026: isso vale para fatia
// EDGE-LOCAL. Mudança só em `_shared/` não bumpa `versao` nem `contrato` (e o `fonte`, que bumpa, não
// viaja na canária) ⇒ aí a verificação exige as DUAS chamadas. Detalhe em `docs/agent/deploy.md`.
//
// ⚠️ Substituir o `contrato` pelo `versao` NÃO era opção: o gate money-path
// (`src/__tests__/edge-money-path-invariants.test.ts`) exige a emissão literal do `contrato` E que
// a linha da tabela de `docs/agent/deploy.md` fixe o MESMO marcador, e a receita SQL documentada lê
// `canary`/`probe_no_ar`. Trocar quebraria os três — por isso o `versao` ACRESCENTA.
//
// ⚠️ SONDAR UM BUNDLE PRÉ-SENSOR AQUI É BARATO, ao contrário da `carteira-rebuild` — e a diferença
// é o roteamento: esta edge despacha por `action` e o `default` do switch faz
// `throw new Error("Ação desconhecida")`. Um bundle sem a sonda recebe `{probe:true}`, não acha
// `action`, e RECUSA — não dispara fluxo real nenhum. Mesma propriedade da `omie-analytics-sync`.
//
// O gate desta edge é o `authorizeCronOrStaff` de `_shared/auth.ts`, que JÁ aceita `x-cron-secret`:
// a sonda entra logo APÓS ele, sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-vendas-sync");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * `v1.0-sensor-inicial` é HONESTO aqui: o sensor de VERSÃO nasce nesta fatia. A canária
 * pré-existente não muda isso — ela é sensor de COMPORTAMENTO, e a regra 1 de `deploy.md`
 * ("`v1.0-sensor-inicial` só é honesto quando o sensor NASCE ali") fala do marcador que está
 * nascendo, não de haver outro sensor na edge. Mesmo precedente da `omie-analytics-sync` e da
 * `carteira-rebuild`, que também tinham canária quando ganharam a sonda.
 */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge escreve NO OMIE, fora do nosso banco e sem desfazer: `criar_pedido`, `alterar_pedido` " +
  "e `excluir_pedido` mexem no pedido de venda real, `criar_cliente` cria cadastro e " +
  "`criar_ordem_producao`/`finalizar_ordem_producao` movem ordem de produção; as actions de sync " +
  "(`sync_products`, `sync_estoque`, `sync_pedidos`) reescrevem o espelho que alimenta preço e " +
  "estoque na tela de venda";
