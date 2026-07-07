# Consolidação de demanda de reposição (N→1) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Money-path (reposição/compras).** Ritual obrigatório: prova PG17 (`prove-sql-money-path`) com falsificação → Codex consult+challenge → handoff `lovable-db-operator` (founder cola no SQL Editor). Spec: `docs/superpowers/specs/2026-07-05-reposicao-consolidacao-demanda-substituicao-design.md`.

**Goal:** Fazer o recompute de demanda do SKU **destino** agregar as vendas dos SKUs mapeados como substituídos por ele (N→1), para o motor de reposição dimensionar a compra pelo giro **somado** — sem inativar os antigos no Omie e sem abrir buraco de ruptura na transição.

**Architecture:** Uma **view de indireção** `v_venda_items_history_efetivo` reescreve `sku_codigo_omie` do antigo para o destino via `LEFT JOIN sku_substituicao (status='aplicada')`. As 5 views-fonte de demanda trocam apenas `FROM venda_items_history` → `FROM v_venda_items_history_efetivo` (mesmo nome de coluna → zero mudança de agregação). O de-para vive em **um** lugar; toda a cadeia herda. Uma função `consolidar_demanda_sku` faz o cadastro (valida, grava o mapa `aplicada`, descontinua o antigo) sem copiar parâmetros — a demanda cuida do dimensionamento.

**Tech Stack:** PostgreSQL 17 (views + PL/pgSQL, RLS), Supabase (prod ref `fzvklzpomgnyikkfkzai`), harness de prova `db/test-*.sh` (PG17 local), `prove-sql-money-path`. Frontend (Frente C) fica em **plano separado**.

---

## Escopo deste plano

**No escopo:** Frente A (mapa em `sku_substituicao`) + Frente B (de-para no cálculo de demanda) — a **consolidação estrutural** que o founder pediu ("Só a consolidação estrutural" / "Faca o B"). Ao fim, o founder consegue consolidar `DFZ.8040LT` e `DFA.4128LT` em `DFA.4080LT` cadastrando 2 registros e o motor passa a comprar o 4080 pelo giro dos três.

**Fora do escopo (→ plano separado):** Frente C (botão de cadastro no `SkuDetailSheet` da aba "Ajuste manual"). Motivo: subsistema distinto (React/Vite/vitest vs SQL/PG17/SQL Editor), deploy distinto (Lovable Publish vs SQL Editor), entregável testável de forma independente. A Fase SQL entrega valor sozinha (cadastro manual dos 2 mapas no handoff). O plano da Frente C chama `consolidar_demanda_sku` desta fase.

## File Structure

| Arquivo | Papel | Ação |
|---|---|---|
| `db/preflight-reposicao-consolidacao.sql` | **Saída** do pré-flight: `pg_get_viewdef`/`pg_get_functiondef`/DDL das tabelas base, verbatim da PROD. Âncora do `CREATE OR REPLACE` (ordem de colunas) e revela as CTEs de `v_sku_parametros_sugeridos`. | Criar (gerado por `psql-ro`) |
| `db/test-reposicao-consolidacao-demanda.sh` | Harness PG17: sobe PG efêmero, carrega tabelas mínimas + views + a efetiva, semeia, roda asserts positivos/negativos/falsificação. | Criar |
| `db/reposicao-consolidacao-demanda.sql` | **A migration candidata** (idempotente): `v_venda_items_history_efetivo` + os 5 redirects (ordem de colunas preservada) + `consolidar_demanda_sku` + guards. Vira o bloco a colar no SQL Editor. | Criar |
| `supabase/migrations/*` | Snapshot DR — **NÃO TOCAR** (CLAUDE.md). O script canônico vive em `db/`. | — |

> **Isolamento já confirmado (spec §5, `psql-ro` 2026-07-05):** só 5 views + 3 funções de reposição leem `venda_items_history`. Nada de BI/venda/comissão/DRE. Reescrever via a efetiva não contamina fora de reposição.

---

## Task 0: Pré-flight — capturar o verbatim da PROD

**Files:**
- Create: `db/preflight-reposicao-consolidacao.sql`

Money-path: o repo diverge da prod (apply manual). O `CREATE OR REPLACE VIEW` **só acrescenta coluna no fim** → preciso da ordem EXATA de colunas de cada view antes de recriar. E `v_sku_parametros_sugeridos` precisa ter suas CTEs localizadas.

- [ ] **Step 1: Rodar o dump read-only da prod**

Run (precisa da janela do classificador de Bash aberta; read-only, role `claude_ro`):

```bash
SP="db/preflight-reposicao-consolidacao.sql"
{
  for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada \
           v_sku_candidatos_primeira_compra v_sku_parametros_sugeridos; do
    echo "-- ===== VIEW $v ====="
    ~/.config/afiacao/psql-ro -At -c "SELECT pg_get_viewdef('$v'::regclass, true);"
    echo ""
  done
  for f in atualizar_parametros_numericos_skus calcular_gatilhos_reposicao \
           registrar_substituicao_sku validar_sku_para_aplicacao; do
    echo "-- ===== FUNC $f ====="
    ~/.config/afiacao/psql-ro -At -c \
      "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='$f';"
    echo ""
  done
  for t in venda_items_history sku_substituicao sku_parametros; do
    echo "-- ===== TABLE $t (colunas + tipos + NOT NULL/default) ====="
    ~/.config/afiacao/psql-ro -At -c \
      "SELECT column_name||' '||data_type||' '||is_nullable||' '||coalesce(column_default,'') \
       FROM information_schema.columns WHERE table_name='$t' ORDER BY ordinal_position;"
    echo ""
  done
} > "$SP" 2>&1
echo "EXIT=$?"; wc -l "$SP"
```

