#!/usr/bin/env bash
# Teste PG17 da FÓRMULA CANÔNICA tintométrica (Fase 2 + 2b + fix semântico +
# allowlist + piso legado — v_tint_formula_canonica). Aplica schema-snapshot +
# as migrations 20260718213000_tint_formula_canonica.sql, 20260718233000_tint_
# canonica_preco_csv_legado.sql, 20260722100002_tint_canonica_csv_legado_
# semantico.sql, 20260724130000_tint_canonica_csv_legado_allowlist.sql E
# 20260726160000_tint_canonica_piso_legado.sql NA
# ORDEM (prova a cadeia de REPLACEs que prod executa),
# semeia gêmeas SL×SAYERLACK controladas e prova (com falsificação):
#   C1  preferência: SL válida vence SAYERLACK válida na mesma chave
#   C2  fallback: SL SEM receita → SAYERLACK válida vence
#   C3  não-desaparecimento das "12": só-SAYERLACK em SKU órfão segue servida
#   C4  personalizada (subcolecao NULL) aparece
#   C5  ambas inválidas → SL (linha viva) vence a congelada
#   C6  fallback por corante quebrado/órfão: SL inválida → SAYERLACK vence
#   C7  base indisponível NÃO muda a preferência (validade é POR FÓRMULA)
#   C8  não-desaparecimento GLOBAL: 1 linha por chave ativa-com-sku, sem sobra
#   C9  determinismo: duas leituras idênticas
#   C10 paridade do espelho: receita_valida ∧ base_disponivel ⟺ precoFinal da
#       RPC get_tint_prices REAL (aplicada do snapshot) não-nulo
#   C11 RLS/invoker: staff vê; customer/sem-role 0 linhas; anon 42501; service_role vê
#   F1  falsificação: rank invertido → derruba {C1,C7,C14}
#   F2  falsificação: espelho de corantes frouxo (>=0) → derruba {C6,C10}
#   F3  falsificação: sem o anti-join → derruba {C8,C2,C6,C6b,C6c,C6d,C12,C15,C19}
#   F4  falsificação: tie-break invertido → derruba {C12}
#   C13 (2b) preco_csv_legado: SL canônica expõe o CSV da gêmea antiga; fallback
#       expõe o próprio; chave sem CSV → NULL (a fonte "Tabela" da vendedora)
#   F5  falsificação: preco_csv_legado lendo só a própria linha → derruba
#       {C13,C14,C15,C16,C17,C18,C19,C20} (toda a família do CSV)
#   C14 (fix semântico) FUTURE-PROOF: SL canônica com CSV PRÓPRIO populado →
#       o max IGNORA o próprio e segue devolvendo o da gêmea não-SL
#   C15 (fix semântico) ramo não-SL intacto: canônica não-SL segue com o max
#       de TODAS as ativas (inclusive uma SL com CSV — comportamento da 2b)
#   F6  falsificação: expressão da 2b de volta → derruba {C14,C16,C17,C19,C20}
#   F7  falsificação: allowlist INCONDICIONAL (sem o guard is_sl) → derruba {C15}
#   C16 (allowlist) 2ª linha SL com CSV na MESMA chave fica fora do max — TODA
#       SL fica fora, não só a própria. Mata o mutante `g2.id <> f.id` (achado 2
#       do challenge retroativo Codex 2026-07-20: passava C13/C14/C15 e F6/F7)
#   C17 (allowlist — FIXA a decisão do founder 2026-07-21) personalizada com CSV
#       em chave de canônica SL fica FORA do max (a blocklist antiga a incluía)
#   C18 linha DESATIVADA com CSV alto na chave fica fora do max (antes nenhum
#       seed exercitava o `desativada_em IS NULL` do max com CSV que mudasse o valor)
#   F8  falsificação: mutante `NOT rf.is_sl OR g2.id <> f.id` → derruba
#       {C16,C17,C19,C20}
#   F9  falsificação: blocklist não-SL de volta (20260722100002 verbatim) →
#       derruba {C17,C19,C20}
#   F10 falsificação: max sem `g2.desativada_em IS NULL` → derruba {C18}
#   ── challenge retroativo Codex xhigh 2026-07-21 sobre o #1505 ──
#   C19 GUARD DE CONTA: fórmula de 'colacor' apontando para a subcoleção '1' de
#       'oben' NÃO alimenta o max (a FK não inclui account; quem barra é o
#       `s2.account = g2.account`). Harness era monoconta — nada o exercia.
#   C20 EXCLUSIVIDADE DO LITERAL '1': subcoleções '2'/'10'/rótulo-NULL na chave
#       ficam fora. Com só 'SL' e '1' semeados, 4 mutantes eram indistinguíveis
#       da allowlist real (`<> 'SL'`, `IN ('1','2')`, `LIKE '1%'`, `COALESCE`).
#   F11 falsificação: allowlist sem `s2.account = g2.account` → derruba {C19}
#   F12 falsificação: `<> 'SL'` no lugar de `= '1'` → derruba {C20}
#   F13 falsificação: `IN ('1','2')` → derruba {C20}
#   ── separação RÓTULO × PISO (follow-up do challenge Codex no #1523) ──
#   A 14ª coluna `preco_piso_legado` existe porque a 13ª servia dois donos com
#   necessidades OPOSTAS: o RÓTULO do balcão quer PRECISÃO DE PROVENIÊNCIA (só
#   a geração '1'), o PISO do gate de submit quer CONSERVADORISMO (toda linha
#   ativa). Encolher o max para dar precisão ao rótulo REDUZIA o piso do gate.
#   ⚠️ E o spec óbvio ("max de todas as ativas") está ERRADO: como o gate faz
#   LEAST(v_calc, COALESCE(v_tab, v_calc)), v_tab NULL dá o piso MAIS ALTO, e
#   trocar NULL por um número AFROUXA. Daí o NULL-preserving. Medido em prod
#   (2026-07-21): 6,3% das chaves com SL ativa (31.062 de 495.057) não têm
#   geração '1' — é a população que o spec ingênuo afrouxaria.
#   C21 K18 o CASO DO CODEX: rótulo=290 (allowlist) mas piso=500 (a
#       personalizada entra no piso e não no rótulo) — a divergência que motiva
#       a coluna
#   C22 K17 2ª linha SL entra no piso (800) e segue fora do rótulo (280)
#   C23 K19 DESATIVADA fica fora dos DOIS (300/300) — o piso herda o filtro
#   C24 K21 subcoleções futuras entram no piso (880), fora do rótulo (330)
#   C25 K20 linha cross-account entra no piso (850) — o piso não filtra
#       subcoleção, então o guard de conta do rótulo não se aplica aqui
#   C26 K22 NULL-PRESERVING (o coração): sem geração '1' provada na chave,
#       csv=NULL ⇒ piso=NULL. Devolver 700 aqui derruba o piso do gate de
#       v_calc para 700 — AFROUXA. É o assert que separa o spec certo do óbvio
#   C27 K16 ramo não-SL: piso ≡ csv (a allowlist nem dispara)
#   C28 INVARIANTE I1 global: (csv IS NULL) ⟺ (piso IS NULL) — guarda de DRIFT
#       entre as 2 cópias da subquery do csv na migration
#   C29 INVARIANTE I2 global: piso >= csv (max de um SUPERconjunto)
#   C30 SHAPE: as 13 colunas na ordem exata + a 14ª só ACRESCENTADA no fim
#   C31 security_invoker=on sobreviveu ao REPLACE (armadilha #1375)
#   F14 falsificação: spec INGÊNUO (sem o NULL-preserving) → derruba {C26,C28}
#   F15 falsificação: piso com a allowlist (vira cópia do rótulo) → derruba
#       {C21,C22,C24,C25}
#   F16 falsificação: piso sem `desativada_em` → derruba {C23}
#   ⚠️ C21-C31 vivem em `run_asserts_piso`, SEPARADO de `run_asserts`: as 10
#   views sabotadas de F1-F10 são recriadas à mão com 13 colunas, e fazer
#   `run_asserts` ler a 14ª mataria todas em "column does not exist" —
#   sabotagem que muda o alvo E o shape não isola o que prova. Em F14-F16 o
#   inverso é VERIFICADO: C1-C20 têm de seguir verdes (`piso_isolado`).
#   R   restauração: re-aplica a migration REAL → tudo verde de novo
#
# ⚠️ CONTRATO DAS FALSIFICAÇÕES: cada uma declara o CONJUNTO EXATO de asserts que
# derruba (nomes + contagem), conferido por `confere_falsificacao`. Até
# 2026-07-21 cada F afirmava "vermelho certo, E SÓ ELE" — inverificável, porque
# o bloco abortava no 1º RAISE e o `case` só via o primeiro nome. Ao instrumentar
# (acumular em vez de abortar), a medição mostrou que 7 das 10 derrubavam MAIS de
# um assert: a alegação era falsa e ninguém podia saber. Se um conjunto mudar, ou
# a sabotagem passou a atingir além do alvo, ou um assert perdeu o dente — as
# duas coisas exigem olhar, não ajustar o número.
# Base estrutural: db/test-tint-promote.sh + db/test-tint-formulas-rls-initplan.sh.
# Pré-req: brew install postgresql@17 pgvector.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/supabase/migrations/20260718213000_tint_formula_canonica.sql"
MIGRATION2="$REPO_ROOT/supabase/migrations/20260718233000_tint_canonica_preco_csv_legado.sql"
MIGRATION3="$REPO_ROOT/supabase/migrations/20260722100002_tint_canonica_csv_legado_semantico.sql"
MIGRATION4="$REPO_ROOT/supabase/migrations/20260724130000_tint_canonica_csv_legado_allowlist.sql"
MIGRATION5="$REPO_ROOT/supabase/migrations/20260726160000_tint_canonica_piso_legado.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5447
DATA="$(mktemp -d /tmp/pgtest-tintcanonica.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIGRATION" ] || { echo "migration ausente: $MIGRATION"; exit 1; }
[ -f "$MIGRATION2" ] || { echo "migration ausente: $MIGRATION2"; exit 1; }
[ -f "$MIGRATION3" ] || { echo "migration ausente: $MIGRATION3"; exit 1; }
[ -f "$MIGRATION4" ] || { echo "migration ausente: $MIGRATION4"; exit 1; }
[ -f "$MIGRATION5" ] || { echo "migration ausente: $MIGRATION5"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-tintcanonica.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres canonica_verify
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d canonica_verify -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# Confere uma falsificação: a sabotagem tem de derrubar EXATAMENTE os asserts
# nomeados — nem menos (assert sem dente), nem mais (sabotagem que mexe em mais
# de uma coisa e não isola o que prova). Antes do challenge Codex xhigh
# (2026-07-21, achado (e)) cada falsificação afirmava "vermelho CERTO, e só ele"
# e isso era ESTRUTURALMENTE inverificável: o bloco abortava no 1º RAISE, então
# o `case` só enxergava o PRIMEIRO nome e a contagem nunca era olhada.
# uso: confere_falsificacao <rotulo> <out> <n_esperado> <Cx> [Cy …] -- <descricao>
confere_falsificacao() {
  local rot="$1" out="$2" n_esp="$3"; shift 3
  local desc="" n_real faltando="" c; local -a nomes=()
  while [ $# -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; desc="$*"; break; fi
    nomes+=("$1"); shift
  done
  case "$out" in
    *TODOS_OK*) bad "$rot NAO pegou: asserts VERDES sob a sabotagem (sem dente) — $desc"; return ;;
  esac
  n_real="$(printf '%s' "$out" | sed -n 's/.*FALHAS\[\([0-9]\{1,\}\)\].*/\1/p' | head -1)"
  if [ -z "$n_real" ]; then
    bad "$rot quebrou FORA do contrato de asserts (sem FALHAS[n] — erro SQL?): $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-180)"; return
  fi
  for c in "${nomes[@]}"; do
    case "$out" in *"$c FALHOU"*) ;; *) faltando="$faltando $c" ;; esac
  done
  if [ -n "$faltando" ]; then
    bad "$rot nao derrubou o(s) assert(s) alvo:$faltando (veio FALHAS[$n_real]) — $desc"; return
  fi
  local caidos
  caidos="$(printf '%s' "$out" | tr '|' '\n' | sed -n 's/.*\(C[0-9]\{1,2\}[a-z]*\) FALHOU.*/\1/p' | tr '\n' ' ')"
  if [ "$n_real" != "$n_esp" ]; then
    bad "$rot derrubou $n_real assert(s) [$caidos], esperado $n_esp [${nomes[*]}] — o CONJUNTO mudou: ou a sabotagem atinge alem do alvo, ou um assert perdeu o dente"; return
  fi
  ok "$rot pegou a sabotagem: FALHAS[$n_real] = [$caidos] — $desc"
}

