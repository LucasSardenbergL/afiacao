// Marcador de versão da edge `analyze-unified-order`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTA EDGE ENTROU, se ela NÃO escreve no nosso banco (as seis tabelas que toca —
// `omie_products`, `omie_servicos`, `order_items`, `orders`, `profiles`, `user_roles` — são todas
// leitura): pelo SEGUNDO motivo do #1520, "não existe caminho de prova". Ela é chamada pelo
// BROWSER, então não deixa rastro em `net._http_response` nem linha em `cron.job_run_details` — o
// par que torna uma edge de cron auditável de fora. Quando a pergunta "qual bundle está no ar?"
// não tem NENHUMA resposta possível, a sonda é o sensor, independentemente de o efeito ser
// reversível.
//
// O custo que a instrumentação paga foi medido, não suposto. Auditoria de 2026-08-23: o #1622
// (prompt invertido e cacheado) estava mergeado e SEM como se provar. A escada inteira morria —
// N1 só diz que a edge existe, e N2 é estruturalmente indisponível aqui (o Supabase é da org do
// Lovable). Sobrava um `console.log` que só existe no bundle novo, legível apenas no painel e só
// depois de alguém rodar uma análise de verdade.
//
// POR QUE A CANÁRIA DE PREÇO NÃO SUBSTITUI ISTO, mesmo depois de versionada. Quando esta sonda foi
// escrita, a canária (`canary:true`) era não-versionada e mentia verde; o d8cf07152 fechou esse
// buraco dando a ela um `contrato`. As duas continuam respondendo perguntas DIFERENTES, e é a
// diferença que justifica as duas coexistirem:
//
//   canária ... `contrato` nomeia o contrato de PREÇO (hoje `ia-nao-precifica-v1`: nenhum preço
//               sai da edge; até a v1.3, `praticado-vence-omie-v1`, o merge que saiu dela). O #1622
//               não tocou esse comportamento — a canária respondia igual antes e depois dele.
//   sonda ..... `versao` nomeia a fatia do PROMPT. É o que discrimina o #1622.
//
// E há a diferença de ALCANCE, que importa mais na prática: a canária vive DEPOIS do gate de staff
// (JWT + `user_roles`), então só o app logado a alcança — o `x-cron-secret` do SQL Editor não
// chega lá, apesar de o comentário dela citar o SQL Editor como invocador. A sonda responde antes
// desse gate, com gate próprio, e por isso é a única das duas que o founder consegue disparar sem
// abrir o app.
//
// GATE: a edge NÃO tem `authorizeCronOrStaff`. O gate dela é JWT de usuário + checagem de
// `user_roles` (employee/master), e o `startsWith("Bearer ")` do handler responde ANTES de
// qualquer outra coisa. Isso torna a sonda inalcançável pelo caminho documentado (SQL Editor via
// `net.http_post` com `x-cron-secret`), que é exatamente a armadilha que o #1882 consertou na
// `recommend`. Por isso a sonda responde ANTES desse gate, com gate PRÓPRIO — nenhum caminho fica
// sem auth, o fluxo real continua exigindo JWT staff, e o custo do modelo só é pago quando `probe`
// NÃO vem no corpo.
//
// EFEITO COLATERAL ÚTIL, e a razão de o gate próprio vir DEPOIS da classificação: as duas recusas
// passam a ter strings DISTINTAS. `{"probe":true}` sem `Authorization` cai em `unauthorized()` de
// `_shared/auth.ts` → `{"error":"Unauthorized"}` (inglês); qualquer outro corpo cai no gate do
// handler → `{"error":"Não autorizado"}` (português). O bundle ANTERIOR a este PR responde a
// segunda string nos DOIS casos, porque nele o `startsWith("Bearer ")` vem primeiro. Ou seja: esta
// edge passa a ser verificável por ASSINATURA DE GATE (`docs/agent/deploy.md`), sem credencial
// nenhuma e sem o SQL Editor — um `curl` anônimo distingue as versões.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("analyze-unified-order");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * Nasceu nomeando a FATIA e não `v1.0-sensor-inicial` (mesma escolha da `generate-tactical-plan` e
 * da `generate-bundle-argument`): o primeiro deploy desta sonda carrega junto o #1622, cujo deploy
 * é justamente o que estava por provar quando ela foi escrita. Carimbar "sensor-inicial" apagaria a
 * informação pela qual o marcador existe — e é o erro que congelou a sonda da `generate-tactical-plan`
 * respondendo a mesma constante por várias fatias seguidas.
 *
 * ⚠️ E foi EXATAMENTE nesse erro que esta sonda caiu na primeira oportunidade. `v1.0-…` ficou
 * congelado do #1930 (que o escreveu) até aqui, atravessando o #1938 sem bump: medida em prod em
 * 2026-08-25, a sonda respondeu `versao=v1.0-prompt-invertido-cacheado` (request_id 59657) — o que
 * prova "o bundle é ≥ #1930" e NADA MAIS. Se o #1938 subiu ou não, a resposta era byte-idêntica.
 * A regra que faltou não é "criar o marcador", é **bumpar ANTES do deploy**: marcador igual na
 * `main` e em prod responde a mesma string tendo o deploy acontecido ou não.
 *
 * `v1.1-corpo-tipado` nomeia a fatia desta entrega — o corpo da requisição anotado
 * (`CorpoRequisicao` no `index.ts`), que devolve ao TypeScript a visão do caminho inteiro do fluxo
 * real. Ela carrega junto, e passa a provar, o `!!searchCustomer` do #1938.
 *
 * `v1.2-b1-termo-degenerado` nomeia a fatia do B1 (varredura semgrep de 2026-09-27): o sanitizador do
 * `.or()` passou a espelhar o de `src/lib/postgrest.ts` (bloco `postgrest-or`, com o `*` que o #1051 pôs
 * só na fonte), e o termo só-de-metacaracteres (`***`) deixou de virar `name.ilike.%%` = 20 perfis
 * arbitrários como cliente sugerido.
 *
 * O gate que impede o retorno ao valor congelado: `_shared/sonda-versao-contrato_test.ts`,
 * "bump v1.1-corpo-tipado". Um `git revert` deste bump devolveria a sonda a "responde verde sem provar nada".
 * `v1.3-ia-nao-precifica`: a edge deixou de decidir preço (fronteira `montarRespostaAnalise`, canária
 * `ia-nao-precifica-v1`); v1.4 = hotfix do BOOT_ERROR. Por quê: docs/historico/ia-nao-precifica.md.
 * `v1.6-so-imagem-2-passos`: só-imagem transcreve a foto e ranqueia catálogo/perfis INTEIROS (transcricao.ts).
 */
export const VERSAO = "v1.6-so-imagem-2-passos";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge manda catálogo e serviços para o modelo da Anthropic (e, no modo só-imagem, faz DUAS " +
  "chamadas: transcrição e análise) a cada requisição (token pago, e o prefixo estável do #1622 só é cacheado a partir da segunda), e o " +
  "resultado é a lista de itens que o vendedor transforma em pedido — sondar por engano gasta " +
  "token e devolve uma análise de IA onde se esperava um diagnóstico de uma linha";