Expected: arquivo com as 5 defs de view, 4 defs de função, 3 DDLs de tabela. `wc -l` > 200.

- [ ] **Step 2: Extrair os fatos que travam o design**

Ler `db/preflight-reposicao-consolidacao.sql` e anotar (comentário no topo do arquivo `db/reposicao-consolidacao-demanda.sql` da Task 2):
- Lista ordenada de colunas de CADA uma das 5 views (para o redirect preservar a ordem).
- Em `v_sku_parametros_sugeridos`: nome da(s) CTE(s) com `FROM venda_items_history` (ou confirmação de que lê demanda via `v_sku_demanda_estatisticas` e NÃO toca a tabela direto — nesse caso ela não precisa de redirect).
- Nas 2 escritoras: quais colunas de `sku_parametros` cada uma escreve e de qual view lê a demanda.

Expected: sem isso, NÃO prosseguir para a Task 3 (redirect às cegas quebra a ordem de colunas).

- [ ] **Step 3: Pré-flight de unicidade (database.md §5) + fonte do verbatim**

```bash
# ON CONFLICT (empresa, sku_codigo_antigo, status) exige índice único casando ESSAS 3 colunas.
# Índice PARCIAL não aparece em pg_constraint → olhar pg_indexes também:
~/.config/afiacao/psql-ro -c "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='sku_substituicao';"
```

- Se o único for **parcial** (`WHERE status=...`) e não cobrir as 3 colunas planas, ajustar o `ON CONFLICT` (ou a constraint) — senão o cadastro falha/casa errado.
- **Fonte de verdade do redirect = PROD** (`pg_get_viewdef` via `psql-ro`), não o snapshot (database.md §3: prod é alvo móvel). O harness carrega o snapshot; se a def de prod das CTEs de demanda divergir do snapshot na parte que toco, usar a de prod no redirect e reconciliar.

---

## Task 1: Harness PG17 — bootstrap + snapshot REAL

**Files:**
- Create: `db/test-reposicao-consolidacao-demanda.sh`

Base: `db/test-city-norm-paridade.sh` (padrão do projeto, já lido). Carregar o **schema real de prod** (`supabase/schema-snapshot.sql`), **não** tabelas-mock: `v_sku_parametros_sugeridos` junta demanda+custo+LT+fornecedor; mockar as deps à mão é inviável e infiel. O snapshot traz as 5 views + as escritoras + as 3 tabelas reais.

- [ ] **Step 1: Copiar o bootstrap do city-norm**

De `db/test-city-norm-paridade.sh`, verbatim (só trocando nomes): `set -euo pipefail`; `REPO_ROOT`; `export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8`; `PGVER=17`; `PGBIN=/opt/homebrew/opt/postgresql@17/bin`; **`PORT=5442`** (≠5441 do city-norm p/ rodar em paralelo); `DATA`/`WORK` via `mktemp -d`; checagem do `initdb` (senão `brew install postgresql@17`); cópia CELLAR share/lib; `cleanup()` no trap EXIT; `initdb -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8`; `pg_ctl -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-reposicao.log -w start`; `createdb -p $PORT -h /tmp -U postgres reposicao_verify`; `P() { "$PGBIN/psql" -p $PORT -h /tmp -U postgres -d reposicao_verify "$@"; }`.

- [ ] **Step 2: Carregar snapshot + stubs + prelude (padrão city-norm)**

```bash
RR="$(mktemp "${TMPDIR:-/tmp}/snap-reposicao.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"
```

Expected: as 5 views + escritoras + `venda_items_history`/`sku_substituicao`/`sku_parametros` existem.

> ⚠️ **Drift (database.md §3):** o snapshot é datado; prod é alvo móvel. Como isto é motor money-path, o pré-flight (Task 0) confere `md5(pg_get_viewdef)` prod × snapshot para as 5 views + as 2 escritoras; se divergir, usar a def de PROD (via `psql-ro`) no redirect, não a do snapshot.

- [ ] **Step 3: Stub de auth p/ destravar a escrita da função (o gate checa `auth.uid()`)**

```sql
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'authenticated'::text $$;
INSERT INTO user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-000000000001','employee') ON CONFLICT DO NOTHING;
```

> Nota (database.md §7): PG17 local é superuser e **NÃO** reproduz o 42501 do gate — o gate prova-se pós-deploy via `psql-ro` (`has_function_privilege`). Aqui o stub só destrava a lógica de consolidação para testar.

- [ ] **Step 4: Aplicar a migração candidata**

Run: `P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/db/reposicao-consolidacao-demanda.sql"`
Expected: a efetiva + os redirects + a função criam sem erro. **Antes do pré-flight (Task 0) os redirects estão vazios → os asserts de soma (Task 3+) ficam VERMELHOS: é o TDD esperado.**

---

## Task 2: View de indireção `v_venda_items_history_efetivo`

**Files:**
- Create/append: `db/reposicao-consolidacao-demanda.sql`
- Test: `db/test-reposicao-consolidacao-demanda.sh`

