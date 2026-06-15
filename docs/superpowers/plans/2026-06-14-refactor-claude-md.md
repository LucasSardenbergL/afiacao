# Plano — Refactor do `CLAUDE.md` (de 96k → ~3-5k tokens)

> Frente 1 do programa de skills (decidida com Codex). Status: **PLANO PRONTO, execução pendente.**
> Decisão do founder (2026-06-14): o diário de PRs é **movido íntegro pra `docs/historico/`** (preserva tudo, fora do contexto automático). Zero descarte.

## Por que

O `CLAUDE.md` está em **96k tokens / 825 linhas**. Isso:
- **Quebra subagentes** — eles herdam o arquivo inteiro, nascem perto do limite de contexto e entram em loop de auto-compact (registrado em #819 e na frente KB). Subagent-driven virou inviável neste repo.
- **Encarece toda sessão** (96k tokens de instrução em cada turno de cada sessão/worktree).

Anatomia (medida 2026-06-14): **§5 (Padrões críticos, 285 linhas) + §10 (Bugs/débitos, 105 linhas) = ~47% das linhas mas ~70% dos bytes** — é o "diário de PR" (cada bullet conta a história completa de um PR). O resto (§1-4, §6-9, §11-14) é doutrina relativamente estável.

## Métrica de sucesso

- `CLAUDE.md` ≤ ~5k tokens (teto imposto por CI).
- Nenhuma **lição durável** perdida (todas extraídas pra `docs/agent/*` ou preservadas em `docs/historico/*`).
- Subagentes voltam a rodar sem thrashing (testar com um subagente simples pós-refactor).
- Toda regra ativa que hoje muda comportamento continua no `CLAUDE.md` ou linkada de forma que o agente a encontre.

## Taxonomia (4 baldes — classificar TODO o conteúdo)

| Balde | Critério | Destino |
|---|---|---|
| **Invariante / regra ativa** | muda comportamento agora; o agente PRECISA ver sempre | **fica** no `CLAUDE.md` enxuto |
| **Lição durável** | conhecimento reutilizável (uma armadilha, um padrão), independe do PR que a gerou | `docs/agent/<dominio>.md` (carregado sob demanda) |
| **Diário de PR** | narrativa "PR #X fez Y, diagnóstico Z" | `docs/historico/<dominio>.md` (movido íntegro — decisão do founder) |
| **Obsoleto / refutado** | contradiz a realidade atual | corrigir ou remover (ex.: §5 "⛔ acesso ao banco impossível" — refutado: há `claude_ro`/`psql-ro` read-only) |

Regra de ouro: na dúvida entre "lição durável" e "diário", extraia a lição (1-3 linhas) pro `docs/agent/` E mova a narrativa pro `docs/historico/`. **Nunca** descarte uma lição cara só porque a narrativa é longa.

## Estrutura-alvo

```
CLAUDE.md                      # ~3-5k tokens: regras ativas + preferências do founder + ÍNDICE
docs/agent/
  database.md                  # ritual migration Lovable, snapshot/drift, RLS patterns, ACESSO READ-ONLY (claude_ro/psql-ro), armadilhas PostgREST (.or() em UPDATE, CREATE OR REPLACE VIEW só-acrescenta-coluna)
  sync.md                      # cron/sync, Sentinela/watchdog, assinaturas de incidente, timeout_milliseconds, "job_run_details mente", net._http_response
  deploy.md                    # 3 camadas Lovable (Publish frontend / edge via chat / migration SQL Editor), verificação por bytes do bundle
  financeiro.md               # engines (NCG/DRE/valor/regime/funding), cascata da data de baixa (estado final), DSO/DPO
  reposicao.md                 # motor de pedidos, sayerlack portal, intraday, auto-aprovação, mínimo forçado, cmc-first
  money-path.md                # precisão>recall, degradação honesta (ausente≠R$0), PG17 falsificável (→ skill prove-sql-money-path), Codex adversarial / Caminho B
  impersonation.md             # lente "Ver como" (effectiveUserId, write-guard, guardrails no-write-leak)
  knowledge-base.md            # programa KB (boletins↔SKU, versionamento, extração)
docs/historico/
  <dominio>.md                 # o diário de PR íntegro, por domínio (preservado, fora do contexto automático)
scripts/check-claude-md-budget.sh   # CI: falha se CLAUDE.md > teto
```

O `CLAUDE.md` enxuto termina com um **ÍNDICE** apontando cada `docs/agent/*.md` (1 linha cada), pra o agente saber onde buscar o detalhe sob demanda (progressive disclosure).

## Mapeamento por seção (alto nível)

| Seção atual | Vai pra |
|---|---|
| Preferências do topo (pt-BR, contexto, roadmap, fecho) | **fica** (regras ativas) — ⚠️ coordenar "roadmap" com #828 (que move pro chat) |
| §1 Produto | **fica**, resumido (3 empresas + tabela de módulos enxuta) |
| §2 Stack | **fica**, resumido (stack-chave + scripts + `heavy` + armadilha pipe-tail) |
| §3 Estrutura de pastas | resumir; detalhe → `docs/agent/` se útil |
| §4 Design System | **fica**, resumido (tokens v3 + convenções "não usar X") |
| §5 Padrões críticos | **split**: regras→fica resumido · lições→`docs/agent/{database,sync,deploy,money-path,impersonation,...}` · diário→`docs/historico/*` · obsoleto (acesso impossível)→corrigir |
| §6 Princípios não-negociáveis | **fica**, resumido |
| §7-9b UX/design/auditoria | resumir forte (muito é histórico de auditoria concluída) → `docs/historico/ux.md` |
| §10 Bugs/débitos | **split** igual §5 (lições→agent, diário→historico, resolvidos→historico) |
| §11 Premissas | **fica**, resumido |
| §12 Skills | **fica** a tabela de roteamento (enxugar); detalhe de instalação → `docs/agent/skills.md` |
| §13 Health Stack | **fica** |
| §14 Multi-sessão | **fica** (regra) |

## Estratégia de execução — 2 fases (anti-treadmill)

⚠️ O `CLAUDE.md` é o arquivo MAIS quente do repo (40 worktrees, #827/#828 vivos nele). Reescrevê-lo conflita com todas. Mitigação: separar o trabalho aditivo do destrutivo.

**Fase A — aditiva (zero conflito, pode ser com calma):**
1. Criar `docs/agent/*.md` (extrair lições) e `docs/historico/*.md` (mover narrativa). NÃO toca o `CLAUDE.md`.
2. Criar `scripts/check-claude-md-budget.sh` + workflow CI, mas com teto ALTO (não-bloqueante ainda).
3. Vários commits/PRs pequenos, sem pressa — não conflitam com ninguém.

**Fase B — cirúrgica (arquivo quente, 1 PR rápido):**
4. Num único PR pequeno: reescrever o `CLAUDE.md` (cortar §5/§10/diário → deixar regras + ÍNDICE pros docs). Apertar o teto do CI pro valor final.
5. Mergear com PRIORIDADE (rápido). Como o `CLAUDE.md` vira pequeno e o diário sai, conflitos futuros somem (o ímã de conflito era o diário).
6. Idealmente rodar a Fase B num momento de menos worktrees ativas; senão, fix-forward (o §5 já aceita que regressão de interação fica pro CI de push pegar).

**Validação pós-refactor:**
- Rodar um subagente simples (ex.: Explore) e confirmar que NÃO thrasha (a métrica-mãe).
- Conferir que cada `docs/agent/*` é alcançável: o `CLAUDE.md` enxuto cita o índice; uma skill/sessão que precisa do detalhe acha.
- `git grep` por lições-âncora (ex.: "PostgREST", "cmc", "waitUntil", "job_run_details") — todas devem existir em `docs/agent/*` ou `docs/historico/*`.

## Riscos

- **Perder lição cara no corte** → mitigado pela taxonomia (extrai lição antes de mover narrativa) + a validação `git grep` de âncoras.
- **Treadmill no arquivo quente** → mitigado pela Fase A/B (destrutivo concentrado em 1 PR rápido).
- **Regra ativa virar "referência" e o agente não achar na hora** → o que muda comportamento FICA no `CLAUDE.md`; só o detalhe/histórico sai. Em dúvida, mantém no `CLAUDE.md`.
- **Colisão com #828** (roadmap no chat) → coordenar: a regra de roadmap pode mudar; alinhar antes de reescrever o bloco de preferências.

## Não-objetivos

- Não reescrever o CONTEÚDO das lições (só re-roteá-las). Refactor de localização, não de verdade.
- Não tocar `supabase/migrations/` nem código (é só docs + 1 script de CI).
- Não condensar/resumir o diário (decisão: mover íntegro).
