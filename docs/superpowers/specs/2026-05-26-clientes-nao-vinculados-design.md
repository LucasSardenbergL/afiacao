# Clientes não-vinculados — design (v1 sob demanda)

> **Status: EM IMPLEMENTAÇÃO** (2026-05-27). O design corrigido (carona no `omie-analytics-sync`) virou plano de implementação em **`docs/superpowers/plans/2026-05-27-clientes-nao-vinculados-carona.md`** (incorpora 1 consult ao Codex sobre integridade de run, finalize transacional, trigger assíncrono e gate server-side) e está sendo construído na branch `feat/clientes-nao-vinculados`. O plano antigo `docs/superpowers/plans/2026-05-26-clientes-nao-vinculados.md` segue **SUPERSEDED** (era da abordagem standalone errada).

## ⚠️ Correção de design (descoberta no build, 2026-05-26)

Lendo `supabase/functions/omie-analytics-sync/index.ts` (linhas ~180-235):

1. **`omie-analytics-sync` JÁ enumera a lista completa de clientes de TODAS as contas Omie** (Oben/Colacor/Colacor SC), paginado (`ListarClientes`, `registros_por_pagina:100`, `apenas_importado_api:"N"`), num cron. Já resolve paginação + multi-conta + o padrão de chamada.
2. **Definição CORRETA de "não-vinculado":** o cliente Omie **não tem linha em `omie_clientes`** (lookup por `omie_codigo_cliente`) **E não tem `profile` com aquele `document` (CNPJ/CPF)**. O analytics-sync, quando acha um `profile` por documento, **cria** a linha em `omie_clientes` (linka); só quando NÃO acha profile é que o cliente é de fato não-vinculado — e hoje ele **pula** (não grava). É esse `else` que falta.
3. **Por que o standalone specado estava ERRADO:** diffar só contra `omie_clientes` contaria como "não-vinculado" todo cliente que **tem profile** mas ainda não ganhou a linha de `omie_clientes` → **relatório enganoso** (exatamente o risco do Codex). Além disso, `empresa_omie` **não é setado** nesses upserts → filtro por empresa era frágil.

**Design correto (pra sessão fresca) = pegar carona no `omie-analytics-sync`:** no laço que já enumera os clientes, no ramo `if (!mapping)` → `if (profile) {…linka…} else {…GRAVA como não-vinculado no snapshot…}`. Reusa a enumeração provada + a definição certa de vinculado. Trade-offs: (a) edita um sync grande/quente (zona de colisão — coordenar), (b) refresh passa a ser **no cron do analytics-sync** (não sob demanda — a premissa "sob demanda" cai; aceitável, ou expor um trigger manual que chama a mesma rotina). Bem menos código novo de ERP que o standalone.

**Reusável do que foi feito:** a ideia da tabela snapshot (master/gestor read via `pode_ver_carteira_completa`). **NÃO reusável:** o helper `computeNaoVinculados` standalone (definição incompleta de "vinculado") e a tabela de `runs`/cursor (o analytics-sync tem o próprio laço) — removidos desta branch.

---
### (Design standalone original — ABANDONADO, mantido só como histórico)

## Problema

Clientes que existem no **Omie** mas **não têm conta no app** são **invisíveis** pro vendedor (não aparecem em carteira/positivação/cross-sell) = venda perdida. Hoje a tabela `omie_clientes` é só de **vínculo** (`user_id NOT NULL` + `omie_codigo_cliente`) — os não-vinculados não estão em lugar nenhum local; só existem na API do Omie.

## Objetivo (v1)

Relatório **sob demanda** dos clientes Omie sem conta no app, pra master/gestor agir (convidar/criar conta). Uma edge function enumera a lista completa do Omie, diffa contra `omie_clientes`, e grava um snapshot que a UI mostra.

## Decisões cravadas (founder + Claude/Codex)

| Decisão | Escolha |
| --- | --- |
| Trigger | **Sob demanda** (master clica "Atualizar"); **sem cron** no v1 |
| Audiência | **master/gestor** veem todos os não-vinculados (com coluna de vendedor) |
| Escopo de empresa | **Oben** (a distribuidora com carteira/vendedores) |
| Persistência | snapshot table `omie_clientes_nao_vinculados` |
| Per-vendedor (cada um vê só os seus) | **v2** — exige mapear `user → omie_codigo_vendedor`, hoje não-limpo |
| Cron automático | **v2** |

## ⚠️ Não-negociáveis do v1 (revisão Codex — o que rushar quebra)

1. **Cursor de continuação (resumável).** NÃO apostar num único invoke pra 70-100 páginas do Omie (cap 100/página, ~7-10k clientes Oben, budget de edge ~130-150s). A enumeração é um **batch resumável**: cursor de página + estado parcial + chunks retryáveis + `completed_at` final.
2. **Rate-limit/backoff.** Backoff, stop/resume, e **estado de falha visível**. Nunca um relatório parcial que **parece completo**.
3. **Integridade do snapshot.** `run_id`/generation por execução — **nunca misturar páginas de runs diferentes** como se fossem um dataset completo. A UI lê o último run COMPLETO.
4. **Normalização do diff.** `omie_codigo_cliente` normalizado **igual nos dois lados** (tipo/numérico) — vínculo vs Omie.
5. **Auth server-verified.** O trigger valida **master/gestor no servidor** (não só na UI).
6. **Observabilidade.** Gravar contagens: total Omie buscado, vinculados batidos, não-vinculados, páginas, status/erro. Sem isso o suporte fica cego.
7. **Honestidade de UX.** A tela mostra **frescor** (`refreshed_at`) e estados **incompleto/falhou** claramente.

## Arquitetura (a detalhar no plano)

1. **Edge function `omie-clientes-nao-vinculados`** — gated master/gestor (JWT, server-side). Modos: `start` (novo run_id, página 1) e `continue` (avança o cursor). Enumera `ListarClientes` (geral/clientes/, reusa auth/credenciais do `omie-sync`), pagina, e por página marca os `omie_codigo_cliente` ausentes de `omie_clientes` como não-vinculados do run. Backoff em rate-limit. Grava progresso + contagens; seta `completed_at` no fim.
2. **Migration** — `omie_clientes_nao_vinculados` (run_id, omie_codigo_cliente, razao_social, nome_fantasia, codigo_vendedor, cidade, uf, empresa, created_at) + tabela/colunas de **run state** (run_id, status, next_page, totais, started_at, completed_at, error) + RLS read master/gestor. Edge escreve via service_role.
3. **UI** — relatório (`/admin/clientes-nao-vinculados` ou Gestão): lista do último run completo + `refreshed_at` + botão "Atualizar" (dispara start/continue até completar; mostra progresso) + estados incompleto/falhou. Hook de leitura + mutation de trigger.
4. **Helper puro TDD** — `computeNaoVinculados(omieClientsPagina, linkedCodigosSet)` (diff por página, normalização de codigo). A enumeração/cursor é integração.

## Não-objetivos v1

Cron automático; filtro por-vendedor; enriquecimento (última compra/valor — exigiria mais chamadas Omie).

## Rollout (mais pesado que C/D)

Migration (SQL Editor) **+ deploy de edge function via chat do Lovable** + front. Sem `VITE_*` novo (credenciais Omie reusadas do `omie-sync`).

## Por que deferido

Tudo até aqui nesta sessão foi DB/front/RPC. B é o primeiro a **bater na API de produção do Omie com código novo** + persistir + agendar trigger. Codex: *"single-invoke ERP enumeration is the first real batch job in this run and rushing it is how you ship a misleading sales report."* Sessão nova, cabeça fresca, começando no `writing-plans` com este spec.