- [ ] **Step 1: Escrever o teste de passthrough e de reescrita**

No harness, semear e asserir os dois casos:

```sql
-- passthrough: sem mapa, a efetiva devolve o sku original
INSERT INTO venda_items_history (empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, quantidade)
VALUES ('OBEN','NFE-A', CURRENT_DATE - 10, 8040, 45);
DO $$
DECLARE k bigint;
BEGIN
  SELECT sku_codigo_omie INTO k FROM v_venda_items_history_efetivo WHERE nfe_chave_acesso='NFE-A';
  ASSERT k = 8040, format('passthrough esperado 8040, obtido %s', k);
END $$;

-- reescrita: com mapa 8040→4080 aplicada, a efetiva devolve 4080
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, status)
VALUES ('OBEN','8040','4080','aplicada');
DO $$
DECLARE k bigint;
BEGIN
  SELECT sku_codigo_omie INTO k FROM v_venda_items_history_efetivo WHERE nfe_chave_acesso='NFE-A';
  ASSERT k = 4080, format('reescrita esperada 4080, obtido %s', k);
END $$;
```

- [ ] **Step 2: Rodar → ver falhar (view não existe)**

Run: `bash db/test-reposicao-consolidacao-demanda.sh`
Expected: FAIL — `relation "v_venda_items_history_efetivo" does not exist`.

- [ ] **Step 3: Implementar a view (em `db/reposicao-consolidacao-demanda.sql`)**

```sql
CREATE OR REPLACE VIEW v_venda_items_history_efetivo AS
SELECT
  v.id, v.empresa, v.nfe_chave_acesso, v.nfe_numero, v.nfe_serie, v.data_emissao,
  v.cliente_codigo_omie, v.cliente_razao_social, v.cliente_cnpj_cpf, v.cliente_uf, v.cliente_cidade,
  COALESCE(s.sku_codigo_novo::bigint, v.sku_codigo_omie) AS sku_codigo_omie,  -- reescrito p/ o destino
  v.sku_codigo, v.sku_descricao, v.sku_ncm, v.sku_unidade,
  v.quantidade, v.valor_unitario, v.valor_total, v.cfop, v.raw_data, v.created_at
FROM venda_items_history v
LEFT JOIN sku_substituicao s
  ON s.empresa = v.empresa
 AND s.sku_codigo_antigo = v.sku_codigo_omie::text
 AND s.status = 'aplicada';
```

> Confirmar na Task 0 se as colunas de `venda_items_history` batem; ajustar a lista se o DDL da prod divergir. A **ordem/nomes** de colunas devem espelhar `venda_items_history` para os redirects funcionarem sem tocar agregação.

- [ ] **Step 4: Rodar → ver passar**

Run: `bash db/test-reposicao-consolidacao-demanda.sh`
Expected: PASS nos dois asserts.

- [ ] **Step 5: Commit**

```bash
git add db/reposicao-consolidacao-demanda.sql db/test-reposicao-consolidacao-demanda.sh
git commit -m "feat(reposicao): view de indireção de-para de SKU para consolidação de demanda"
```

---

## Task 3: Redirecionar `v_sku_demanda_estatisticas` (a central, 90d)

**Files:**
- Modify: `db/reposicao-consolidacao-demanda.sql` (acrescentar o `CREATE OR REPLACE VIEW` recriado)
- Test: `db/test-reposicao-consolidacao-demanda.sh`

- [ ] **Step 1: Escrever o teste da demanda somada (o coração money-path)**

Semear 90d de vendas nos três e asserir a soma no destino + zero nos antigos:

```sql
TRUNCATE venda_items_history, sku_substituicao;
INSERT INTO venda_items_history (empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, quantidade) VALUES
  ('OBEN','N1', CURRENT_DATE - 10, 4080, 90),   -- destino: 90/90d = 1.0/dia
  ('OBEN','N2', CURRENT_DATE - 20, 8040, 45),   -- antigo A: 45  = 0.5/dia
  ('OBEN','N3', CURRENT_DATE - 30, 4128, 180);  -- antigo B: 180 = 2.0/dia
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, status) VALUES
  ('OBEN','8040','4080','aplicada'),
  ('OBEN','4128','4080','aplicada');

DO $$
DECLARE m numeric; t numeric; n int;
BEGIN
  SELECT demanda_media_diaria, demanda_total_90d
    INTO m, t FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  ASSERT t = 315, format('total esperado 315, obtido %s', t);          -- 90+45+180
  ASSERT m = 3.5, format('média/dia esperada 3.5, obtido %s', m);      -- 315/90
  SELECT count(*) INTO n FROM v_sku_demanda_estatisticas
    WHERE empresa='OBEN' AND sku_codigo_omie IN (8040,4128);
  ASSERT n = 0, format('antigos não devem aparecer, obtido %s linhas', n);
END $$;
```

- [ ] **Step 2: Rodar → ver falhar**

Run: `bash db/test-reposicao-consolidacao-demanda.sh`
Expected: FAIL — a view ainda lê `venda_items_history` direto: total=90, e 8040/4128 aparecem (n=2).

- [ ] **Step 3: Recriar a view trocando só o FROM**

