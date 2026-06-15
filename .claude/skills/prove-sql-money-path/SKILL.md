---
name: prove-sql-money-path
description: >-
  Prova uma mudança de SQL de risco num PostgreSQL 17 LOCAL descartável, com falsificação,
  ANTES de entregar a migration. Use SEMPRE que a tarefa criar/alterar migration, função
  SQL/RPC, trigger, RLS policy, view, constraint (CHECK/UNIQUE) ou cron que toque (a) DINHEIRO
  (financeiro/DRE/projeção de caixa, reposição/compras, pedido a fornecedor, preço, estoque,
  positivação/comissão), (b) AUTORIZAÇÃO (RLS, gate de staff/master, SECURITY DEFINER, REVOKE),
  ou (c) AUTOMAÇÃO (sync do Omie, geração de pedido, cron). Vale mesmo quando o usuário não diz
  "teste" e só descreve o objetivo ("cria a RPC que aprova o pedido", "RLS pra vendedor não ver
  custo", "trigger que enfileira o recálculo", "CHECK pra não comprar abaixo do mínimo"). Por quê:
  uma função plpgsql com SQL inválido PASSA no CREATE (late-bound) e só falha ao EXECUTAR — atrás
  de um cron/try-catch, falha SILENCIOSA por dias; e o founder não tem terminal pro backend, então
  o único teste possível ANTES de aplicar em produção é o PG17 local que EU rodo. Esta skill empacota
  o ritual: monta o harness PG17 a partir do template, aplica a migration REAL, semeia, escreve
  asserts positivos E negativos (com SQLSTATE + re-raise), prova RLS com SET ROLE, e FALSIFICA (sabota
  a migração → exige vermelho). É a contraparte da lovable-db-operator (que entrega o handoff + valida
  pós-apply); esta PROVA antes. NÃO use para: SELECT read-only, mudança só de frontend, edge function
  sem SQL novo, migração trivial sem money-path/auth (ex.: índice puro de performance), ou regenerar
  tipos TS. Quando o Codex estiver fora (cota do Plus), o PG17 falsificável é o "Caminho B" — o oráculo
  que substitui a 2ª opinião no caminho do dinheiro.
---

# Prove SQL Money-Path

## Por que esta skill existe (leia antes de qualquer coisa)

Duas verdades deste repo se combinam num risco silencioso:

1. **plpgsql é *late-bound*.** Uma função/RPC/trigger com SQL inválido (coluna ambígua, JOIN que referencia a tabela-alvo, `SUM` que colide com coluna OUT do `RETURNS TABLE`) **passa no `CREATE OR REPLACE`** — o Postgres só resolve os nomes ao **EXECUTAR**. Se essa função roda atrás de um cron ou de um `try/catch` best-effort, ela falha **silenciosamente por tempo indefinido**. Já aconteceu aqui ≥3 vezes (`aplicar_promocoes_no_ciclo` quebrada em prod por um JOIN inválido; `gerar_pedidos_oportunidade_ciclo` por `SUM` ambíguo; ambas atrás de chamador silencioso — o §10 do CLAUDE.md tem o histórico).

2. **O founder não tem terminal pro backend.** Ele aplica SQL colando no SQL Editor do Lovable. Não há staging. O **único** teste possível **antes** de o SQL tocar produção é o que **eu** rodo num PostgreSQL 17 local descartável.

Logo: pra qualquer SQL que mexe com dinheiro, autorização ou automação, **o PG17 local com falsificação é a rede de segurança**. Ele roda a função **de verdade** (pega o bug late-bound), prova os invariantes do money-path, prova que o gate/RLS **nega** quem deve negar, e — o passo que separa teste real de teatro — **se sabota de propósito pra provar que os asserts têm dente**.

Esta skill não fabrica a prova. Ela resolve o boilerplate PG17 chato (initdb descartável, contorno do keg-only do brew, stubs do Supabase, GUC pra impersonar RLS) e **impõe a disciplina** que faz o teste valer. Os asserts e a falsificação você escreve pensando em cada caso — auto-gerá-los recriaria exatamente o teatro que a falsificação existe pra matar.

## A Lei de Ferro (3 regras inegociáveis)

Quebrar qualquer uma recria o bug que esta skill previne.

1. **Aplique a migração REAL, nunca um stub da lógica.** O `.sql` commitado é o que roda (`psql -f supabase/migrations/<arquivo>.sql`). Stubar a função e testar o stub não pega o bug late-bound — que é o motivo nº 1 da skill. Se a migração depende de tabelas/funções que ainda não existem no PG limpo, crie os **pré-requisitos** (stub das tabelas que ela lê, ou o snapshot inteiro), mas **a função sob teste é a real**.

2. **Todo assert negativo captura a `SQLSTATE`/condição ESPERADA e re-lança o resto.** Um gate que deve dar `RAISE EXCEPTION`, um CHECK que deve rejeitar, um REVOKE que deve dar `permission denied` — o teste prova que o erro **certo** acontece. `WHEN OTHERS THEN 'OK'` é **teatro**: engole qualquer erro (inclusive um erro de digitação no seu próprio teste) e pinta verde. Capture a SQLSTATE esperada; no `WHEN OTHERS`, **`RAISE`** (relança). Ver `references/assert-patterns.md`.

3. **Falsificação obrigatória no que importa.** Pra cada invariante que o money-path/gate depende: **sabota a migração de propósito** (recria a policy furada, dropa o trigger, troca o gate por `IF false`) e **exija que o assert correspondente fique VERMELHO**. Se sabotar e o teste seguir verde, o assert não tem dente — conserte o assert. Depois **restaure** a versão verdadeira. Regra anti-teatro: a **sentinela** do teste (a string que você procura pra decidir pass/fail num caminho negativo) **nunca pode conter o texto que o próprio código emite** — senão um `ILIKE`/`position()` casa a própria sentinela e o assert mente. (Isto já mordeu: ver a lição do `test-melhorias-rpcs.sh` no §10.)

## Quando NÃO usar

- **SELECT read-only / export** — não muda estado, não há invariante pra provar.
- **Mudança só de frontend** (React/TS) — use os testes vitest do helper puro.
- **Edge function sem SQL novo** — a lógica Deno se testa pelo helper espelhado (vitest); só entre aqui pela parte SQL (RPC/migration) que a edge chama.
- **Migração trivial sem money-path nem auth** — ex.: índice puro de performance, `COMMENT ON`, rename cosmético. (Mas: `UNIQUE`/`CHECK` que protege o money-path, ou índice que muda o resultado de uma RPC, **valem** o teste.)
- **Regenerar tipos TS** — não toca o banco.

Na dúvida entre "trivial" e "money-path": se um bug naquele SQL faria o app **comprar errado, cobrar errado, vazar dado entre usuários, ou recomendar número fabricado** — é money-path, teste.

## O ritual — 6 passos

Quando a tarefa exigir provar SQL de risco, siga em ordem. Os passos 4 (negativos) e 5 (falsificação) são onde o teste deixa de ser teatro — não pule.

### Passo 1 — Listar o que provar (antes de escrever uma linha)

Escreva, em prosa curta, os **invariantes** e os **caminhos negativos**. Pense em 3 famílias:

- **Positivo (caminho feliz):** o efeito pretendido acontece. Ex.: "aprovar o pedido seta `status='aprovado'` e grava `aprovado_por`"; "a RPC valoriza `preco_unitario` pelo cmc quando há cmc".
- **Negativo (a defesa morde):** quem/o-que deve ser barrado é barrado. Ex.: "não-master chamando a RPC → `RAISE forbidden`"; "CHECK rejeita `minimo <= 0`"; "REVOKE → `authenticated` não executa"; "RLS → vendedor não vê custo de outro".
- **Money-path específico:** o número certo. Ex.: "GREATEST eleva ao piso mas NUNCA vira gatilho de compra"; "dedupe não double-conta"; "ausente vira NULL, não R$0".

Cada item vira 1 assert. Se um item não dá pra falsificar (não dá pra sabotar a migração e ver vermelho), provavelmente não é um invariante de verdade — reconsidere.

### Passo 2 — Montar o harness a partir do template

Copie o esqueleto e nomeie pelo slug da migration:

```bash
cp .claude/skills/prove-sql-money-path/references/harness-template.sh db/test-<slug>.sh
chmod +x db/test-<slug>.sh
```

O template já resolve: PG17 descartável (initdb em tmpdir + trap cleanup), contorno do keg-only do brew, `LC_ALL=C` (sem isso o postmaster aborta), `db/stubs-supabase.sql` (roles `anon`/`authenticated`/`service_role`, schema `auth`, `auth.users`), `auth.uid()`/`auth.role()` lendo GUC de sessão (pra impersonar RLS), e `service_role` com `BYPASSRLS`. Você preenche 4 zonas marcadas `[[...]]`: pré-requisitos de schema, a migration a aplicar, os seeds, os asserts/falsificação.

### Passo 3 — Pré-requisitos + aplicar a migration REAL (Lei #1)

Na **ZONA 1**, crie o que a migração **lê/altera mas não cria**. Dois caminhos:

- **Mínimo (rápido):** `CREATE TABLE` stub só das tabelas que a migração toca, com as colunas que ela usa. Bom quando a migração é auto-contida.
- **Fiel (mais lento):** aplique o `supabase/schema-snapshot.sql` inteiro (o template tem o `sed`/`grep` de restore-ready comentado). Use quando a migração depende de muitas tabelas/funções reais. ⚠️ O snapshot pode estar **stale** (ver §5/§6 do CLAUDE.md — já faltou `order_date_kpi`, `tipo_produto`, `minimo_forcado_manual`); se faltar uma coluna recente, adicione um `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` antes de aplicar a migração.

Na **ZONA 2**, aplique a migração real. Se a função recriada também existe em prod, faça o **pré-flight** mental do §10: o corpo que você testa deve ser o corpo que vai pra prod (cuidado com drift repo×prod em `CREATE OR REPLACE`).

### Passo 4 — Asserts positivos, negativos e RLS (Lei #2)

Use `references/assert-patterns.md`. Resumo:
- **Positivo:** rode a função/insira a linha, leia o efeito, compare (`eq`).
- **Negativo:** bloco `DO $$ ... EXCEPTION WHEN <sqlstate_esperada> THEN ... WHEN OTHERS THEN RAISE; END $$` — passa só se o erro **esperado** veio; qualquer outro relança.
- **RLS:** `SET test.uid='<uuid>'; SET ROLE authenticated; SELECT count(*) ...` (own-scope, staff, anon-deny). `service_role` (BYPASSRLS) pra semear.

### Passo 5 — Falsificação (Lei #3)

Pra cada assert que protege dinheiro/autorização: sabota a migração na sessão de teste (recria a policy/trigger/função **na versão furada**), **re-roda só aquele assert** e **exija que ele falhe**; se passar, o assert é fraco. Restaure a versão verdadeira (cirurgicamente — só o que sabotou). Sentinela **anti-teatro** (não contém o texto do código). Ver o padrão completo em `references/assert-patterns.md`.

### Passo 6 — Rodar até verde-real, reportar e commitar

```bash
bash db/test-<slug>.sh   # NÃO pipe pra tail — engole o exit code (§2 do CLAUDE.md); redirecione e cheque $?
echo "exit=$?"
```

Itere até: **verde com a migração real** E **vermelho com cada sabotagem** (durante o desenvolvimento da falsificação). Reporte ao usuário: quantos asserts, o que cada um prova (1 linha), e que a falsificação confirmou o dente. Commite o `db/test-<slug>.sh` junto com a migração — vira regressão executável e evidência pro PR.

> ⚠️ **`bash db/test-*.sh | tail -N` ENGOLE o exit≠0** (o pipe retorna o status do `tail`). Já mordeu (§10, fixes-codex-711). Quando o exit importa: `> /tmp/log 2>&1; echo $?` e leia o log.

## Relação com as outras skills

- **`lovable-db-operator`** — composição. Fluxo money-path: desenhar SQL → **`prove-sql-money-path`** (testa local, falsifica) → **`lovable-db-operator`** (empacota o handoff "cole no SQL Editor" + a query de validação pós-apply) → founder aplica. A `db-operator` valida que o objeto **existe** após o Run; esta prova que ele **funciona** antes.
- **`/codex` (challenge/consult)** — o adversarial do Codex e o PG17 são complementares. Quando o Codex está fora (cota do Plus esgota em janela rolante de 7d), o PG17 falsificável é o **"Caminho B"** registrado no §5/§10: o oráculo que substitui a 2ª opinião no caminho do dinheiro. Marque `REVISÃO INDEPENDENTE PENDENTE` e rode o Codex retroativo quando a cota voltar — auto-prova não substitui revisão independente, só cobre o intervalo.

## Arquivos de apoio desta skill

- `references/harness-template.sh` — o esqueleto PG17 descartável pronto (copie pra `db/test-<slug>.sh` e preencha as 4 zonas).
- `references/assert-patterns.md` — padrões prontos: assert positivo, negativo (SQLSTATE + re-raise), RLS (SET ROLE + GUC), e o padrão de falsificação anti-teatro.
- `evals/trigger-eval.json` — casos `should_trigger` true/false pra calibrar o disparo da skill.

## Pré-requisitos da máquina

`brew install postgresql@17 pgvector`. O template contorna o keg-only do brew (copia `share`/`lib` do Cellar) e usa `LC_ALL=C`. Roda em ~2-5s por harness. Se rodar vários em paralelo (40 worktrees), ajuste a `PORT` no topo do harness pra não colidir.
