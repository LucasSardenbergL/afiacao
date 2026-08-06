---
name: matar-classe
description: Use SEMPRE que acabou de corrigir (ou diagnosticar) um bug que é INSTÂNCIA de um padrão repetível — laço de paginação artesanal, fallback `|| 0`/`?? 0`/`DEFAULT 0` fabricando número, `CREATE OR REPLACE VIEW` sem `security_invoker`, N+1 em cron, `.rpc()` órfã, upsert sem checar `error` — ANTES de abrir o PR do fix pontual. Sinais de que é classe, não instância: o fix é quase idêntico a um fix anterior; o título natural do PR teria "outro/mais um/Nº laço"; um grep da forma do bug acha mais ocorrências; a série de PRs do mesmo padrão já existe no git log. NÃO use para bug genuinamente único (lógica de negócio local, typo isolado) nem quando a classe JÁ tem gate estrutural ativo — aí conserte a instância e reporte o furo do gate.
---

# matar-classe — o bug de classe morre com a classe, não com a instância

## Por que esta skill existe (evidência deste repo)

- **Paginação parcial silenciosa: ~20 PRs da MESMA classe** (#1338 → #1563 "7º laço" → #1564), corrigidos um a um, cada um esperando o próximo sintoma doer em produção.
- `security_invoker` resetado: 8 PRs. N+1 em cron: 4 PRs. `ausente ≠ zero`: ~14 PRs.
- Teste de baseline (3/3 agentes, 2026-07-23): diante de um fix de paginação pronto, TODOS seguiram os rituais do repo (colisão, evidência positiva, pr-watch) e NENHUM propôs varrer os demais laços. Um deles **citou a série #1557–#1564 e se ofereceu para ser "o 8º laço"** — quem vê a fila entra na fila; esta skill existe para TERMINAR a fila.
- Meta-regra medida no catálogo de retrabalho: **classe com contramedida textual reincide; classe com gate estrutural para** (manifesto de módulos, `edges:typecheck`, `bunpin:check` — zero reincidência após o gate).

## O passo 0 obrigatório (antes de todo `gh pr create` de bugfix)

Responda por escrito no corpo do PR: **"instância única ou classe?"** — com 1 linha de justificativa. Se classe → o protocolo abaixo. Um PR de bugfix sem essa linha está incompleto.

## O protocolo (5 passos)

1. **ASSINATURA** — descreva o padrão como algo GREPÁVEL/estrutural (regex, forma de código, contrato ausente). Calibre com controle: a assinatura TEM que casar o site pré-fix (`git show HEAD~1` dele) e NÃO casar o pós-fix. Assinatura que não discrimina = varredura teatro.
2. **VARREDURA** — rode a assinatura no repo INTEIRO: `src/`, `supabase/functions/` (as ~93 edges), `scripts/`, migrations. Lista >10 sites ou contexto apertado → **delegue a subagente read-only** (leitura delega bem — `worktrees.md`). Saída: TODOS os sites com veredito individual — `afetado` / `já-correto` / `falso-positivo da assinatura`.
3. **ERRADICAÇÃO** — corrija todos os `afetado` na mesma leva. Coeso e ≤10 arquivos → 1 PR; maior ou multi-domínio → fases-PR pequenas (padrão do repo). Site que você não entende → marque e pergunte; **não chute** (money-path: ausente ≠ zero vale para entendimento também).
4. **GATE** — crie o guard estrutural que torna a REINTRODUÇÃO vermelha: regra ESLint, teste que varre fonte (padrão `edge-parse-parity.test.ts`: vitest lê arquivos via `readFileSync` — funciona até para código Deno que o vitest não executa), check de CI, ou hook. **Falsifique o gate**: reintroduza o padrão num arquivo e exija o vermelho; sem isso o gate é decoração. Gate genuinamente impossível → registre POR QUÊ no PR + assinatura no doc do domínio (vira detecção manual documentada, decisão consciente e rastreável).
5. **REGISTRO** — 1 linha no `docs/agent/<domínio>.md`: classe + assinatura + onde vive o gate. O PR nomeia a classe e lista os sites varridos **inclusive os limpos** — prova de varredura completa, não de amostra.

## Pressa é legítima — adiar sem dono não é

O fix pontual PODE sair primeiro em PR próprio (incidente em produção não espera varredura). Mas os passos 1–5 saem **na mesma sessão** — ou viram **chip (`spawn_task`) criado na hora, com título anunciado no chat e a assinatura já calibrada no briefing**. "Depois eu varro", sem chip nem dono, é como a classe da paginação chegou ao 7º laço.

## Racionalizações → realidade

| Racionalização | Realidade |
|---|---|
| "É a Nª instância, a série já é conhecida — entro na fila" | A série É a prova de que a fila não termina sozinha. Quem vê a série termina a série. |
| "O founder tem pressa, PR pequeno primeiro" | Ok — fix pontual primeiro. Varredura+gate na mesma sessão ou chip com dono. Pressa não cancela o passo 0. |
| "Não dá para gatear isso" | Teste-que-lê-fonte gateia até padrão textual em Deno. Se realmente não dá, o registro do porquê é o passo 4. |
| "Contexto quase cheio" | Varredura delega a subagente; erradicação vira chip briefado. Contexto cheio muda o COMO, não o SE. |
| "Grep não acha esse padrão" | Então a assinatura está errada — refine com o controle pré/pós-fix do passo 1. |

## Assinaturas de referência (classes conhecidas deste repo)

```bash
# paginação artesanal fora dos helpers (classe dos ~20 PRs):
rg -n 'range\(' --glob '!src/lib/postgrest*' src/ supabase/functions/ | rg -v 'fetchAllPages|buscarTodasPaginas|paginateAll'
# fabricação de número em money-path:
rg -n '(\|\|\s*0\b|\?\?\s*0\b)' src/lib/reposicao/ src/lib/custo/ supabase/functions/
# view sem security_invoker no replace:
rg -n 'CREATE OR REPLACE VIEW' supabase/migrations/ | rg -v 'security_invoker'
```

## Red flags — pare e rode o protocolo

- O título do PR que você ia escrever contém "outro", "mais um", "Nº laço/caso".
- Você copiou um fix seu (ou de PR anterior) quase literal.
- Você acabou de escrever "mesma classe do #NNNN" em qualquer lugar.
- O diff do fix tem <10 linhas e o bug viveu >1 semana em produção (bug barato + longevo = padrão que ninguém enxerga → provavelmente há irmãos).