Colar o `pg_get_viewdef` capturado na Task 0 em `db/reposicao-consolidacao-demanda.sql`, trocar **apenas** `FROM venda_items_history` → `FROM v_venda_items_history_efetivo` na(s) CTE(s) que agregam (`vendas_por_ordem`), **preservando a lista/ordem de colunas exata** do `SELECT` final. Nenhuma outra linha muda.

- [ ] **Step 4: Rodar → ver passar**

Run: `bash db/test-reposicao-consolidacao-demanda.sh`
Expected: PASS (t=315, m=3.5, n=0).

- [ ] **Step 5: Commit**

```bash
git add db/reposicao-consolidacao-demanda.sql db/test-reposicao-consolidacao-demanda.sh
git commit -m "feat(reposicao): v_sku_demanda_estatisticas agrega demanda pelo de-para (N→1)"
```

---

## Task 4: Redirecionar `v_sku_sigma_demanda` (180d, σ)

**Files:** Modify `db/reposicao-consolidacao-demanda.sql`; Test `db/test-reposicao-consolidacao-demanda.sh`

- [ ] **Step 1: Teste — σ/demanda diária do destino reflete os três (janela 180d)**

Reusar o seed dos três (todos dentro de 180d). Asserir que o destino aparece com demanda consolidada e os antigos somem:

```sql
DO $$
DECLARE n_dest int; n_old int;
BEGIN
  SELECT count(*) INTO n_dest FROM v_sku_sigma_demanda WHERE empresa='OBEN' AND sku_codigo_omie::bigint=4080;
  ASSERT n_dest = 1, format('destino deve aparecer 1x, obtido %s', n_dest);
  SELECT count(*) INTO n_old FROM v_sku_sigma_demanda WHERE empresa='OBEN' AND sku_codigo_omie::bigint IN (8040,4128);
  ASSERT n_old = 0, format('antigos não devem aparecer, obtido %s', n_old);
END $$;
```

- [ ] **Step 2: Rodar → ver falhar** — Run: `bash db/test-reposicao-consolidacao-demanda.sh` — Expected: FAIL (antigos aparecem).
- [ ] **Step 3: Recriar** trocando `FROM venda_items_history` → `FROM v_venda_items_history_efetivo` na CTE `vendas_diarias`, ordem de colunas preservada (verbatim da Task 0).
- [ ] **Step 4: Rodar → ver passar** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(reposicao): v_sku_sigma_demanda pelo de-para"`

---

## Task 5: Redirecionar `v_sku_demanda_rajada` (180d)

**Files:** Modify `db/reposicao-consolidacao-demanda.sql`; Test idem

- [ ] **Step 1: Teste** — destino presente, antigos ausentes (mesmo padrão da Task 4, view `v_sku_demanda_rajada`).
- [ ] **Step 2: Rodar → ver falhar.**
- [ ] **Step 3: Recriar** trocando o FROM nas CTEs `skus_ativos` **e** `vendas_diarias` (ambas leem a tabela — confirmar na Task 0), ordem de colunas preservada.
- [ ] **Step 4: Rodar → ver passar.**
- [ ] **Step 5: Commit** — `git commit -m "feat(reposicao): v_sku_demanda_rajada pelo de-para"`

---

## Task 6: Redirecionar `v_sku_candidatos_primeira_compra` (180d)

**Files:** Modify `db/reposicao-consolidacao-demanda.sql`; Test idem

> Semântica: um antigo mapeado não deve reaparecer como "candidato a 1ª compra" (ele foi descontinuado); e a recorrência do antigo passa a contar para o destino. Provar ambos.

- [ ] **Step 1: Teste**

```sql
DO $$
DECLARE n_old int;
BEGIN
  SELECT count(*) INTO n_old FROM v_sku_candidatos_primeira_compra
    WHERE empresa='OBEN' AND sku_codigo_omie IN (8040,4128);
  ASSERT n_old = 0, format('antigo mapeado não é candidato, obtido %s', n_old);
END $$;
```

- [ ] **Step 2: Rodar → ver falhar.**
- [ ] **Step 3: Recriar** trocando o FROM na CTE `recorrencia_180d`, ordem preservada.
- [ ] **Step 4: Rodar → ver passar.**
- [ ] **Step 5: Commit** — `git commit -m "feat(reposicao): v_sku_candidatos_primeira_compra pelo de-para"`

---

## Task 7: Redirecionar `v_sku_parametros_sugeridos` (se ler a tabela direto)

**Files:** Modify `db/reposicao-consolidacao-demanda.sql`; Test idem

**DECIDIDO (pré-flight 2026-07-05):** `v_sku_parametros_sugeridos` pega a demanda via `v_sku_classificacao_abc_xyz` → `v_sku_demanda_estatisticas` → **herda** a consolidação pela Task 3 (**não recriar**). Sua ÚNICA leitura direta de `venda_items_history` é a CTE `precos_venda`, que é **PREÇO**, não demanda: **não redirecionar** (o custo/preço deve ser do SKU real; misturar os antigos = fabricar custo, viola money-path). O teste abaixo (cenário D do harness) prova a propagação; se o SKU não aparecer por filtro de classificação, B/C cobrem o essencial.

- [ ] **Step 1: Teste — os parâmetros sugeridos do destino usam a demanda somada**

```sql
DO $$
DECLARE d numeric;
BEGIN
  SELECT demanda_media_diaria INTO d FROM v_sku_parametros_sugeridos
    WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  ASSERT d = 3.5, format('sugeridos devem usar demanda somada 3.5, obtido %s', d);
END $$;
```

