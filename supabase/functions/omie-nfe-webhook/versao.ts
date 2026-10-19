// Marcador de versão da edge `omie-nfe-webhook`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: ela MATERIALIZA o recebimento no nosso banco — `insert` em
// `nfe_recebimentos` (cabeçalho) e depois em `nfe_recebimento_itens`. É a porta de entrada do
// chão de fábrica: a partir daqui a NF-e aparece para conferência e vira candidata à efetivação
// no Omie pela `omie-nfe-recebimento`.
//
// As duas inserções NÃO são transacionais (PostgREST: transação por requisição) — mas desde a
// v1.3 o guard de duplicata lê `id, status, count(itens)` e COMPLETA um cabeçalho `pendente` que
// ficou sem itens (e sem sinal de uso): o reenvio do Omie conserta a importação que morreu no meio,
// em vez de escondê-la. Itens têm `id` determinístico (cabeçalho+sequência+posição), então dois
// envios simultâneos não produzem 2N: o 2º lote colide na PK. Ver importacao.ts.
// v1.3.1: `normalizarNcm` vem de `_shared/ncm.ts` — a v1.3 importava da pasta da sync e o bundle de
// deploy do Lovable (só a pasta da função + `_shared/`) a recusou com `Module not found`.
//
// ⚠️ O gate desta edge é `x-webhook-secret` (segredo compartilhado com o Omie, que não emite
// JWT) — ele NÃO aceita `x-cron-secret`, que é como o founder invoca a sonda pelo SQL Editor.
// Daí o gate próprio da sonda no `index.ts`; ver o comentário lá.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-nfe-webhook");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.3.1-ncm-em-shared";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge INSERE o recebimento no nosso banco (nfe_recebimentos + nfe_recebimento_itens) e o " +
  "torna visível para conferência e efetivação — as duas inserções não são transacionais; se os " +
  "itens falharem, o cabeçalho fica `pendente` sem itens até o reenvio do webhook completá-los";