RR="$(mktemp "${TMPDIR:-/tmp}/snap-tintcanonica.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" || { echo "FALHA no setup: stubs"; exit 1; }
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" || { echo "FALHA no setup: prelude"; exit 1; }
P --single-transaction -q -f "$RR" >/dev/null || { echo "FALHA no setup: snapshot"; exit 1; }
rm -f "$RR"

echo "→ migrations 20260718213000 + 20260718233000 + 20260722100002 + 20260724130000 + 20260726160000 na ordem de prod (cadeia de REPLACEs)…"
# ⚠️ O snapshot AGORA traz a view pronta (13 colunas) — desde o re-dump do #1509
# (2026-07-21). Antes disso o snapshot era de junho, anterior à view, e a cadeia
# aplicava no vazio. Sem este DROP, a Fase 2 (12 colunas) morre em "cannot drop
# columns from view" e o harness inteiro para ANTES do primeiro assert — foi o
# estado da main entre o #1509 e 2026-07-21 (db/test-*.sh não roda no CI, então
# nada acusou). O objetivo é provar a CADEIA a partir do zero, não o snapshot.
P -q -c "DROP VIEW IF EXISTS public.v_tint_formula_canonica;" >/dev/null \
  || { echo "FALHA: não removeu a view do snapshot antes da cadeia"; exit 1; }
P -q -f "$MIGRATION" >/dev/null  || { echo "FALHA: migration Fase 2 não aplicou"; exit 1; }
P -q -f "$MIGRATION2" >/dev/null || { echo "FALHA: migration Fase 2b não aplicou"; exit 1; }
P -q -f "$MIGRATION3" >/dev/null || { echo "FALHA: migration fix semântico não aplicou"; exit 1; }
P -q -f "$MIGRATION4" >/dev/null || { echo "FALHA: migration allowlist não aplicou"; exit 1; }
P -q -f "$MIGRATION5" >/dev/null || { echo "FALHA: migration piso legado não aplicou"; exit 1; }