- [ ] **Step 2: Rodar.** Se PASS já (herdou da Task 3) → registrar no comentário do SQL "não lê a tabela direto; herda". Se FAIL → **Step 3**.
- [ ] **Step 3: Recriar** a(s) CTE(s) identificada(s) na Task 0, ordem de colunas preservada.
- [ ] **Step 4: Rodar → ver passar.**
- [ ] **Step 5: Commit** — `git commit -m "feat(reposicao): v_sku_parametros_sugeridos consolida demanda (direto ou herdado)"`

---

## Task 8: Guards e edge cases (falsificação inclusa)

**Files:** Modify `db/reposicao-consolidacao-demanda.sql` (função de cadastro na Task 9 aplica os guards de cadastro); Test `db/test-reposicao-consolidacao-demanda.sh`

- [ ] **Step 1: Falsificação — sabotar a efetiva e EXIGIR vermelho**

No harness, criar um segundo alvo que recria `v_venda_items_history_efetivo` como passthrough puro (sem o JOIN) e asserir que o teste da Task 3 **falha** (demanda volta a 90). Se continuar verde, o de-para não é o que causa a soma → prova inválida.

```sql
-- SABOTAGEM (bloco de falsificação, roda isolado):
CREATE OR REPLACE VIEW v_venda_items_history_efetivo AS SELECT * FROM venda_items_history;
DO $$
DECLARE t numeric; ok boolean := false;
BEGIN
  SELECT demanda_total_90d INTO t FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  ASSERT t = 90, format('sob sabotagem, destino deve voltar a 90 (só ele), obtido %s', t);
  -- se chegou aqui, a sabotagem reverteu a soma como esperado: a prova é válida
END $$;
```

Expected: sob sabotagem, `t=90` (não 315). Restaurar a view boa em seguida.

- [ ] **Step 2: Auto-referência (antigo = novo) é idempotente no cálculo**

```sql
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, status)
VALUES ('OBEN','4080','4080','aplicada');  -- auto-ref
DO $$
DECLARE t numeric;
BEGIN
  SELECT demanda_total_90d INTO t FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  ASSERT t = 315, format('auto-ref não pode duplicar; esperado 315, obtido %s', t);
END $$;
```

Expected: PASS (COALESCE 4080→4080 é idempotente; não vira 405).

- [ ] **Step 3: Empresa-aware — mapa OBEN não afeta COLACOR**

```sql
INSERT INTO venda_items_history (empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, quantidade)
VALUES ('COLACOR','C1', CURRENT_DATE - 5, 8040, 12);  -- mesmo código, outra empresa, sem mapa nela
DO $$
DECLARE t numeric;
BEGIN
  SELECT demanda_total_90d INTO t FROM v_sku_demanda_estatisticas WHERE empresa='COLACOR' AND sku_codigo_omie=8040;
  ASSERT t = 12, format('COLACOR não deve herdar o mapa OBEN; esperado 12, obtido %s', t);
END $$;
```

Expected: PASS (o JOIN casa `empresa`).

- [ ] **Step 4: Rodar tudo → ver passar; Commit**

Run: `bash db/test-reposicao-consolidacao-demanda.sh`
Expected: PASS em todos os asserts (incl. a falsificação comportando-se como esperado).

```bash
git commit -am "test(reposicao): guards (falsificação, auto-ref, empresa-aware) da consolidação"
```

---

## Task 9: Função de cadastro `consolidar_demanda_sku` (grava o mapa + descontinua o antigo)

**Files:** Modify `db/reposicao-consolidacao-demanda.sql`; Test `db/test-reposicao-consolidacao-demanda.sh`

Ponto único de cadastro (chamado pelo handoff manual agora e pela Frente C depois). Valida (barra auto-ref e cadeia), grava `sku_substituicao` `aplicada`, e seta `tipo_reposicao='descontinuado'` no antigo em `sku_parametros` (decisão do founder). **Não** copia parâmetros numéricos — a demanda cuida. SECURITY DEFINER + gate de staff (padrão do projeto; confirmar helper no pré-flight).

- [ ] **Step 1: Teste — cadastro grava mapa aplicada + descontinua antigo; barra auto-ref e cadeia**

```sql
-- precisa de sku_parametros mínimo no harness:
CREATE TABLE IF NOT EXISTS sku_parametros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL, sku_codigo_omie bigint NOT NULL,
  tipo_reposicao text, ativo boolean DEFAULT true,
  UNIQUE (empresa, sku_codigo_omie)
);
INSERT INTO sku_parametros (empresa, sku_codigo_omie) VALUES ('OBEN', 8040);

SELECT consolidar_demanda_sku('OBEN','8040','4080');
DO $$
DECLARE st text; tr text;
BEGIN
  SELECT status INTO st FROM sku_substituicao WHERE empresa='OBEN' AND sku_codigo_antigo='8040';
  ASSERT st = 'aplicada', format('mapa deve ficar aplicada, obtido %s', st);
  SELECT tipo_reposicao INTO tr FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=8040;
  ASSERT tr = 'descontinuado', format('antigo deve virar descontinuado, obtido %s', tr);
END $$;

-- auto-ref barrada
DO $$
BEGIN
  PERFORM consolidar_demanda_sku('OBEN','4080','4080');
  ASSERT false, 'auto-ref deveria ter falhado';
EXCEPTION WHEN raise_exception THEN NULL;  -- esperado
END $$;

-- cadeia barrada: 4080 já é destino; não pode virar antigo
DO $$
BEGIN
  PERFORM consolidar_demanda_sku('OBEN','4080','9999');
  ASSERT false, 'cadeia deveria ter falhado';
EXCEPTION WHEN raise_exception THEN NULL;  -- esperado
END $$;
```

