# Clientes não-vinculados — design (v1 sob demanda)

> **Status: DESIGN PRONTO — DEFERIDO pra uma sessão nova.** Decisão Claude + Codex (2026-05-26): não construir no fim de uma sessão-maratona. É o **primeiro batch job de ERP de verdade** do programa (enumeração paginada do Omie + snapshot persistido + trigger privilegiado + deploy de edge function) — merece cabeça descansada. O brainstorm já está fechado; uma sessão nova começa direto no `writing-plans`.

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