# Restaura a view REAL (5 migrations na ordem). DROP antes: as views sabotadas
# das falsificações têm shape divergente e REPLACE não remove/reordena coluna.
restore_view() {
  if ! P -q -c "DROP VIEW IF EXISTS public.v_tint_formula_canonica;" >/dev/null \
     || ! P -q -f "$MIGRATION" >/dev/null \
     || ! P -q -f "$MIGRATION2" >/dev/null \
     || ! P -q -f "$MIGRATION3" >/dev/null \
     || ! P -q -f "$MIGRATION4" >/dev/null \
     || ! P -q -f "$MIGRATION5" >/dev/null; then
    echo "FALHA: restore_view não re-aplicou as migrations"; exit 1
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# SEEDS — gêmeas controladas. UUIDs determinísticos (sufixo = papel).
#   Subcoleções: SL / '1' (SAYERLACK). Corantes: OK (200, ativo), RUIM (valor 0),
#   SEM_OMIE. SKUs: OK (omie ativo 100), ORFAO (sem omie), INATIVO (omie inativo).
# ══════════════════════════════════════════════════════════════════════════════
echo "→ seeds…"
P -q <<'SQL' || { echo "FALHA no seed"; exit 1; }
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('33333333-3333-3333-3333-333333333333','customer') ON CONFLICT DO NOTHING;

INSERT INTO public.tint_subcolecoes (id, account, id_subcolecao_sayersystem, descricao) VALUES
  ('5c000000-0000-0000-0000-000000000001','oben','SL','SL'),
  ('0d000000-0000-0000-0000-000000000001','oben','1','SAYERLACK'),
  -- Subcoleções FUTURAS + rótulo NULL (challenge Codex xhigh 2026-07-21 sobre o
  -- #1505, achado (a)-2): com só 'SL' e '1' no seed, "allowlist da '1'" era
  -- indistinguível de `<> 'SL'`, `IN ('1','2')`, `LIKE '1%'` e
  -- `COALESCE(id_subcolecao_sayersystem,'1')='1'` — 4 mutantes passavam TUDO.
  -- '10' existe para matar o LIKE; o rótulo NULL para matar o COALESCE
  -- (id_subcolecao_sayersystem é NULLABLE em prod).
  ('02000000-0000-0000-0000-000000000002','oben','2','FUTURA 2'),
  ('10000000-0000-0000-0000-000000000010','oben','10','FUTURA 10'),
  ('0e000000-0000-0000-0000-00000000000e','oben',NULL,'SEM CODIGO'),
  -- 2ª CONTA (achado (a)-1): a FK de tint_formulas.subcolecao_id referencia
  -- tint_subcolecoes(id) SEM account, então nada no banco impede uma fórmula de
  -- 'colacor' apontar para a subcoleção de 'oben'. O guard `s2.account =
  -- g2.account` da allowlist é quem barra — e nenhum seed o exercia.
  ('c1000000-0000-0000-0000-00000000005a','colacor','SL','COLACOR SL'),
  ('c1000000-0000-0000-0000-000000000001','colacor','1','COLACOR SAYERLACK');

INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, valor_unitario, ativo, account) VALUES
  ('0b000000-0000-0000-0000-00000000ba5e', 900001,'BASE-OK','Base OK',      100, true , 'oben'),
  ('0b000000-0000-0000-0000-00000000ba5f', 900002,'BASE-IN','Base inativa', 100, false, 'oben'),
  ('0c000000-0000-0000-0000-0000000c0c01', 900003,'COR-OK','Corante OK',    200, true , 'oben'),
  ('0c000000-0000-0000-0000-0000000c0c02', 900004,'COR-Z','Corante zero',     0, true , 'oben'),
  ('0c000000-0000-0000-0000-0000000c0c03', 900005,'COR-IN','Corante inativo',200, false, 'oben');

INSERT INTO public.tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','oben','WPOK','Corante OK',   810, '0c000000-0000-0000-0000-0000000c0c01'),
  ('c0000000-0000-0000-0000-000000000002','oben','WPRU','Corante RUIM', 810, '0c000000-0000-0000-0000-0000000c0c02'),
  ('c0000000-0000-0000-0000-000000000003','oben','WPSO','Sem omie',     810, NULL),
  ('c0000000-0000-0000-0000-000000000004','oben','WPIN','Omie inativo', 810, '0c000000-0000-0000-0000-0000000c0c03'),
  ('c0000000-0000-0000-0000-000000000005','oben','WPV0','Volume zero',    0, '0c000000-0000-0000-0000-0000000c0c01');

INSERT INTO public.tint_produtos  (id, account, cod_produto, descricao) VALUES
  ('a0000000-0000-0000-0000-000000000001','oben','P1','Produto 1'),
  ('c1100000-0000-0000-0000-000000000001','colacor','P1','Produto 1 COLACOR');
INSERT INTO public.tint_bases     (id, account, id_base_sayersystem, descricao) VALUES
  ('a0000000-0000-0000-0000-000000000002','oben','B1','Base 1'),
  ('c1100000-0000-0000-0000-000000000002','colacor','B1','Base 1 COLACOR');
-- 3 embalagens: a UNIQUE de tint_skus é (account, produto, base, embalagem) —
-- cada SKU do seed precisa da sua.
INSERT INTO public.tint_embalagens(id, account, id_embalagem_sayersystem, descricao, volume_ml) VALUES
  ('a0000000-0000-0000-0000-0000000000e1','oben','E900A','Galao 900A',900),
  ('a0000000-0000-0000-0000-0000000000e2','oben','E900B','Galao 900B',900),
  ('a0000000-0000-0000-0000-0000000000e3','oben','E900C','Galao 900C',900),
  ('c1100000-0000-0000-0000-0000000000e1','colacor','E900A','Galao 900A COLACOR',900);

INSERT INTO public.tint_skus (id, account, produto_id, base_id, embalagem_id, omie_product_id) VALUES
  ('c1500000-0000-0000-0000-00000000000a','colacor','c1100000-0000-0000-0000-000000000001','c1100000-0000-0000-0000-000000000002','c1100000-0000-0000-0000-0000000000e1',NULL),
  ('50000000-0000-0000-0000-00000000000a','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-00000000000b','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2',NULL),
  ('50000000-0000-0000-0000-00000000000c','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e3','0b000000-0000-0000-0000-00000000ba5f');

-- Fórmulas: id sufixo f1SL/f1SA etc. Todas mesmo produto/base/embalagem (a unique
-- key diferencia por cor_id+subcoleção — como em prod). sku define a CHAVE da view.
INSERT INTO public.tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id, preco_final_sayersystem) VALUES
  -- K1 AZUL @SKU_OK: SL válida × SAYERLACK válida → SL vence
  ('f1000000-0000-0000-0000-00000000005a','oben','K1','AZUL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f1000000-0000-0000-0000-000000000019','oben','K1','AZUL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',150),
  -- K2 VERDE @SKU_OK: SL SEM receita × SAYERLACK válida → SAYERLACK vence
  ('f2000000-0000-0000-0000-00000000005a','oben','K2','VERDE','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f2000000-0000-0000-0000-000000000019','oben','K2','VERDE','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',160),
  -- K3 DOURADO @SKU_ORFAO: só SAYERLACK com receita (as "12"/ACR MAX) → servida
  ('f3000000-0000-0000-0000-000000000019','oben','K3','DOURADO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000b',170),
  -- K4 PERS @SKU_OK: personalizada (subcolecao NULL) com receita → servida
  ('f4000000-0000-0000-0000-0000000000e0','oben','K4','PERS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1',NULL,'50000000-0000-0000-0000-00000000000a',NULL),
  -- K5 CINZA @SKU_OK: SL sem receita × SAYERLACK sem receita → SL (viva) vence
  ('f5000000-0000-0000-0000-00000000005a','oben','K5','CINZA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f5000000-0000-0000-0000-000000000019','oben','K5','CINZA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',180),
  -- K6 ROXO @SKU_OK: SL com corante RUIM (inválida) × SAYERLACK válida → SAYERLACK
  ('f6000000-0000-0000-0000-00000000005a','oben','K6','ROXO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f6000000-0000-0000-0000-000000000019','oben','K6','ROXO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',190),
  -- K7 LARANJA @SKU_INATIVO: SL válida × SAYERLACK válida → SL (base fora do rank)
  ('f7000000-0000-0000-0000-00000000005a','oben','K7','LARANJA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e3','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000c',NULL),
  ('f7000000-0000-0000-0000-000000000019','oben','K7','LARANJA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e3','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000c',200),
  -- K8 PRETO @SKU_OK: SL com corante SEM OMIE (inválida) × SAYERLACK válida → SAYERLACK
  ('f8000000-0000-0000-0000-00000000005a','oben','K8','PRETO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f8000000-0000-0000-0000-000000000019','oben','K8','PRETO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',210),
  -- K9 BRANCO @SKU_OK: só SL válida (sem gêmea) → servida
  ('f9000000-0000-0000-0000-00000000005a','oben','K9','BRANCO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  -- K10 MARROM @SKU_OK: só SL com corante RUIM → canônica INVÁLIDA (paridade: RPC nula)
  ('fa000000-0000-0000-0000-00000000005a','oben','K10','MARROM','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  -- K11 DESAT @SKU_OK: SL DESATIVADA × SAYERLACK ativa válida → SAYERLACK (desativada fora do jogo)
  ('fb000000-0000-0000-0000-00000000005a','oben','K11','DESAT','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('fb000000-0000-0000-0000-000000000019','oben','K11','DESAT','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',220),
  -- K12 EMPATE @SKU_OK: SAYERLACK válida (uuid MAIOR, inserida ANTES) × personalizada
  -- válida (uuid MENOR, inserida DEPOIS) → mesmo rank 1 → menor uuid (fc…) vence.
  -- Prova que o desempate é id ASC, não ordem física nem semântica não-decidida.
  ('fd000000-0000-0000-0000-000000000019','oben','K12','EMPATE','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',230),
  ('fc000000-0000-0000-0000-0000000000e0','oben','K12','EMPATE','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2',NULL,'50000000-0000-0000-0000-00000000000a',NULL),
  -- K13/K14: cada condição do espelho de corantes com o próprio cenário — omie
  -- INATIVO (K13) e volume_total_ml=0 (K14) invalidam a SL → SAYERLACK vence.
  ('f0130000-0000-0000-0000-00000000005a','oben','K13','OMIEINATIVO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0130000-0000-0000-0000-000000000019','oben','K13','OMIEINATIVO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',240),
  ('f0140000-0000-0000-0000-00000000005a','oben','K14','VOLZERO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0140000-0000-0000-0000-000000000019','oben','K14','VOLZERO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',250),
  -- K15 FUTURO @SKU_OK (fix semântico): SL VÁLIDA com CSV PRÓPRIO 999 (o cenário
  -- future-proof — sync populando preco_final_sayersystem na SL) × SAYERLACK
  -- válida com CSV 260 → canônica = SL; preco_csv_legado = 260 (NUNCA o próprio 999)
  ('f0150000-0000-0000-0000-00000000005a','oben','K15','FUTURO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',999),
  ('f0150000-0000-0000-0000-000000000019','oben','K15','FUTURO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',260),
  -- K16 NAOSL @SKU_OK (fix semântico): SL SEM receita com CSV 400 (rank 2) ×
  -- SAYERLACK válida com CSV 270 (rank 1) → canônica = SAYERLACK (não-SL);
  -- preco_csv_legado = 400 (o max segue incluindo a SL — ramo não-SL intacto)
  ('f0160000-0000-0000-0000-00000000005a','oben','K16','NAOSL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',400),
  ('f0160000-0000-0000-0000-000000000019','oben','K16','NAOSL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',270),
  -- K17 DUASSL @SKU_OK (allowlist): SL canônica válida × 2ª linha SL (MESMA
  -- subcoleção SL, embalagem e2 — a unique de subcoleções impede 2 rótulos 'SL')
  -- com CSV 800 × '1' com CSV 280 → preco_csv_legado = 280 (TODA SL fora do max,
  -- não só a própria — é o seed que mata o mutante `g2.id <> f.id`)
  ('f0170000-0000-0000-0000-00000000005a','oben','K17','DUASSL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0170000-0000-0000-0000-00000000005b','oben','K17','DUASSL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',800),
  ('f0170000-0000-0000-0000-000000000019','oben','K17','DUASSL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',280),
  -- K18 PERSCSV @SKU_OK (allowlist — FIXA a decisão do founder 2026-07-21):
  -- SL canônica válida × personalizada (subcolecao NULL) com CSV 500 × '1' com
  -- CSV 290 → preco_csv_legado = 290 (personalizada NUNCA alimenta o rótulo
  -- "Tabela (versão anterior)"; a blocklist antiga devolveria 500)
  ('f0180000-0000-0000-0000-00000000005a','oben','K18','PERSCSV','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0180000-0000-0000-0000-0000000000e0','oben','K18','PERSCSV','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2',NULL,'50000000-0000-0000-0000-00000000000a',500),
  ('f0180000-0000-0000-0000-000000000019','oben','K18','PERSCSV','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',290),
  -- K19 DESATCSV @SKU_OK: SL canônica válida × '1' ativa CSV 300 × '1'
  -- DESATIVADA (embalagem e2) com CSV 900 → preco_csv_legado = 300 (o filtro
  -- desativada_em do max tem seed próprio; antes nenhum CSV de desativada
  -- mudava o valor esperado)
  ('f0190000-0000-0000-0000-00000000005a','oben','K19','DESATCSV','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0190000-0000-0000-0000-000000000019','oben','K19','DESATCSV','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',300),
  ('f0190000-0000-0000-0000-00000000001a','oben','K19','DESATCSV','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',900),
  -- K20 MULTIACCOUNT @conta 'colacor' (challenge Codex 2026-07-21, achado (a)-1):
  -- SL canônica de colacor × '1' de COLACOR com CSV 320 × linha de colacor que
  -- aponta para a subcoleção '1' de OBEN com CSV 850. Esperado 320 — o 850 só
  -- entra se o guard `s2.account = g2.account` sumir. A FK não impede a
  -- referência cross-account (REFERENCES tint_subcolecoes(id), sem account).
  ('f0200000-0000-0000-0000-00000000005a','colacor','K20','MULTIACCOUNT','c1100000-0000-0000-0000-000000000001','c1100000-0000-0000-0000-000000000002','c1100000-0000-0000-0000-0000000000e1','c1000000-0000-0000-0000-00000000005a','c1500000-0000-0000-0000-00000000000a',NULL),
  ('f0200000-0000-0000-0000-000000000019','colacor','K20','MULTIACCOUNT','c1100000-0000-0000-0000-000000000001','c1100000-0000-0000-0000-000000000002','c1100000-0000-0000-0000-0000000000e1','c1000000-0000-0000-0000-000000000001','c1500000-0000-0000-0000-00000000000a',320),
  ('f0200000-0000-0000-0000-0000000000ac','colacor','K20','MULTIACCOUNT','c1100000-0000-0000-0000-000000000001','c1100000-0000-0000-0000-000000000002','c1100000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','c1500000-0000-0000-0000-00000000000a',850),
  -- K21 FUTURAS @SKU_OK (challenge Codex 2026-07-21, achado (a)-2): SL canônica
  -- × '1' CSV 330 × '2' CSV 860 × '10' CSV 870 × rótulo NULL CSV 880.
  -- Esperado 330. Mata de uma vez os 4 mutantes que passavam C1-C18/F1-F10:
  --   `<> 'SL'`            → deixaria entrar 2/10/NULL → 880
  --   `IN ('1','2')`       → deixaria entrar a '2'     → 860
  --   `LIKE '1%'`          → deixaria entrar a '10'    → 870
  --   `COALESCE(…,'1')='1'`→ deixaria entrar o NULL    → 880
  ('f0210000-0000-0000-0000-00000000005a','oben','K21','FUTURAS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0210000-0000-0000-0000-000000000019','oben','K21','FUTURAS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',330),
  ('f0210000-0000-0000-0000-000000000002','oben','K21','FUTURAS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','02000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-00000000000a',860),
  ('f0210000-0000-0000-0000-000000000010','oben','K21','FUTURAS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','10000000-0000-0000-0000-000000000010','50000000-0000-0000-0000-00000000000a',870),
  ('f0210000-0000-0000-0000-00000000000e','oben','K21','FUTURAS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0e000000-0000-0000-0000-00000000000e','50000000-0000-0000-0000-00000000000a',880),
  -- K22 SEMGEN1 @SKU_OK (correção do spec do piso — medição psql-ro 2026-07-21):
  -- SL canônica válida × personalizada com CSV 700 × NENHUMA linha da geração
  -- '1' na chave. preco_csv_legado = NULL (a allowlist não acha a '1') ⇒
  -- preco_piso_legado TAMBÉM NULL (NULL-preserving).
  -- É o seed que separa o spec CERTO do spec INGÊNUO: "max de TODAS as ativas"
  -- devolveria 700 aqui, e como o gate faz LEAST(v_calc, COALESCE(v_tab,
  -- v_calc)), trocar NULL por 700 DERRUBA o piso de v_calc para 700 — afrouxa
  -- em vez de apertar. Em prod isso é a população de 31.062 chaves (6,3% das
  -- 495.057 com SL ativa) que não têm geração '1' ativa.
  ('f0220000-0000-0000-0000-00000000005a','oben','K22','SEMGEN1','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0220000-0000-0000-0000-0000000000e0','oben','K22','SEMGEN1','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2',NULL,'50000000-0000-0000-0000-00000000000a',700);
UPDATE public.tint_formulas SET desativada_em = now()
 WHERE id IN ('fb000000-0000-0000-0000-00000000005a','f0190000-0000-0000-0000-00000000001a');

-- Receitas (ordem NOT NULL): OK = corante bom 10ml; RUIM inclui corante zero; SEM_OMIE órfão.
INSERT INTO public.tint_formula_itens (formula_id, corante_id, ordem, qtd_ml) VALUES
  ('f1000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f1000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f2000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f3000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f4000000-0000-0000-0000-0000000000e0','c0000000-0000-0000-0000-000000000001',1,10),
  ('f6000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f6000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000002',2, 5),
  ('f6000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f7000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f7000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f8000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000003',1,10),
  ('f8000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f9000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('fa000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000002',1, 5),
  ('fb000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('fb000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('fd000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('fc000000-0000-0000-0000-0000000000e0','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0130000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000004',1,10),
  ('f0130000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0140000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000005',1,10),
  ('f0140000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0150000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0150000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0160000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0170000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0180000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0190000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  -- K20/K21: só a SL canônica precisa de receita válida (rank 0). O corante é o
  -- 'oben' OK — o espelho de corantes não filtra por account (junta por
  -- corante_id → omie), então serve à fórmula de colacor sem alterar o que K20
  -- prova (o guard de account da SUBCOLEÇÃO, não do corante).
  ('f0200000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0210000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  -- K22: só a SL canônica tem receita válida (rank 0) — a personalizada fica
  -- rank 3, então a canônica é a SL e o ramo da allowlist dispara.
  ('f0220000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10);

-- O dump do snapshot NÃO traz os GRANTs de tabela; em prod o Supabase concede a
-- authenticated/anon (RLS filtra). security_invoker exige privilégio do CALLER
-- nas relações subjacentes — espelha o estado de prod:
GRANT SELECT ON public.tint_formulas, public.tint_formula_itens, public.tint_corantes,
                public.tint_subcolecoes, public.tint_skus, public.omie_products
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ASSERT CENTRAL (reutilizado no baseline, nas falsificações e na restauração).
# Emite 'TODOS_OK' no fim; qualquer cenário quebrado RAISE com o nome (Cn).
# ══════════════════════════════════════════════════════════════════════════════
run_asserts() {
  P -tA 2>&1 <<'SQL'
-- ⚠️ ACUMULA as falhas em vez de abortar no PRIMEIRO RAISE (challenge Codex
-- xhigh 2026-07-21 sobre o #1505, achado (e)): com um único RAISE por bloco, o
-- `case` de cada falsificação só enxergava o nome do PRIMEIRO assert que caiu —
-- então "vermelho CERTO, e só ele" era ESTRUTURALMENTE inverificável, e virava
-- FALSO assim que uma sabotagem quebrasse 2 asserts (F8 quebra C16 e C20 com os
-- seeds novos). Agora o bloco varre TUDO e termina com
-- `FALHAS[n]: C.. | C..`, então a falsificação confere CONTAGEM e NOMES.
DO $$
DECLARE r record; n int; nf int; ni int; a text; b text; falhas text[] := '{}';
        c10_ok boolean := true; c10b_ok boolean := true;
BEGIN
  -- C0 pré-condição do SEED: sem isto, view vazia deixa os asserts por-cor
  -- passarem em NULL (teatro — foi exatamente o modo de falha do run 1).
  -- Segue ABORTANDO na hora (≠ demais asserts): seed errado torna todo o
  -- resto ruído, não sinal.
  -- 47/31 desde o seed K22 (piso NULL-preserving, 2026-07-21): +2 fórmulas
  -- (SL canônica + personalizada com CSV, sem geração '1' na chave) e +1 item.
  SELECT count(*) INTO nf FROM public.tint_formulas;
  SELECT count(*) INTO ni FROM public.tint_formula_itens;
  IF nf <> 47 OR ni <> 31 THEN
    RAISE EXCEPTION 'C0 FALHOU: seed incompleto (formulas=% esperado 47, itens=% esperado 31)', nf, ni; END IF;

  -- C8 não-desaparecimento GLOBAL primeiro (cardinalidade pega duplicata E omissão
  -- antes de qualquer SELECT por-cor devolver linha a mais/menos)
  SELECT count(*) INTO n FROM (
    SELECT account, sku_id, cor_id FROM public.tint_formulas
    WHERE desativada_em IS NULL AND sku_id IS NOT NULL
    EXCEPT
    SELECT account, sku_id, cor_id FROM public.v_tint_formula_canonica) x;
  IF n <> 0 THEN falhas := falhas || format('C8 FALHOU: %s chaves ativas AUSENTES da view', n); END IF;
  SELECT count(*) INTO n FROM (
    SELECT account, sku_id, cor_id FROM public.v_tint_formula_canonica
    EXCEPT
    SELECT account, sku_id, cor_id FROM public.tint_formulas
    WHERE desativada_em IS NULL AND sku_id IS NOT NULL) x;
  IF n <> 0 THEN falhas := falhas || format('C8 FALHOU: %s chaves na view SEM lastro na tabela', n); END IF;
  SELECT count(*) INTO n FROM (
    SELECT account, sku_id, cor_id FROM public.v_tint_formula_canonica
    GROUP BY 1,2,3 HAVING count(*) <> 1) x;
  IF n <> 0 THEN falhas := falhas || format('C8 FALHOU: %s chaves com != 1 linha na view (duplicata)', n); END IF;

  -- C1 preferência: canônica de K1 = a SL (IS DISTINCT FROM: linha ausente = vermelho)
  SELECT id::text, is_sl, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K1';
  IF r.id IS DISTINCT FROM 'f1000000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true OR r.receita_valida IS DISTINCT FROM true
    THEN falhas := falhas || format('C1 FALHOU: canonica de K1 = %s (is_sl=%s, valida=%s) — esperado a SL valida', r.id, r.is_sl, r.receita_valida); END IF;

  -- C2 fallback: SL sem receita → SAYERLACK vence
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K2';
  IF r.id IS DISTINCT FROM 'f2000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN falhas := falhas || format('C2 FALHOU: canonica de K2 = %s (esperado a SAYERLACK — SL sem receita)', r.id); END IF;

  -- C3 as "12": só-SAYERLACK em SKU órfão segue servida, válida POR FÓRMULA
  SELECT id::text, is_sl, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K3';
  IF r.id IS DISTINCT FROM 'f3000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false OR r.receita_valida IS DISTINCT FROM true
    THEN falhas := falhas || format('C3 FALHOU: K3 (ACR-MAX-like) = %s is_sl=%s valida=%s', r.id, r.is_sl, r.receita_valida); END IF;

  -- C4 personalizada aparece
  SELECT id::text, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K4';
  IF r.id IS DISTINCT FROM 'f4000000-0000-0000-0000-0000000000e0' OR r.receita_valida IS DISTINCT FROM true
    THEN falhas := falhas || format('C4 FALHOU: personalizada K4 = %s valida=%s', r.id, r.receita_valida); END IF;

  -- C5 ambas inválidas → SL (viva) vence
  SELECT id::text, is_sl, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K5';
  IF r.id IS DISTINCT FROM 'f5000000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true OR r.receita_valida IS DISTINCT FROM false
    THEN falhas := falhas || format('C5 FALHOU: K5 (ambas sem receita) = %s is_sl=%s valida=%s', r.id, r.is_sl, r.receita_valida); END IF;

  -- C6 corante quebrado (valor 0) invalida a SL → SAYERLACK vence
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K6';
  IF r.id IS DISTINCT FROM 'f6000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN falhas := falhas || format('C6 FALHOU: K6 (SL c/ corante zero) = %s — esperado a SAYERLACK', r.id); END IF;
  -- C6b corante órfão de omie idem
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K8';
  IF r.id IS DISTINCT FROM 'f8000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN falhas := falhas || format('C6b FALHOU: K8 (SL c/ corante sem omie) = %s — esperado a SAYERLACK', r.id); END IF;
  -- C6c corante com omie INATIVO invalida (a condição op.ativo do espelho tem dente)
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K13';
  IF r.id IS DISTINCT FROM 'f0130000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN falhas := falhas || format('C6c FALHOU: K13 (SL c/ corante de omie inativo) = %s — esperado a SAYERLACK', r.id); END IF;
  -- C6d corante com volume_total_ml=0 invalida (a condição volume>0 tem dente)
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K14';
  IF r.id IS DISTINCT FROM 'f0140000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN falhas := falhas || format('C6d FALHOU: K14 (SL c/ corante volume 0) = %s — esperado a SAYERLACK', r.id); END IF;

  -- C7 base indisponível não muda a preferência (validade é por-fórmula)
  SELECT id::text, is_sl, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K7';
  IF r.id IS DISTINCT FROM 'f7000000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true OR r.receita_valida IS DISTINCT FROM true
    THEN falhas := falhas || format('C7 FALHOU: K7 (sku inativo) = %s is_sl=%s — SL valida devia vencer mesmo sem base', r.id, r.is_sl); END IF;

  -- C7b desativada fora do jogo: K11 canônica = SAYERLACK (a SL está desativada)
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K11';
  IF r.id IS DISTINCT FROM 'fb000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN falhas := falhas || format('C7b FALHOU: K11 (SL desativada) = %s — esperado a SAYERLACK ativa', r.id); END IF;

  -- C12 empate de rank (personalizada×SAYERLACK, ambas válidas): menor uuid vence,
  -- independente da ordem de inserção (a SAYERLACK fd… foi inserida primeiro).
  SELECT id::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K12';
  IF r.id IS DISTINCT FROM 'fc000000-0000-0000-0000-0000000000e0'
    THEN falhas := falhas || format('C12 FALHOU: K12 (empate rank 1) = %s — esperado o menor uuid (fc…)', r.id); END IF;

  -- C13 (2b) preco_csv_legado — a fonte "Tabela (versão anterior)" da vendedora:
  -- SL canônica → CSV da gêmea antiga; fallback → o próprio; sem CSV na chave → NULL;
  -- SL desativada não participa mas a SAYERLACK ativa mantém o seu.
  SELECT preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K1';
  IF r.preco_csv_legado IS DISTINCT FROM '150' THEN
    falhas := falhas || format('C13 FALHOU: K1 (SL canônica) preco_csv_legado=%s — esperado 150 (CSV da gêmea)', r.preco_csv_legado); END IF;
  SELECT preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K2';
  IF r.preco_csv_legado IS DISTINCT FROM '160' THEN
    falhas := falhas || format('C13 FALHOU: K2 (fallback SAYERLACK) preco_csv_legado=%s — esperado 160 (próprio)', r.preco_csv_legado); END IF;
  SELECT preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K9';
  IF r.preco_csv_legado IS NOT NULL THEN
    falhas := falhas || format('C13 FALHOU: K9 (só SL, sem CSV na chave) preco_csv_legado=%s — esperado NULL', r.preco_csv_legado); END IF;
  SELECT preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K11';
  IF r.preco_csv_legado IS DISTINCT FROM '220' THEN
    falhas := falhas || format('C13 FALHOU: K11 preco_csv_legado=%s — esperado 220', r.preco_csv_legado); END IF;

  -- C14 (fix semântico) FUTURE-PROOF: K15 = SL canônica COM CSV PRÓPRIO (999).
  -- O max IGNORA o próprio (e qualquer SL) e devolve o da gêmea SAYERLACK (260).
  -- É o cenário que a 2b crua erraria (max incluiria o 999 da própria SL).
  SELECT id::text, is_sl, preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K15';
  IF r.id IS DISTINCT FROM 'f0150000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true THEN
    falhas := falhas || format('C14 FALHOU (pre-condicao): canonica de K15 = %s (is_sl=%s) — esperado a SL valida', r.id, r.is_sl);
  ELSIF r.preco_csv_legado IS DISTINCT FROM '260' THEN
    falhas := falhas || format('C14 FALHOU: K15 (SL canonica com CSV proprio 999) preco_csv_legado=%s — esperado 260 (da gemea nao-SL; o proprio NUNCA entra)', r.preco_csv_legado); END IF;

  -- C15 (fix semântico) ramo NÃO-SL intacto: K16 = canônica SAYERLACK; o max
  -- segue o comportamento da 2b (todas as ativas, INCLUSIVE a SL com CSV 400).
  -- Pega implementação over-eager que excluísse SL sempre (daria 270).
  SELECT id::text, is_sl, preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K16';
  IF r.id IS DISTINCT FROM 'f0160000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false THEN
    falhas := falhas || format('C15 FALHOU (pre-condicao): canonica de K16 = %s (is_sl=%s) — esperado a SAYERLACK', r.id, r.is_sl);
  ELSIF r.preco_csv_legado IS DISTINCT FROM '400' THEN
    falhas := falhas || format('C15 FALHOU: K16 (canonica nao-SL) preco_csv_legado=%s — esperado 400 (max inclui a SL; ramo nao-SL intacto)', r.preco_csv_legado); END IF;

  -- C16 (allowlist) 2ª SL com CSV na MESMA chave: K17 = SL canônica; o max
  -- ignora QUALQUER linha SL — não só a própria → 280 da geração '1', nunca o
  -- 800 da 2ª SL. Mata o mutante `g2.id <> f.id` (achado 2 do challenge Codex:
  -- passava C13/C14/C15 e F6/F7 por construção sobre os seeds K1-K16).
  SELECT id::text, is_sl, preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K17';
  IF r.id IS DISTINCT FROM 'f0170000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true THEN
    falhas := falhas || format('C16 FALHOU (pre-condicao): canonica de K17 = %s (is_sl=%s) — esperado a SL valida', r.id, r.is_sl);
  ELSIF r.preco_csv_legado IS DISTINCT FROM '280' THEN
    falhas := falhas || format('C16 FALHOU: K17 (2a linha SL com CSV 800 na chave) preco_csv_legado=%s — esperado 280 (TODA SL fora do max, nao so a propria)', r.preco_csv_legado); END IF;

  -- C17 (allowlist — FIXA a decisão do founder 2026-07-21) personalizada com
  -- CSV em chave de canônica SL: K18 → 290 da geração '1'; o 500 da
  -- personalizada NUNCA alimenta o rótulo "Tabela (versão anterior)".
  -- É o assert que separa allowlist da blocklist antiga (que devolveria 500).
  SELECT id::text, is_sl, preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K18';
  IF r.id IS DISTINCT FROM 'f0180000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true THEN
    falhas := falhas || format('C17 FALHOU (pre-condicao): canonica de K18 = %s (is_sl=%s) — esperado a SL valida', r.id, r.is_sl);
  ELSIF r.preco_csv_legado IS DISTINCT FROM '290' THEN
    falhas := falhas || format('C17 FALHOU: K18 (personalizada com CSV 500 na chave) preco_csv_legado=%s — esperado 290 (allowlist: personalizada fora do max)', r.preco_csv_legado); END IF;

  -- C18 linha DESATIVADA com CSV alto fora do max: K19 → 300 da '1' ativa; o
  -- 900 da '1' desativada nao entra (o filtro desativada_em do max tem dente).
  SELECT id::text, is_sl, preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K19';
  IF r.id IS DISTINCT FROM 'f0190000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true THEN
    falhas := falhas || format('C18 FALHOU (pre-condicao): canonica de K19 = %s (is_sl=%s) — esperado a SL valida', r.id, r.is_sl);
  ELSIF r.preco_csv_legado IS DISTINCT FROM '300' THEN
    falhas := falhas || format('C18 FALHOU: K19 (linha desativada com CSV 900 na chave) preco_csv_legado=%s — esperado 300 (desativada fora do max)', r.preco_csv_legado); END IF;

  -- C19 (challenge Codex 2026-07-21, achado (a)-1) GUARD CROSS-ACCOUNT: K20 é
  -- da conta 'colacor'; na mesma chave há a '1' de COLACOR (CSV 320) e uma
  -- linha de colacor que aponta para a subcoleção '1' de OBEN (CSV 850).
  -- Esperado 320 — o 850 entra se `s2.account = g2.account` sumir do EXISTS.
  -- Nenhum seed K1-K19 exercia esse predicado (harness monoconta).
  SELECT id::text, is_sl, preco_csv_legado::text INTO r
    FROM public.v_tint_formula_canonica WHERE account='colacor' AND cor_id='K20';
  IF r.id IS DISTINCT FROM 'f0200000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true THEN
    falhas := falhas || format('C19 FALHOU (pre-condicao): canonica de K20 = %s (is_sl=%s) — esperado a SL valida de colacor', r.id, r.is_sl);
  ELSIF r.preco_csv_legado IS DISTINCT FROM '320' THEN
    falhas := falhas || format('C19 FALHOU: K20 (subcolecao 1 de OUTRA conta com CSV 850) preco_csv_legado=%s — esperado 320 (guard s2.account=g2.account)', r.preco_csv_legado); END IF;

  -- C20 (challenge Codex 2026-07-21, achado (a)-2) EXCLUSIVIDADE DO LITERAL '1':
  -- K21 tem, na mesma chave, a '1' (330), a '2' (860), a '10' (870) e uma
  -- subcolecao de rotulo NULL (880). Esperado 330. Mata `<> 'SL'` (880),
  -- `IN ('1','2')` (860), `LIKE '1%'` (870) e `COALESCE(...,'1')='1'` (880) —
  -- os 4 passavam C1-C18 e F1-F10 porque o seed só tinha 'SL' e '1'.
  SELECT id::text, is_sl, preco_csv_legado::text INTO r
    FROM public.v_tint_formula_canonica WHERE cor_id='K21';
  IF r.id IS DISTINCT FROM 'f0210000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true THEN
    falhas := falhas || format('C20 FALHOU (pre-condicao): canonica de K21 = %s (is_sl=%s) — esperado a SL valida', r.id, r.is_sl);
  ELSIF r.preco_csv_legado IS DISTINCT FROM '330' THEN
    falhas := falhas || format('C20 FALHOU: K21 (subcolecoes 2/10/rotulo-NULL com CSV alto) preco_csv_legado=%s — esperado 330 (SO a geracao 1 alimenta o rotulo)', r.preco_csv_legado); END IF;

  -- C9 determinismo: duas leituras idênticas (ids ordenados)
  SELECT string_agg(id::text, ',' ORDER BY id) INTO a FROM public.v_tint_formula_canonica;
  SELECT string_agg(id::text, ',' ORDER BY id) INTO b FROM public.v_tint_formula_canonica;
  IF a IS DISTINCT FROM b THEN falhas := falhas || 'C9 FALHOU: leituras divergem'; END IF;

  -- C10 paridade do espelho: p/ cada canônica, receita_valida ∧ base_disponivel
  --     ⟺ precoFinal da RPC REAL (get_tint_prices) não-nulo
  FOR r IN
    SELECT v.id, v.cor_id, v.receita_valida,
           EXISTS (SELECT 1 FROM public.tint_skus s JOIN public.omie_products op ON op.id=s.omie_product_id
                   WHERE s.id=v.sku_id AND op.valor_unitario>0 AND COALESCE(op.ativo,false)) AS base_ok,
           ((public.get_tint_prices(ARRAY[v.id]) -> v.id::text ->> 'precoFinal') IS NOT NULL) AS rpc_tem_preco,
           ((public.get_tint_price(v.id) ->> 'precoFinal') IS NOT NULL) AS rpc_single_tem_preco,
           round(((public.get_tint_price(v.id) ->> 'precoFinal'))::numeric, 6) AS rpc_single_valor,
           round(((public.get_tint_prices(ARRAY[v.id]) -> v.id::text ->> 'precoFinal'))::numeric, 6) AS rpc_batch_valor
    FROM public.v_tint_formula_canonica v
  LOOP
    -- só a PRIMEIRA ocorrência entra no array (o loop varre todas as canônicas;
    -- N linhas quebradas são UMA falha de C10, senão a contagem vira ruído)
    IF c10_ok AND (r.receita_valida AND r.base_ok) IS DISTINCT FROM r.rpc_tem_preco THEN
      c10_ok := false;
      falhas := falhas || format('C10 FALHOU: paridade quebrou em %s (%s): valida=%s base=%s rpc=%s',
        r.cor_id, r.id, r.receita_valida, r.base_ok, r.rpc_tem_preco);
    END IF;
    IF c10b_ok AND (r.rpc_single_tem_preco IS DISTINCT FROM r.rpc_tem_preco
       OR r.rpc_single_valor IS DISTINCT FROM r.rpc_batch_valor) THEN
      c10b_ok := false;
      falhas := falhas || format('C10b FALHOU: singular×batch divergem em %s (%s): single=%s batch=%s',
        r.cor_id, r.id, r.rpc_single_valor, r.rpc_batch_valor);
    END IF;
  END LOOP;

  -- Desfecho: TODOS_OK, ou a lista COMPLETA com a contagem. É o que torna
  -- verificável a alegação "vermelho certo, e só ele" de cada falsificação.
  IF array_length(falhas, 1) IS NULL THEN
    RAISE NOTICE 'TODOS_OK';
  ELSE
    RAISE EXCEPTION 'FALHAS[%]: %', array_length(falhas, 1), array_to_string(falhas, ' | ');
  END IF;
END $$;
SQL
}

# ══════════════════════════════════════════════════════════════════════════════
# ASSERTS DO PISO (C21-C31) — bloco SEPARADO de propósito.
#
# Por que separado: as 10 views sabotadas de F1-F10 são recriadas À MÃO com 13
# colunas. Se `run_asserts` passasse a ler `preco_piso_legado`, TODAS elas
# morreriam em "column does not exist" — sabotagem que muda DUAS coisas (o alvo
# + o shape) não isola o que prova (é a lição já registrada no comentário da F1).
# Mantendo os asserts do piso aqui, F1-F13 seguem provando o RÓTULO/rank contra
# a cadeia de 4 migrations, sem tocar nada, e o piso ganha as falsificações
# próprias (F14-F16, por mutação sed da MIGRATION5).
# O baseline continua cobrindo o risco real: C1-C20 rodam contra a view FINAL
# (5 migrations), então um erro da MIGRATION5 na coluna 13 aparece lá.
# ══════════════════════════════════════════════════════════════════════════════
run_asserts_piso() {
  P -tA 2>&1 <<'SQL'
DO $$
DECLARE
  r record;
  falhas text[] := '{}';
  n int;
  v_cols text;
  b boolean;
BEGIN
  -- ── C21 O CASO DO CODEX (a razão de a coluna existir) ──────────────────────
  -- K18: canônica SL, personalizada com CSV 500 e geração '1' com CSV 290.
  -- O RÓTULO fica em 290 (allowlist = proveniência provada); o PISO sobe para
  -- 500 (conservador = toda linha ativa). Com uma coluna só, dar precisão ao
  -- rótulo derrubava o piso de 500 para 290 e liberava preço manual mais baixo.
  SELECT c.is_sl, c.preco_csv_legado::text AS csv, c.preco_piso_legado::text AS piso
    INTO r FROM public.v_tint_formula_canonica c WHERE c.cor_id='K18';
  IF r.is_sl IS DISTINCT FROM true THEN
    falhas := falhas || format('C21 FALHOU (pre-condicao): canonica de K18 nao e SL (is_sl=%s)', r.is_sl);
  ELSIF r.csv IS DISTINCT FROM '290' OR r.piso IS DISTINCT FROM '500' THEN
    falhas := falhas || format('C21 FALHOU: K18 csv=%s piso=%s — esperado csv=290 (rotulo/allowlist) e piso=500 (conservador: a personalizada entra no piso, nao no rotulo)', r.csv, r.piso);
  END IF;

  -- ── C22 2ª linha SL entra no PISO (mas segue fora do rótulo) ───────────────
  SELECT c.preco_csv_legado::text AS csv, c.preco_piso_legado::text AS piso
    INTO r FROM public.v_tint_formula_canonica c WHERE c.cor_id='K17';
  IF r.csv IS DISTINCT FROM '280' OR r.piso IS DISTINCT FROM '800' THEN
    falhas := falhas || format('C22 FALHOU: K17 csv=%s piso=%s — esperado csv=280 e piso=800 (a 2a SL alimenta o piso)', r.csv, r.piso);
  END IF;

  -- ── C23 DESATIVADA fica fora dos DOIS (o piso herda o filtro) ──────────────
  -- Sem o `desativada_em IS NULL` no ramo do piso, o CSV 900 da linha morta
  -- entraria e o piso viraria 900 — dado de fórmula desativada não é evidência.
  SELECT c.preco_csv_legado::text AS csv, c.preco_piso_legado::text AS piso
    INTO r FROM public.v_tint_formula_canonica c WHERE c.cor_id='K19';
  IF r.csv IS DISTINCT FROM '300' OR r.piso IS DISTINCT FROM '300' THEN
    falhas := falhas || format('C23 FALHOU: K19 csv=%s piso=%s — esperado 300/300 (a desativada com CSV 900 fica fora do piso tambem)', r.csv, r.piso);
  END IF;

  -- ── C24 subcoleções FUTURAS entram no piso (e seguem fora do rótulo) ───────
  SELECT c.preco_csv_legado::text AS csv, c.preco_piso_legado::text AS piso
    INTO r FROM public.v_tint_formula_canonica c WHERE c.cor_id='K21';
  IF r.csv IS DISTINCT FROM '330' OR r.piso IS DISTINCT FROM '880' THEN
    falhas := falhas || format('C24 FALHOU: K21 csv=%s piso=%s — esperado csv=330 (so a geracao 1) e piso=880 (2/10/rotulo-NULL entram no piso)', r.csv, r.piso);
  END IF;

  -- ── C25 linha cross-account entra no PISO (conservador) ────────────────────
  -- O guard `s2.account = g2.account` protege o RÓTULO (C19). O piso não junta
  -- subcoleção nenhuma: é linha ATIVA da chave (account, sku, cor), logo o 850
  -- entra. Direção segura — piso mais alto.
  SELECT c.preco_csv_legado::text AS csv, c.preco_piso_legado::text AS piso
    INTO r FROM public.v_tint_formula_canonica c WHERE c.account='colacor' AND c.cor_id='K20';
  IF r.csv IS DISTINCT FROM '320' OR r.piso IS DISTINCT FROM '850' THEN
    falhas := falhas || format('C25 FALHOU: K20 csv=%s piso=%s — esperado csv=320 (guard de conta no rotulo) e piso=850 (o piso nao filtra subcolecao)', r.csv, r.piso);
  END IF;

  -- ── C26 NULL-PRESERVING (o coração da correção do spec) ────────────────────
  -- K22: canônica SL, personalizada com CSV 700, NENHUMA geração '1' na chave.
  -- csv = NULL ⇒ piso TEM de ser NULL. Se virasse 700, o gate trocaria
  -- v_floor = v_calc por v_floor = 700 e AFROUXARIA — em prod são 31.062 chaves.
  SELECT c.is_sl, c.preco_csv_legado::text AS csv, c.preco_piso_legado::text AS piso
    INTO r FROM public.v_tint_formula_canonica c WHERE c.cor_id='K22';
  IF r.is_sl IS DISTINCT FROM true THEN
    falhas := falhas || format('C26 FALHOU (pre-condicao): canonica de K22 nao e SL (is_sl=%s)', r.is_sl);
  ELSIF r.csv IS NOT NULL OR r.piso IS NOT NULL THEN
    falhas := falhas || format('C26 FALHOU: K22 csv=%s piso=%s — esperado NULL/NULL (sem geracao 1 provada o piso NAO desce; devolver 700 aqui AFROUXA o gate)', COALESCE(r.csv,'NULL'), COALESCE(r.piso,'NULL'));
  END IF;

  -- ── C27 ramo NÃO-SL: piso ≡ csv (a allowlist nem dispara) ──────────────────
  SELECT c.is_sl, c.preco_csv_legado::text AS csv, c.preco_piso_legado::text AS piso
    INTO r FROM public.v_tint_formula_canonica c WHERE c.cor_id='K16';
  IF r.is_sl IS DISTINCT FROM false THEN
    falhas := falhas || format('C27 FALHOU (pre-condicao): canonica de K16 deveria ser nao-SL (is_sl=%s)', r.is_sl);
  ELSIF r.csv IS DISTINCT FROM '400' OR r.piso IS DISTINCT FROM '400' THEN
    falhas := falhas || format('C27 FALHOU: K16 csv=%s piso=%s — esperado 400/400 (canonica nao-SL: os dois ja sao o max de todas)', r.csv, r.piso);
  END IF;

  -- ── C28 INVARIANTE I1, GLOBAL: (csv IS NULL) ⟺ (piso IS NULL) ─────────────
  -- Guarda de DRIFT: a subquery do csv aparece 2× na migration (coluna 13 e o
  -- teste de NULL da 14ª). Se as cópias divergirem, I1 quebra aqui na hora.
  SELECT count(*) INTO n FROM public.v_tint_formula_canonica
   WHERE (preco_csv_legado IS NULL) <> (preco_piso_legado IS NULL);
  IF n <> 0 THEN
    falhas := falhas || format('C28 FALHOU: %s linha(s) violam I1 (csv IS NULL) <=> (piso IS NULL) — as 2 copias da subquery do csv driftaram', n);
  END IF;

  -- ── C29 INVARIANTE I2, GLOBAL: piso >= csv ────────────────────────────────
  -- O piso é o max de um SUPERconjunto do max do rótulo. Se alguma linha tiver
  -- piso < csv, o piso deixou de ser conservador e a mudança pode afrouxar.
  SELECT count(*) INTO n FROM public.v_tint_formula_canonica
   WHERE preco_csv_legado IS NOT NULL AND preco_piso_legado IS NOT NULL
     AND preco_piso_legado < preco_csv_legado;
  IF n <> 0 THEN
    falhas := falhas || format('C29 FALHOU: %s linha(s) com piso < csv — o piso tem de ser o max de um SUPERconjunto (senao o gate afrouxa)', n);
  END IF;

  -- ── C30 SHAPE: a 14ª só ACRESCENTA; as 13 anteriores na ordem EXATA ───────
  -- Regra do repo para REPLACE de view (CLAUDE.md): preservar a ordem e só
  -- acrescentar no fim. Um consumidor posicional quebra silenciosamente se não.
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.v_tint_formula_canonica'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_cols IS DISTINCT FROM 'id,account,sku_id,cor_id,nome_cor,preco_final_sayersystem,subcolecao_id,personalizada,updated_at,is_sl,tem_receita,receita_valida,preco_csv_legado,preco_piso_legado' THEN
    falhas := falhas || format('C30 FALHOU: ordem/nomes das colunas mudou — veio [%s]', v_cols);
  END IF;

  -- ── C31 security_invoker=on sobreviveu ao REPLACE (armadilha #1375) ───────
  -- Omitir o WITH no replace RESETA a opção: a view passa a ler como OWNER e
  -- bypassa RLS. Falha ABERTA, muda autorização e não comportamento — nenhum
  -- assert de VALOR pegaria.
  SELECT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'public.v_tint_formula_canonica'::regclass
                    AND c.reloptions @> ARRAY['security_invoker=on']) INTO b;
  IF NOT b THEN
    falhas := falhas || 'C31 FALHOU: a view perdeu security_invoker=on — passa a ler como OWNER e bypassa a RLS (armadilha #1375)';
  END IF;

  IF array_length(falhas, 1) IS NULL THEN
    RAISE NOTICE 'TODOS_OK';
  ELSE
    RAISE EXCEPTION 'FALHAS[%]: %', array_length(falhas, 1), array_to_string(falhas, ' | ');
  END IF;
END $$;
SQL
}

echo ""
echo "════════ BASELINE (migration real) ════════"
OUT="$(run_asserts)"
case "$OUT" in
  *TODOS_OK*) ok "C1–C20 baseline verde (preferência, fallback, 12, personalizada, csv legado allowlist, guard de conta, exclusividade da '1', determinismo, paridade RPC)" ;;
  *) bad "baseline NÃO passou: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-300)" ;;
esac
OUT_PISO="$(run_asserts_piso)"
case "$OUT_PISO" in
  *TODOS_OK*) ok "C21–C31 baseline verde (piso conservador, NULL-preserving, invariantes I1/I2, shape das 14 colunas, security_invoker)" ;;
  *) bad "baseline do PISO NÃO passou: $(printf '%s' "$OUT_PISO" | tr '\n' ' ' | cut -c1-300)" ;;
esac

echo ""
echo "════════ C11 — RLS/security_invoker (staff vê · customer/anon não) ════════"
# count sob um papel; qualquer erro/permissão vira string não-numérica → bad
vcnt() { Pq -c "$1 SELECT count(*) FROM public.v_tint_formula_canonica;" 2>&1 | tail -1; }
is_num() { case "$1" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }
N_STAFF=$(vcnt "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;")
if is_num "$N_STAFF" && [ "$N_STAFF" -eq 22 ]; then ok "C11a staff (master) vê a view ($N_STAFF chaves)"; else bad "C11a staff: esperado 22, veio [$N_STAFF]"; fi
N_CUST=$(vcnt "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;")
eq "C11b customer autenticado NÃO vê (RLS herdada)" "$N_CUST" "0"
N_NOROLE=$(vcnt "SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;")
eq "C11c authenticated sem role NÃO vê" "$N_NOROLE" "0"
ANON_OUT=$(P -tA 2>&1 -c "SET ROLE anon; SELECT count(*) FROM public.v_tint_formula_canonica;" || true)
case "$ANON_OUT" in
  *"permission denied"*) ok "C11d anon: permission denied (grant revogado)" ;;
  *) bad "C11d anon deveria tomar permission denied, veio: $(printf '%s' "$ANON_OUT" | head -1)" ;;
esac
ANON_PRIV=$(Pq -c "SELECT has_table_privilege('anon','public.v_tint_formula_canonica','SELECT');" | tail -1)
eq "C11d2 anon SEM privilégio direto na VIEW (has_table_privilege=f)" "$ANON_PRIV" "f"
N_SRV=$(vcnt "SET ROLE service_role;")
if is_num "$N_SRV" && [ "$N_SRV" -eq 22 ]; then ok "C11e service_role vê ($N_SRV chaves)"; else bad "C11e service_role: esperado 22, veio [$N_SRV]"; fi
Pq -c "RESET ROLE;" >/dev/null

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÕES — sabotar a view e exigir o vermelho CERTO (e só ele).
# Regra do repo: baseline verde ANTES (feito acima) + conferir o NOME do assert
# que cai. Depois de cada uma, a migration REAL é re-aplicada (restauração).
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "════════ F1 — sabotagem: rank invertido (SAYERLACK vence SL válida) ════════"
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       -- 13ª coluna FIEL à migration real: esta falsificação ataca o RANK, não o
       -- CSV. Sem ela a view sabotada tinha 12 colunas e os asserts C13-C20
       -- morriam em "column does not exist" — sabotagem que muda DUAS coisas
       -- (rank + shape) não isola o que prova.
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL
           AND (NOT rf.is_sl OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                WHERE s2.id=g2.subcolecao_id AND s2.account=g2.account
                  AND s2.id_subcolecao_sayersystem='1'))) AS preco_csv_legado
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 1  -- SABOTADO: 0↔1
              WHEN v.tem_receita AND v.corantes_ok             THEN 0
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 1  -- SABOTADO: 0↔1
                  WHEN w.tem_receita AND w.corantes_ok             THEN 0
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F1" "$OUT" 3 "C1" "C7" "C14" -- "rank invertido: SAYERLACK venceu a SL valida (C7/C14 caem junto: trocar a canonica troca o is_sl, logo o ramo do CSV)"

echo ""
echo "════════ F2 — sabotagem: espelho de corantes frouxo (>=0 aceita corante zero) ════════"
restore_view   # restaura antes de sabotar de novo
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       -- 13ª coluna FIEL à migration real: esta falsificação ataca o RANK, não o
       -- CSV. Sem ela a view sabotada tinha 12 colunas e os asserts C13-C20
       -- morriam em "column does not exist" — sabotagem que muda DUAS coisas
       -- (rank + shape) não isola o que prova.
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL
           AND (NOT rf.is_sl OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                WHERE s2.id=g2.subcolecao_id AND s2.account=g2.account
                  AND s2.id_subcolecao_sayersystem='1'))) AS preco_csv_legado
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>=0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok  -- SABOTADO: >0 → >=0
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>=0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok  -- SABOTADO
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F2" "$OUT" 2 "C6" "C10" -- "espelho frouxo: SL com corante-zero virou valida e venceu (C10 cai junto: a paridade com a RPC real e o oraculo independente)"