- [ ] **Step 2: Rodar → ver falhar** (função não existe).
- [ ] **Step 3: Implementar `consolidar_demanda_sku`**

```sql
CREATE OR REPLACE FUNCTION consolidar_demanda_sku(
  p_empresa text, p_sku_antigo text, p_sku_novo text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- gate de staff: usar o helper canônico do projeto (confirmar nome no pré-flight, ex.: authorize_staff())
  -- IF NOT authorize_staff() THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_sku_antigo = p_sku_novo THEN
    RAISE EXCEPTION 'auto-referência: antigo = novo (%). Consolidação inválida.', p_sku_antigo;
  END IF;

  -- cadeia: o destino não pode já ser um ANTIGO aplicado de outro mapa, nem o antigo já ser DESTINO de alguém
  IF EXISTS (SELECT 1 FROM sku_substituicao WHERE empresa=p_empresa AND sku_codigo_antigo=p_sku_novo AND status='aplicada')
  OR EXISTS (SELECT 1 FROM sku_substituicao WHERE empresa=p_empresa AND sku_codigo_novo=p_sku_antigo AND status='aplicada') THEN
    RAISE EXCEPTION 'cadeia transitiva detectada envolvendo % → % (resolução multi-nível fora de escopo).', p_sku_antigo, p_sku_novo;
  END IF;

  INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status, aplicado_em, data_substituicao)
  VALUES (p_empresa, p_sku_antigo, p_sku_novo, 'consolidar_demanda', 'aplicada', now(), CURRENT_DATE)
  ON CONFLICT (empresa, sku_codigo_antigo, status)
  DO UPDATE SET sku_codigo_novo = EXCLUDED.sku_codigo_novo, aplicado_em = now();

  UPDATE sku_parametros
     SET tipo_reposicao = 'descontinuado'
   WHERE empresa = p_empresa AND sku_codigo_omie = p_sku_antigo::bigint;
END $$;
```

- [ ] **Step 4: Rodar → ver passar** (mapa aplicada, antigo descontinuado, auto-ref e cadeia barradas).
- [ ] **Step 5: Commit** — `git commit -am "feat(reposicao): consolidar_demanda_sku (cadastro + descontinuar antigo + guards)"`

---

## Task 10: Revisão adversária — auto-challenge + Codex challenge (xhigh) ✅

**Files:** nenhum (gate money-path). O **Codex CLI (gpt-5.5, xhigh) RODOU** 2026-07-05 sobre a migração + prova + fatos de schema (prompt em `scratchpad/codex-challenge-prompt.md`). Achou **5 P1** que o auto-challenge não pegou — todos incorporados e re-provados no PG17 (cenários E/F/H).

**Achados do CODEX (P1) — incorporados + provados:**
| Achado | Fix (cenário) |
|---|---|
| Leading zeros (`'08040'`≠'8040' na view, mas `::bigint` descontinua o 8040) → ruptura | canonicaliza `::bigint` na função **e** no trigger (F6, H2) |
| `ON CONFLICT` não trocava `acao_parametros` (mapa legado seguia invisível, antigo descontinuado) | `DO UPDATE SET acao_parametros='consolidar_demanda'` (B4) |
| **Fusível `segurado`**: escritora NÃO aplica se `max_sug>3×max_antes`; consolidação (90→315=3,5×) dispara ele → views certas, compra errada | **passo de aprovação no handoff** (Task 11 **Step 4b**) — gate humano da mudança de 3,5× |
| Cadeia só-no-cadastro insuficiente (INSERT direto do handoff / concorrência) | **trigger estrutural** em `sku_substituicao` + advisory lock por empresa (E1, H1) |
| Destino não validado (SKU fantasma/descontinuado); `UPDATE` do antigo podia afetar 0 linhas | `ZR004` (destino existe/ativo/não-descont.) + `GET DIAGNOSTICS`/`ZR005` (F7) |
| P2: overflow bigint; gate SECURITY DEFINER frágil; preço do destino sem custo | guard `≤18 díg.` (`ZR003`); `public.`+`search_path`; nota no handoff |

Codex confirmou **OK**: dupla contagem (UNIQUE garante 1 match), NULL fail-closed, ordem de colunas do `CREATE OR REPLACE`, descontinuar 2-campos, performance (+ índice parcial adicionado).

