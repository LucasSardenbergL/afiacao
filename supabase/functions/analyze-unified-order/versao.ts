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
//   canária ... `contrato: "praticado-vence-omie-v1"` nomeia a fatia do MERGE DE PREÇO, e prova
//               que o deploy não reverteu "order_items vence o Omie". O #1622 não toca esse
//               comportamento — a canária responde igual antes e depois dele.
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
 * Nasce nomeando a FATIA e não `v1.0-sensor-inicial` (mesma escolha da `generate-tactical-plan` e
 * da `generate-bundle-argument`): o primeiro deploy desta sonda carrega junto o #1622, cujo deploy
 * é justamente o que estava por provar quando ela foi escrita. Carimbar "sensor-inicial" apagaria a
 * informação pela qual o marcador existe — e é o erro que congelou a sonda da `generate-tactical-plan`
 * respondendo a mesma constante por várias fatias seguidas.
 */
export const VERSAO = "v1.0-prompt-invertido-cacheado";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge manda o CATÁLOGO INTEIRO de produtos e serviços para o modelo da Anthropic a cada " +
  "chamada (token pago, e o prefixo estável do #1622 só é cacheado a partir da segunda), e o " +
  "resultado é a lista de itens que o vendedor transforma em pedido — sondar por engano gasta " +
  "token e devolve uma análise de IA onde se esperava um diagnóstico de uma linha";