echo ""
echo "════════ F3 — sabotagem: sem o anti-join (duplicata volta) ════════"
restore_view
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at,
       EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
       EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
       (EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id)
        AND NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
          LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
          LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
          WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0))) AS receita_valida,
       -- 13ª coluna fiel (esta falsificação ataca o ANTI-JOIN, não o CSV); aqui
       -- o is_sl é recalculado inline porque esta view não tem o LATERAL rf.
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL
           AND (NOT EXISTS (SELECT 1 FROM public.tint_subcolecoes s3
                            WHERE s3.id=f.subcolecao_id AND s3.account=f.account
                              AND s3.id_subcolecao_sayersystem='SL')
                OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                           WHERE s2.id=g2.subcolecao_id AND s2.account=g2.account
                             AND s2.id_subcolecao_sayersystem='1'))) AS preco_csv_legado
FROM public.tint_formulas f
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL;  -- SABOTADO: sem NOT EXISTS
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F3" "$OUT" 9 "C8" "C2" "C6" "C6b" "C6c" "C6d" "C12" "C15" "C19" -- "sem o anti-join: duplicata voltou (16 chaves com >1 linha; os asserts por-cor passam a ler linha arbitraria)"

echo ""
echo "════════ F4 — sabotagem: tie-break invertido (maior uuid vence) ════════"
restore_view
# idêntica à migration real, exceto o desempate: g.id > f.id (SABOTADO)
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       -- 13ª coluna FIEL à migration real: esta falsificação ataca o RANK, não o
       -- CSV. Sem ela a view sabotada tinha 12 colunas e os asserts C13-C20
       -- morriam em "column does not exist" — sabotagem que muda DUAS coisas
       -- (rank + shape) não isola o que prova.
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL
           AND (NOT rf.is_sl OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                WHERE s2.id=g2.subcolecao_id AND s2.account=g2.account
                  AND s2.id_subcolecao_sayersystem='1'))) AS preco_csv_legado
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id > f.id)));  -- SABOTADO: < → >
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F4" "$OUT" 1 "C12" -- "tie-break invertido: maior uuid venceu"