**Achados do auto-challenge (Caminho B) — também incorporados:**
| # | Sev | Achado | Mitigação |
|---|---|---|---|
| 1 | ALTO | Redirects fariam **todo** `sku_substituicao` `status='aplicada'` (inclusive da feature antiga `registrar_substituicao_sku`, que grava `acao_parametros='transferir'`) consolidar demanda | **ESTRUTURAL**: o de-para filtra `acao_parametros='consolidar_demanda'` (valor que só a nova função/handoff gravam) — provado no cenário **B4** (mapa legado 'transferir' não consolida). + gate no handoff (Step 1b) como confirmação |
| 2 | MÉDIO | Cadeia via INSERT direto no handoff (bypassa o guard da função) | Pré-check de cadeia no handoff (Task 11 Step 3) |
| 3 | MÉDIO | `consolidar_demanda_sku` setava só `tipo_reposicao`; o descontinuar canônico reseta 2 campos (espelho do `reativarPayload`) | Função + handoff + assert F2b setam `tipo_reposicao='descontinuado'` **E** `habilitado_reposicao_automatica=false` |
| 4 | BAIXO | `sku_codigo_novo::bigint` quebraria o recompute inteiro se não-numérico | Guard `~ '^\d+$'` no JOIN da efetiva + `ZR003` no cadastro |

**Codex rodado (xhigh) — achados acima incorporados e re-provados (E/F/H verdes).** Revisão independente cumprida (não pendente). A escritora `atualizar_parametros_numericos_skus` NÃO foi recriada no harness, mas o Codex a analisou por leitura e o fusível `segurado` está tratado no handoff (Step 4b).
- [ ] **Step 2: Challenge (xhigh)** — pedir para tentar QUEBRAR: dupla contagem, NULL-blindness no JOIN, divergência de ordem de colunas no `CREATE OR REPLACE`, cadeia não coberta, empresa vazando, o COALESCE mascarando `sku_codigo_novo` inválido (cast `::bigint` de texto não numérico → erro no cálculo diário inteiro).
- [ ] **Step 3: Incorporar** os achados no `db/reposicao-consolidacao-demanda.sql` e nos testes; re-rodar o harness verde.

> Guard extra provável do challenge: `sku_codigo_novo` não-numérico quebraria `::bigint` na view (erro no recompute inteiro). Mitigar com CHECK/validação no cadastro (`p_sku_novo ~ '^\d+$'`) e/ou `NULLIF`/regex no JOIN. Adicionar teste se confirmado.

---

## Task 11: Handoff `lovable-db-operator` (founder cola no SQL Editor)

**Files:** `db/reposicao-consolidacao-demanda.sql` (final), bloco de handoff

- [ ] **Step 1: Pré-flight de novo, imediatamente antes** — re-rodar o dump da Task 0 (a prod pode ter mudado desde então; a última a recriar vence). Fazer diff contra o que o `db/reposicao-consolidacao-demanda.sql` assume; se divergiu, reconciliar.

- [ ] **Step 1b: GATE de mapas pré-existentes (achado do auto-challenge — CRÍTICO, precisão>recall)** — os redirects fazem **todo** registro `sku_substituicao` com `status='aplicada'` passar a consolidar demanda no destino. A feature antiga (`registrar_substituicao_sku`) também grava nessa tabela. Antes de aplicar os redirects, LISTAR e revisar:

```sql
SELECT empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, aplicado_em
FROM sku_substituicao WHERE status='aplicada' ORDER BY empresa, sku_codigo_antigo;
```

Se houver registro que NÃO deve consolidar demanda (semântica antiga), decidir: (a) migrar o status dele (ex.: `'aplicada_legado'`) para o de-para o ignorar, ou (b) confirmar que consolidar é o comportamento desejado para ele também. **Não aplicar os redirects sem passar por este gate.**
- [ ] **Step 2: Montar o bloco idempotente** — o `db/reposicao-consolidacao-demanda.sql` inteiro (efetiva + 5 redirects na ordem certa + `consolidar_demanda_sku`), tudo `CREATE OR REPLACE`, seguro para colar de uma vez.
- [ ] **Step 3: Cadastro dos 2 mapas do founder — INSERT/UPDATE DIRETO (não a função)**

⚠️ `consolidar_demanda_sku` é SECURITY DEFINER staff-gated → no SQL Editor daria **42501** (database.md §5). O **trigger** `sku_substituicao_consolidacao_guard` protege o INSERT direto (canonicaliza, barra auto-ref/cadeia). Códigos de prod (confirmados no pré-flight 2026-07-05): `DFZ.8040LT`=**11978465816**, `DFA.4080LT`=**12101724100** (destino), `DFA.4128LT`=`11892839175`.

```sql
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status, aplicado_em, data_substituicao) VALUES
  ('OBEN', '11978465816', '12101724100', 'consolidar_demanda', 'aplicada', now(), CURRENT_DATE),
  ('OBEN', '11892839175', '12101724100', 'consolidar_demanda', 'aplicada', now(), CURRENT_DATE)
ON CONFLICT (empresa, sku_codigo_antigo, status)
DO UPDATE SET sku_codigo_novo   = EXCLUDED.sku_codigo_novo,
              acao_parametros   = 'consolidar_demanda',
              data_substituicao = CURRENT_DATE,
              aplicado_em       = now();

-- descontinua os antigos — os DOIS campos (espelho do reativarPayload; motor barra por tipo):
UPDATE sku_parametros SET tipo_reposicao='descontinuado', habilitado_reposicao_automatica=false
 WHERE empresa='OBEN' AND sku_codigo_omie IN (11978465816, 11892839175);
```

> Pré-condição confirmada no Step 1b: `sku_substituicao` estava **vazia** (nenhum mapa legado). Destino `12101724100` deve estar ativo/comprável em `sku_parametros` (a função valida via `ZR004`; o INSERT direto assume que sim — confirmar).

- [ ] **Step 4: Validação pós-apply** (eu rodo via `psql-ro`, ou o founder cola)

