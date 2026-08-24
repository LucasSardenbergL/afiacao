// Marcador de versão da edge `omie-cliente`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge — e é o mais caro das cinco desta leva, por um motivo que não é volume:
// no `sync_all_clients`/`criar_perfil_local` ela CRIA usuário em `auth.users` com e-mail
// `omie_<codigo>@placeholder.local` (`auth.admin.createUser`) e, na sequência, INSERE o
// `profiles` dele — além de `insert`/`update` em `addresses`. (`user_roles` e
// `omie_customer_account_map` ela só LÊ; verificado no código, não deduzido do nome.)
//
// ⚠️ POR QUE ISSO É FRONTEIRA, NÃO NÚMERO: a AUSÊNCIA de `profiles` é o discriminante que separa
// os ~1.633 aliases fiscais `@placeholder.local` (cadastros Omie legítimos do grupo — Colacor SC
// em `servicos` e Oben em `vendas`, CNPJs distintos por vantagem fiscal) do que seria lixo de
// import. Ver CLAUDE.md §Armadilhas e `docs/agent/database.md` §5. Um run de bundle errado que
// crie `profiles` sobre essa população não erra um total: apaga a fronteira que distingue as duas
// coisas — e desfazer não é opção, porque deleção ad-hoc em `auth.users` tem CASCADE de só 14
// tabelas (pedidos/endereços/scores sobram como uuid pendurado).
//
// ⚠️ Gate: esta edge NÃO tem um gate único. Ele é POR AÇÃO dentro do switch —
// `buscar_por_documento` é PÚBLICA (fluxo de pré-cadastro, só rate-limit por IP), as demais
// exigem JWT, e sete delas exigem staff. Nenhum desses caminhos aceita `x-cron-secret`, que é
// como o founder invoca a sonda pelo SQL Editor. Por isso a sonda tem gate PRÓPRIO
// (`authorizeCronOrStaff`) e responde antes do dispatch; ver o comentário no `index.ts`.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-cliente");

/**
 * BUMP #1889/#1901 (paginação). O marcador anterior era `v1.0-sensor-inicial` — a MESMA string que já
 * respondia em produção. Marcador igual dos dois lados responde idêntico tendo o deploy acontecido
 * ou não, e o #1889 é no-op por DESENHO (enquanto o `max-rows` de prod for 1000, bundle novo e
 * velho devolvem os mesmos bytes), então NENHUMA canária de comportamento consegue discriminar
 * este deploy. O bump é PRÉ-REQUISITO da viagem, não consequência dela.
 * → `docs/historico/deploy-no-op-por-desenho.md`
 *
 * `v1.1-paginacao-eof-e-cursor` nomeia os dois fixes que esta fatia carrega até a edge: EOF por
 * página VAZIA (não mais página curta, #1889) e cursor comparado à PRIMEIRA linha da página
 * (#1901). Nenhum bundle anterior a esta fatia pode responder esta string.
 */
export const VERSAO = "v1.1-paginacao-eof-e-cursor";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge CRIA usuário em auth.users (omie_<codigo>@placeholder.local) e INSERE o profiles " +
  "dele, além de escrever addresses — e a ausência de profiles é justamente o discriminante dos " +
  "~1.633 aliases fiscais, então um run errado apaga essa fronteira em vez de errar um número; " +
  "deleção ad-hoc em auth.users não desfaz (CASCADE cobre só 14 tabelas)";