echo ""
echo "════════ F5 — sabotagem: preco_csv_legado só da própria linha (perde a gêmea) ════════"
restore_view
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL AND g2.id = f.id) AS preco_csv_legado  -- SABOTADO: só a própria linha
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F5" "$OUT" 8 "C13" "C14" "C15" "C16" "C17" "C18" "C19" "C20" -- "csv legado so da propria linha: perdeu a gemea antiga (derruba TODA a familia do CSV, como esperado)"

echo ""
echo "════════ F6 — sabotagem: expressão da 2b de volta (max SEM o filtro não-SL) ════════"
restore_view
# Idêntica à migration real, exceto preco_csv_legado: a expressão CRUA da
# 20260718233000 (max de todas as ativas, incluindo a própria SL) — é a
# regressão exata que o fix semântico fecha. Só C14 (K15) deve cair: 999≠260.
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL) AS preco_csv_legado  -- SABOTADO: sem o filtro não-SL (expressão da 2b)
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F6" "$OUT" 5 "C14" "C16" "C17" "C19" "C20" -- "expressao da 2b crua: max voltou a incluir o CSV proprio da SL"

echo ""
echo "════════ F7 — sabotagem: allowlist INCONDICIONAL (sem o guard is_sl) ════════"
restore_view
# Idêntica à migration real, exceto preco_csv_legado: o filtro allowlist-'1'
# aplicado INCONDICIONALMENTE (o erro over-eager natural do código novo) — muda
# o ramo não-SL, que a allowlist promete preservar. Só C15 (K16) deve cair: 270≠400.
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL
           AND EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                       WHERE s2.id=g2.subcolecao_id AND s2.account=g2.account
                         AND s2.id_subcolecao_sayersystem='1')) AS preco_csv_legado  -- SABOTADO: allowlist SEMPRE (perdeu o NOT rf.is_sl OR)
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F7" "$OUT" 1 "C15" -- "allowlist INCONDICIONAL: ramo nao-SL perdeu a SL do max"