```sql
SELECT sku_codigo_omie, demanda_total_90d, demanda_media_diaria
FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie = 12101724100;
-- esperado: total = soma das vendas 90d de 12101724100 + 11978465816 + 11892839175
SELECT sku_codigo_omie, tipo_reposicao, habilitado_reposicao_automatica
FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie IN (11978465816, 11892839175);
-- esperado: ambos 'descontinuado' + habilitado_reposicao_automatica=false
```

- [ ] **Step 4b: APROVAR o parâmetro do 4080 (fusível `segurado` — Codex P1) — CRÍTICO**

A consolidação faz a demanda do 4080 saltar ~3,5× → no próximo recompute a escritora `atualizar_parametros_numericos_skus` marca o 4080 como **`segurado`** (fusível anti-mudança-brusca >3×) e **NÃO aplica** o novo `ponto_pedido`/`estoque_maximo`. Se ficar assim, o motor não redimensiona → **ruptura** (o que queríamos evitar). Após o recompute (roda a cada 2h, ou force pela tela), verificar:

```sql
SELECT empresa, sku_codigo_omie, status, ponto_pedido_antes, ponto_pedido_depois,
       estoque_maximo_antes, estoque_maximo_depois
FROM reposicao_param_auto_log
WHERE empresa='OBEN' AND sku_codigo_omie='12101724100' ORDER BY id DESC LIMIT 3;
```

→ Se `status='segurado'`, **aprovar** a mudança do 4080 em **Reposição → Mudanças automáticas** (é o gate humano money-path para a alta de 3,5×). Só então o ponto de pedido sobe e o motor compra pelo giro somado.

- [ ] **Step 5: Registrar no diário** — `docs/historico/` (entrega + verificação), e sinalizar que a Frente C (UX) segue em plano separado.

---

## Fora de escopo (→ plano separado): Frente C (UX)

Botão "Consolidar demanda em outro SKU" no `SkuDetailSheet` (aba "Ajuste manual", `AdminReposicaoRevisao`), chamando `consolidar_demanda_sku` via `supabase.rpc`. Sem dependência de status Omie (funciona com item ativo). Apontar o gráfico 90d do `SkuDetailSheet` para `v_venda_items_history_efetivo` para o destino refletir os três. Testes vitest. Deploy Lovable Publish. Escrever com `writing-plans` quando a Fase SQL estiver em produção e verificada.

---

## Self-Review (writing-plans)

**1. Cobertura da spec:**
- Spec §3 Frente A (mapa) → Task 9 (grava `sku_substituicao` aplicada). ✅
- Spec §3 Frente B (de-para no cálculo) → Tasks 2–7 (efetiva + 5 redirects). ✅
- Spec §3 Frente C (UX) → explicitamente plano separado. ✅ (decisão "só consolidação estrutural")
- Spec §4 decisões: 1:1 (soma direta, sem fator — seed usa soma pura) ✅; reusa `sku_substituicao` ✅; não consolida estoque (nenhuma task toca estoque) ✅; consolidar descontinua o antigo (Task 9) ✅; cadastro isolado numa função ✅.
- Spec §6 guards: auto-ref (Task 8+9), cadeia (Task 9), dupla contagem (Task 8 auto-ref + `IN`), reversível (`status<>'aplicada'` some — coberto pela semântica do JOIN, provar como extra se o Codex pedir), antigo ativo vendendo (seed do 8040 é "ativo"; conta pro destino — Task 3), empresa-aware (Task 8). ✅ (reversível: **adicionar assert explícito** — ver lacuna abaixo)
- Spec §7 prova: PG17 + falsificação (Task 8) + Codex (Task 10) + handoff (Task 11). ✅

**2. Lacuna encontrada → corrigir:** o assert de **reversibilidade** (mudar status para `<>'aplicada'` → deixa de contar) não tem step próprio. **Fix inline:** adicionar à Task 8 um Step: `UPDATE sku_substituicao SET status='revertida' WHERE sku_codigo_antigo='8040'` → asserir que 8040 volta a aparecer em `v_sku_demanda_estatisticas` com total=45 e o destino cai para 270. (Registrar aqui; incorporar ao harness na execução.)

**3. Placeholder scan:** os `<codigo_omie_*>` na Task 11 são **valores a obter no pré-flight** (dados de prod), não placeholders de lógica — marcados com a fonte exata (ilike/founder). A ordem de colunas dos redirects referencia a saída da Task 0 (verbatim de prod), que é a sequência money-path correta, não um "TODO". Nenhum "add error handling"/"handle edge cases" solto.

**4. Consistência de tipos:** `sku_codigo_omie` bigint na tabela; `sku_codigo_antigo/novo` text em `sku_substituicao` → cast `::bigint`/`::text` explícito e consistente na efetiva e na função. `consolidar_demanda_sku(text,text,text)` chamada com os 3 args em todas as ocorrências. ✅

---

## Execution Handoff

Plano salvo. Como este é money-path e o gargalo imediato é o pré-flight `psql-ro` (classificador de Bash intermitente hoje), a execução começa pela **Task 0** assim que a janela abrir. Sugiro **execução inline com checkpoints** (não subagente): cada view recriada é um ponto de verificação money-path que eu quero inspecionar (ordem de colunas, verbatim de prod) antes de seguir. Confirmar preferência.
