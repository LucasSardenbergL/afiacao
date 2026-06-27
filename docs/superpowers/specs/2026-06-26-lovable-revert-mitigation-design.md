# Mitigação do padrão de reversão do Lovable — design

**Data:** 2026-06-26 · **Escopo:** governança de deploy / CI · **Origem:** follow-up das regressões #1076/#1077/#1079 — o bot do Lovable reverte correções na `main` sem CI. Decisão Claude + Codex (consult `019f05a0`, incorporado).

## 1. Problema

O bot `gpt-engineer-app[bot]` do Lovable commita **direto na `main`** (mensagens "Changes" / "Deployed main branch version" / "Deployou edge X"), **sem PR/CI**. Esses commits revertem correções feitas via PR. Medido: **~48 de 300 commits (~16%)**; **≥4-5 reversões money-path** recentes (#1072, #1076, #1077→restaurado por #1080, #1079-types→#1085→aparentemente revertido de novo→#1086). Três classes de dano:

- **(a) Quebra build/typecheck** → o CI da `main` fica vermelho, mas **ninguém é alertado** → passa **SILENCIOSO** (ex.: `types.ts` stale do #1079, só pego por acaso).
- **(b) Compila mas regride comportamento money-path** → passa typecheck/test; só pega se houver teste específico (ex.: janela on-order voltando a "hoje" → "a caminho" subestimado → compra dupla).
- **(c) Toca arquivo sensível com CI verde e sem guardrail ainda** → invisível até virar sintoma operacional. (Codex: o caso do meio que as outras camadas não cobrem.)

## 2. Restrições (definem a estratégia)

- O bot commita **direto na `main`** → branch protection / bloqueio por CI é **inviável** (o bot precisa de escrita direta). **Prevenção pura é impossível.**
- **Não controlamos o interno do Lovable** (não dá pra forçar o bot a dar `pull` antes de commitar).
- → Estratégia (Codex): **aceitar que o Lovable reverte; transformar cada commit do bot em evento suspeito observável; e proteger money-path com testes-invariantes pequenos.** Reduzir frequência + **MTTR**, não buscar governança perfeita.

## 3. Design (4 componentes, por prioridade de ROI)

### Componente 1 — Alerta de `main` vermelha (cobre dano (a))
Step em `.github/workflows/ci.yml` (job `validate`), `if: failure() && github.ref == 'refs/heads/main'`, que abre/atualiza uma **GitHub Issue**.
- **Idempotente:** procura Issue aberta com label `ci-main-red`; existe → comenta (commit, autor, link do run, jobs que falharam); senão → cria. (Codex: quando o CI volta verde, comentar/fechar — fase 2, opcional.)
- `actions/github-script@v7`, `permissions: issues: write`, assignee = founder. Zero infra externa.

### Componente 2 — Alerta de commit do bot tocando path sensível (cobre dano (c)) — **maior valor (Codex)**
Workflow novo `.github/workflows/lovable-watch.yml`, em `push: branches: [main]`. Se o commit é do Lovable (autor `gpt-engineer-app[bot]` **OU** mensagem casa `^(Changes|Deployed|Redeploy|Deployou)`), faz `diff HEAD^..HEAD --name-only` e, se tocou **paths sensíveis**, abre/comenta Issue (label `lovable-touched-sensitive`) **mesmo com o CI verde**.
- **Paths sensíveis (lista versionada):** `supabase/functions/**`, `src/integrations/supabase/types.ts`, e os módulos money-path (`src/lib/reposicao/**`, `src/lib/custo/**`, `supabase/functions/_shared/**`). Manter a lista no próprio workflow (ou em um arquivo lido por ele).
- Pega a regressão **compilável** antes de virar sintoma operacional — a classe exata do #1076.

### Componente 3 — Guardrails money-path por-invariante (cobre dano (b), preciso)
Padrão já estabelecido (on-order, #1085): teste vitest lê o arquivo `.ts` da edge e **falha por regex** se a regressão volta.
- Adicionar agora: **analyze Omie fallback** (#1077, já revertido = evidência).
- **Critério YAGNI:** só onde há **evidência de reversão** ou money-path crítico. Refinos do Codex: nomear o teste pelo incidente (`prevents_regression_1077_analyze_omie_fallback`); mensagem explica o **risco de negócio**; regex no **invariante mínimo** (não espaçamento/nome local); em refactor legítimo, reescrever o teste junto (não deletar). AST > regex só se ficar complexo (YAGNI agora).

### Componente 4 — Protocolo de restauração + ritual (doc barato)
No `docs/agent/deploy.md`: (a) **restauração rápida** (`git checkout <commit-da-correção> -- <arquivo>` + PR — foi o que destravou #1076/#1085); (b) os **sinais** (Issues dos Componentes 1 e 2); (c) **ritual pós-Lovable** (Codex): após qualquer Publish/deploy/chat-edit, olhar o commit do bot e, se tocou money-path sem intenção, restaurar na hora; evitar editar pelo Lovable arquivos mantidos via PR.

## 4. Fora de escopo (YAGNI — confirmado pelo Codex)
- Job sofisticado de drift git↔prod / "estado bom conhecido" (os alertas cobrem o sintoma; e não sabemos se a plataforma permite medir bem).
- **Auto-reversão** dos commits do bot (causaria guerra de commits).
- Branch protection complexa (o bot precisa de escrita direta).
- Guardrail para toda regra de negócio (só os incidentes observados).

## 5. Verificação
- **Componente 1 e 2:** validar a lógica num PR de teste (forçar a condição e confirmar a Issue) — não dá pra testar quebrando a `main`. Para o Componente 2, testar o matcher de commit + o diff de paths num branch.
- **Componente 3:** falsificar cada guardrail (vermelho na versão regredida, verde na corrigida).
- **Componente 4:** doc — revisão.

## 6. Validação Codex — FEITA (`019f05a0`)
Concordou com as camadas; **adicionou o Componente 2** (proveniência: alertar quando o bot toca path sensível, mesmo com CI verde — cobre o dano (c)); refinou os guardrails (invariante, nomear pelo incidente); confirmou alerta-via-Issue, causa-raiz não-apostável, e os itens YAGNI. Priorização: 1 → 2 → 3 → 4.