echo ""
echo "════════ F8 — sabotagem: mutante 'g2.id <> f.id' (exclui só a PRÓPRIA linha) ════════"
restore_view
# O mutante do achado 2 do challenge retroativo Codex (2026-07-20): quando a
# canônica é SL, excluir só a própria linha em vez de TODA SL. Passava
# C13/C14/C15 e F6/F7 por construção sobre K1-K16 (nenhum seed tinha uma 2ª SL
# com CSV na chave). Só C16 (K17) deve cair: 800≠280.
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL
           AND (NOT rf.is_sl OR g2.id <> f.id)) AS preco_csv_legado  -- SABOTADO: mutante do challenge — exclui so a propria linha, nao toda SL
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F8" "$OUT" 4 "C16" "C17" "C19" "C20" -- "mutante id<>f.id: a 2a SL entrou no max (C19/C20 novos tambem tem dente contra ele)"

echo ""
echo "════════ F9 — sabotagem: blocklist não-SL de volta (20260722100002 verbatim) ════════"
restore_view
# A regressão exata da decisão do founder: reverter a allowlist para a blocklist
# do fix semântico anterior. Personalizada volta a entrar no max quando a
# canônica é SL. Só C17 (K18) deve cair: 500≠290 (C16 fica verde — a blocklist
# também exclui toda SL).
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL
           AND (NOT rf.is_sl
                OR NOT EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                               WHERE s2.id=g2.subcolecao_id AND s2.account=g2.account
                                 AND s2.id_subcolecao_sayersystem='SL'))) AS preco_csv_legado  -- SABOTADO: blocklist nao-SL de volta (personalizada entra)
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F9" "$OUT" 3 "C17" "C19" "C20" -- "blocklist de volta (20260722100002 verbatim): a personalizada entrou no max"

echo ""
echo "════════ F10 — sabotagem: max sem o filtro de desativada ════════"
restore_view
# Perde o `g2.desativada_em IS NULL` do max (allowlist intacta no resto).
# Antes do K19 esse mutante passava verde: nenhum seed tinha desativada com CSV
# que mudasse o valor. Só C18 (K19) deve cair: 900≠300.
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND (NOT rf.is_sl
                OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                           WHERE s2.id=g2.subcolecao_id AND s2.account=g2.account
                             AND s2.id_subcolecao_sayersystem='1'))) AS preco_csv_legado  -- SABOTADO: perdeu o g2.desativada_em IS NULL
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *) : ;;
esac
confere_falsificacao "F10" "$OUT" 1 "C18" -- "max sem o filtro desativada_em: a desativada com CSV 900 entrou"

# ══════════════════════════════════════════════════════════════════════════════
# F11-F13 (challenge Codex xhigh 2026-07-21) — mutantes que sobreviviam a TUDO.
# Geradas por MUTAÇÃO da migration real (sed sobre $MIGRATION4), não por cópia:
# assim a view sabotada difere da verdadeira em EXATAMENTE um ponto — que é a
# definição de mutante. Copiar 60 linhas à mão foi o que deixou F1-F4 mudarem
# rank E shape ao mesmo tempo.
# ══════════════════════════════════════════════════════════════════════════════
sabota_migration() { # <expressao sed>
  restore_view
  P -q -c "DROP VIEW IF EXISTS public.v_tint_formula_canonica;" >/dev/null || return 1
  sed "$1" "$MIGRATION4" | P -q -f - >/dev/null || return 1
}

echo ""
echo "════════ F11 — sabotagem: allowlist SEM o guard de conta (s2.account) ════════"
# O predicado vira `s2.id = g2.subcolecao_id AND …='1'` — cardinalidade idêntica
# (s2.id é PK), então NADA muda numa base de conta única. É exatamente por isso
# que nenhum seed K1-K19 o matava. Com K20, a fórmula de 'colacor' passa a
# enxergar a subcoleção '1' de 'oben' e herda o CSV 850 alheio.
sabota_migration 's/AND s2\.account = g2\.account//' || bad "F11 não aplicou a sabotagem"
OUT="$(run_asserts)"
confere_falsificacao "F11" "$OUT" 1 "C19" -- "sem s2.account=g2.account: CSV de subcolecao de OUTRA conta entrou no max"

echo ""
echo '════════ F12 — sabotagem: <> SL no lugar da allowlist da 1 ════════'
# A "blocklist com EXISTS": mantém personalizada e 2ª SL fora (C16/C17 seguem
# verdes!), mas deixa entrar QUALQUER geração futura. É o mutante que mais se
# parece com a decisão de produto sem ser ela — e o que o achado 1 do challenge
# anterior queria fechar. Derruba SÓ C20: K20 (a chave cross-account) segue
# verde porque esta sabotagem PRESERVA o `s2.account = g2.account`, e esse guard
# sozinho já barra a subcoleção alheia. Os dois guards são INDEPENDENTES — cada
# um tem sua falsificação (F11 para o de conta, F12/F13 para o do literal).
sabota_migration "s/AND s2\.id_subcolecao_sayersystem = '1'/AND s2.id_subcolecao_sayersystem <> 'SL'/" || bad "F12 não aplicou a sabotagem"
OUT="$(run_asserts)"
confere_falsificacao "F12" "$OUT" 1 "C20" -- "<> 'SL' no lugar de = '1': subcolecao FUTURA alimentou o rotulo"

echo ""
echo "════════ F13 — sabotagem: allowlist frouxa IN ('1','2') ════════"
# Isola C20: o guard de conta segue de pé (C19 verde), só a exclusividade do
# literal cai. Prova que C20 tem dente PRÓPRIO, não só carona no F12.
sabota_migration "s/AND s2\.id_subcolecao_sayersystem = '1'/AND s2.id_subcolecao_sayersystem IN ('1','2')/" || bad "F13 não aplicou a sabotagem"
OUT="$(run_asserts)"
confere_falsificacao "F13" "$OUT" 1 "C20" -- "IN ('1','2'): a geracao '2' entrou no max"

# ══════════════════════════════════════════════════════════════════════════════
# F14-F16 — falsificações do PISO (coluna 14), por MUTAÇÃO sed da MIGRATION5.
# Cada uma ataca UMA propriedade do piso e é conferida contra `run_asserts_piso`.
# Em cada uma, `run_asserts` (C1-C20) TEM de seguir verde: o piso é coluna nova
# e a sabotagem não pode vazar para o rótulo/rank. Isso é VERIFICADO, não
# assumido — é o que prova que a sabotagem isola o que diz isolar.
# ══════════════════════════════════════════════════════════════════════════════
sabota_migration5() { # <expressao sed>
  # A MIGRATION5 é REPLACE puro e as mutações abaixo preservam as 14 colunas na
  # mesma ordem — então dá para re-aplicar por cima sem DROP.
  restore_view
  sed "$1" "$MIGRATION5" | P -q -f - >/dev/null || return 1
}

# Confere que a sabotagem do piso NÃO vazou para os asserts do rótulo/rank.
piso_isolado() { # <rotulo>
  local o; o="$(run_asserts)"
  case "$o" in
    *TODOS_OK*) ok "$1 isolada: C1–C20 (rótulo/rank) seguem verdes sob a sabotagem do piso" ;;
    *) bad "$1 VAZOU para C1–C20: $(printf '%s' "$o" | tr '\n' ' ' | cut -c1-220)" ;;
  esac
}

echo ""
echo "════════ F14 — sabotagem: o SPEC INGÊNUO (piso sem o NULL-preserving) ════════"
# `AND false` no WHEN da CASE ⇒ o ramo ELSE sempre vale ⇒ piso = max de TODAS as
# ativas INCONDICIONALMENTE. É exatamente o spec que o follow-up pedia ao pé da
# letra, e que a medição em prod mostrou estar errado: onde não há geração '1'
# provada (K22 / 31.062 chaves reais), o piso deixa de ser v_calc e vira o CSV
# de qualquer linha ativa — AFROUXANDO o gate em vez de apertá-lo.
sabota_migration5 's/))) IS NULL/))) IS NULL AND false/' || bad "F14 não aplicou a sabotagem"
OUT_PISO="$(run_asserts_piso)"
confere_falsificacao "F14" "$OUT_PISO" 2 "C26" "C28" -- "spec ingenuo: sem geracao 1 provada o piso virou 700 (afrouxa) e quebrou o invariante I1"
piso_isolado "F14"

echo ""
echo "════════ F15 — sabotagem: piso com a ALLOWLIST (piso ≡ rótulo) ════════"
# O piso passa a filtrar pela geração '1' igual ao rótulo — ou seja, a coluna
# nova vira uma cópia da 13ª e a separação some. É o estado ANTERIOR a esta
# migration: o cenário do Codex volta a ficar desprotegido.
sabota_migration5 "s/AND g3\.desativada_em IS NULL)/AND g3.desativada_em IS NULL AND (NOT rf.is_sl OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s3 WHERE s3.id = g3.subcolecao_id AND s3.account = g3.account AND s3.id_subcolecao_sayersystem = '1')))/" || bad "F15 não aplicou a sabotagem"
OUT_PISO="$(run_asserts_piso)"
confere_falsificacao "F15" "$OUT_PISO" 4 "C21" "C22" "C24" "C25" -- "piso com allowlist: virou copia do rotulo e o caso do Codex (K18) ficou desprotegido"
piso_isolado "F15"

echo ""
echo "════════ F16 — sabotagem: piso sem o filtro desativada_em ════════"
# Fórmula DESATIVADA voltaria a ser evidência de preço: o CSV 900 da linha morta
# de K19 entraria no piso. Direção "conservadora" na aparência, errada no mérito
# — piso alto demais barra venda legítima, e o dado nem é vivo.
sabota_migration5 's/AND g3\.desativada_em IS NULL)/)/' || bad "F16 não aplicou a sabotagem"
OUT_PISO="$(run_asserts_piso)"
confere_falsificacao "F16" "$OUT_PISO" 1 "C23" -- "piso sem desativada_em: o CSV 900 da formula morta virou piso"
piso_isolado "F16"

echo ""
echo "════════ R — restauração: migrations reais de volta ⇒ tudo verde ════════"
restore_view
OUT="$(run_asserts)"
case "$OUT" in
  *TODOS_OK*) ok "R restauração: C1–C20 verdes com a migration real re-aplicada" ;;
  *) bad "R restauração falhou: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-300)" ;;
esac
OUT_PISO="$(run_asserts_piso)"
case "$OUT_PISO" in
  *TODOS_OK*) ok "R restauração: C21–C31 (piso) verdes com a migration real re-aplicada" ;;
  *) bad "R restauração do PISO falhou: $(printf '%s' "$OUT_PISO" | tr '\n' ' ' | cut -c1-300)" ;;
esac

echo ""
echo "═══════════════════════════════════════════"
echo "RESULTADO: $PASS ✅ · $FAIL ❌"
[ "$FAIL" -eq 0 ] || exit 1
echo "test-tint-canonica: OK"
