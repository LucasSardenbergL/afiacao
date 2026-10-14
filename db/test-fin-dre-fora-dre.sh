#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17                 # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5471}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="fin-dre-fora-dre"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA de que a
# major é a esperada — `-x` sozinho aceita um initdb de outra versão. Fail-closed: PG ausente é
# ERRO, nunca skip; no macOS o helper também contorna o keg-only do brew. Hardcodar /opt/homebrew
# é o que mantinha a prova FORA do CI (runner ubuntu) — e portabilidade é pré-requisito para ela
# entrar em `db/nucleo-ci.txt`, o caminho obrigatório do merge.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# PROVA: supabase/migrations/20261013230000_fin_dre_fora_dre_fase2.sql
#   CHECK ampliado (impostos em linha própria + fora_dre), fora_dre proibido em _default,
#   colunas fora_dre/resultado_provisorio NULLABLE SEM default (ausente ≠ zero), postcondição.
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20261013230000_fin_dre_fora_dre_fase2.sql"
TMPD="$(dirname "$DATA")"

# ZONA 1 — pré-requisitos: as 2 tabelas como estão em PROD (psql-ro 2026-10-13: CHECK de 11
# valores com este nome, UNIQUE(company, omie_codigo), numeric(15,2) nas colunas de valor).
P -q <<'SQL'
CREATE TABLE public.fin_categoria_dre_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc','_default'])),
  omie_codigo text NOT NULL,
  dre_linha text NOT NULL,
  UNIQUE (company, omie_codigo)
);
ALTER TABLE public.fin_categoria_dre_mapping ADD CONSTRAINT fin_categoria_dre_mapping_dre_linha_check
  CHECK (dre_linha = ANY (ARRAY['receita_bruta','deducoes','cmv','despesas_operacionais','despesas_administrativas',
    'despesas_comerciais','despesas_financeiras','receitas_financeiras','outras_receitas','outras_despesas','impostos']));
CREATE TABLE public.fin_dre_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, ano int NOT NULL, mes int NOT NULL, regime text NOT NULL,
  resultado_liquido numeric(15,2), detalhamento jsonb,
  UNIQUE (company, ano, mes, regime)
);
-- seed LEGADO (antes da migration): os valores que existem hoje em prod continuam válidos
INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha) VALUES
  ('_default','5.01.01','impostos'), ('_default','1.01.05','deducoes'), ('colacor','2.05.04','despesas_financeiras');
INSERT INTO public.fin_dre_snapshots (company, ano, mes, regime, resultado_liquido) VALUES ('colacor',2026,1,'caixa',-12345.67);
SQL

# ZONA 5a — FALSIFICAÇÃO DA POSTCONDIÇÃO (antes da real: cada cópia sabotada tem de ABORTAR e
# deixar o banco intocado). Controle verde = a migration real logo abaixo, MESMA invocação.
sabotada() { # $1 rótulo · $2 expressão sed · exige erro da postcondição + rollback
  local f="$TMPD/sab.sql" out
  sed "$2" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then bad "F-$1: sed não aplicou (sabotagem inválida)"; return; fi
  if out=$(P -q -f "$f" 2>&1); then bad "F-$1: migration sabotada PASSOU"; return; fi
  case "$out" in *"postcondicao:"*) ok "F-$1: postcondição abortou" ;; *) bad "F-$1: falhou por outro motivo: ${out:0:200}" ;; esac
  local n; n=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='fin_dre_snapshots' AND column_name IN ('fora_dre','resultado_provisorio');")
  eq "F-$1: rollback (colunas novas ausentes)" "$n" "0"
}
sabotada "check-sem-fora_dre" "s/^    'fora_dre'\$/    'outras_despesas'/"
sabotada "check-sem-csll" "s/'das', 'irpj', 'csll',\$/'das', 'irpj',/"
sabotada "default-zero" "s/ADD COLUMN IF NOT EXISTS fora_dre numeric(15,2);/ADD COLUMN IF NOT EXISTS fora_dre numeric(15,2) DEFAULT 0;/"
sabotada "provisorio-default-false" "s/ADD COLUMN IF NOT EXISTS resultado_provisorio boolean;/ADD COLUMN IF NOT EXISTS resultado_provisorio boolean DEFAULT false;/"
sabotada "sem-check-default" "s/CHECK (NOT (company = '_default' AND dre_linha = 'fora_dre'))/CHECK (true)/"
sabotada "gatilho-so-delete" "s/  BEFORE INSERT OR UPDATE ON public.fin_dre_snapshots/  BEFORE DELETE ON public.fin_dre_snapshots/"
sabotada "gatilho-nao-zera" "s/    NEW.fora_dre := NULL;/    NULL;/"
sabotada "check-default-so-oben" "s/CHECK (NOT (company = '_default' AND dre_linha = 'fora_dre'))/CHECK (NOT (company = 'oben' AND dre_linha = 'fora_dre'))/"

# ZONA 2 — a migration REAL (controle verde) + reaplicação (idempotência)
P -q -f "$MIG" && ok "A0 migration real aplicou (postcondição verde)"
P -q -f "$MIG" && ok "A0b reaplicação idempotente"

echo "── asserts ──"
# NEGATIVO com SQLSTATE: 23514 check_violation; qualquer outro erro relança.
recusa() { # 0 se o INSERT deu 23514 · 1 se aceitou · outro erro relança (sai ≠ 0 e ≠ 1 vira "outro")
  local out
  out=$(P -tA 2>&1 <<SQL
DO \$t\$ BEGIN
  INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha) VALUES ('$1','9.99.99','$2');
  RAISE NOTICE 'SENTINELA-ACEITOU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'SENTINELA-23514';
          WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
) || { echo "outro: ${out:0:200}"; return 2; }
  case "$out" in *SENTINELA-23514*) return 0 ;; *SENTINELA-ACEITOU*) return 1 ;; *) echo "outro: ${out:0:200}"; return 2 ;; esac
}
rejeita_check() { # $1 rótulo · $2 company · $3 linha
  local rc=0; recusa "$2" "$3" || rc=$?
  if [ "$rc" = 0 ]; then ok "$1 (23514)"; else bad "$1 — rc=$rc"; fi
}
dente() { # $1 rótulo · $2 company · $3 linha — com a defesa SABOTADA, o INSERT tem de ser ACEITO
  local rc=0; recusa "$2" "$3" || rc=$?
  if [ "$rc" = 1 ]; then ok "$1: sem a defesa o assert fica vermelho (tem dente)"; else bad "$1: assert SEM dente (rc=$rc)"; fi
}
aceita() { # $1 rótulo · $2 company · $3 codigo · $4 linha
  if P -q -c "INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha) VALUES ('$2','$3','$4');"; then ok "$1"; else bad "$1 — recusado"; fi
}
eq "A1 linhas legadas intactas" "$(Pq -c "SELECT count(*) FROM public.fin_categoria_dre_mapping;")" "3"
for l in ded_icms ded_iss ded_pis ded_cofins ded_ipi das irpj csll fora_dre; do aceita "A2 colacor aceita $l" colacor "2.x.$l" "$l"; done
aceita "A2b legado 'impostos' segue válido" oben "5.01.09" impostos
rejeita_check "A3 valor desconhecido recusado" colacor "despesa_inventada"
rejeita_check "A4 fora_dre em _default recusado" _default "fora_dre"
aceita "A4b _default aceita imposto em linha própria" _default "5.01.99" ded_pis
eq "A5 snapshot legado: fora_dre NULL (ausente ≠ 0)" "$(Pq -c "SELECT coalesce(fora_dre::text,'NULL') FROM public.fin_dre_snapshots WHERE mes=1;")" "NULL"
eq "A5b snapshot legado: provisório NULL" "$(Pq -c "SELECT coalesce(resultado_provisorio::text,'NULL') FROM public.fin_dre_snapshots WHERE mes=1;")" "NULL"
eq "A5c resultado legado intacto" "$(Pq -c "SELECT resultado_liquido FROM public.fin_dre_snapshots WHERE mes=1;")" "-12345.67"
P -q -c "INSERT INTO public.fin_dre_snapshots (company, ano, mes, regime, resultado_liquido, detalhamento, fora_dre, resultado_provisorio) VALUES ('colacor',2026,2,'caixa',39217.95,'{\"contrato\":{\"versao\":\"dre-fora-dre-v1\"}}',260988.784,true);"
eq "A6 fora_dre grava com 2 casas" "$(Pq -c "SELECT fora_dre FROM public.fin_dre_snapshots WHERE mes=2;")" "260988.78"
eq "A6b provisório grava" "$(Pq -c "SELECT resultado_provisorio FROM public.fin_dre_snapshots WHERE mes=2;")" "t"
# rollback do motor: o upsert legado (sem contrato) reescreve o resultado e NÃO pode herdar o metadado
P -q -c "UPDATE public.fin_dre_snapshots SET resultado_liquido = -221770.83, detalhamento = '{\"receitas\":{}}' WHERE mes=2;"
eq "A7 writer legado sobre snapshot fase 2: fora_dre vira NULL" "$(Pq -c "SELECT coalesce(fora_dre::text,'NULL') FROM public.fin_dre_snapshots WHERE mes=2;")" "NULL"
eq "A7b writer legado: provisório vira NULL (não false)" "$(Pq -c "SELECT coalesce(resultado_provisorio::text,'NULL') FROM public.fin_dre_snapshots WHERE mes=2;")" "NULL"
P -q -c "UPDATE public.fin_dre_snapshots SET detalhamento = '{\"contrato\":{}}', fora_dre = 10, resultado_provisorio = true WHERE mes=2;"
eq "A7c writer novo (com contrato) grava de novo" "$(Pq -c "SELECT fora_dre FROM public.fin_dre_snapshots WHERE mes=2;")" "10.00"
eq "A7d linha de prova da postcondição não ficou (ano 1900)" "$(Pq -c "SELECT count(*) FROM public.fin_dre_snapshots WHERE ano=1900;")" "0"

# ZONA 5b — FALSIFICAÇÃO dos asserts negativos: tira a defesa, exige que o assert VIRE vermelho.
P -q -c "ALTER TABLE public.fin_categoria_dre_mapping DROP CONSTRAINT fin_categoria_dre_mapping_fora_dre_por_empresa_check;"
dente "F-A4" _default "fora_dre"
P -q -c "DELETE FROM public.fin_categoria_dre_mapping WHERE company='_default' AND dre_linha='fora_dre';"
P -q -f "$MIG" && ok "F-A4 restaurado (migration reaplicada)"
rejeita_check "A4 de novo após restaurar" _default "fora_dre"

P -q -c "ALTER TABLE public.fin_categoria_dre_mapping DROP CONSTRAINT fin_categoria_dre_mapping_dre_linha_check;"
dente "F-A3" colacor "despesa_inventada"
P -q -c "DELETE FROM public.fin_categoria_dre_mapping WHERE dre_linha='despesa_inventada';"
P -q -f "$MIG" && ok "F-A3 restaurado"
rejeita_check "A3 de novo após restaurar" colacor "despesa_inventada"

# ══════════════════════════════════════════════════════════════════════════════
# PROVA 2: db/2026-10-13-fin-dre-mapa-colacor-fase2.sql (mapa colacor) — precondição de deploy
#   servido (ledger + janela viva, observação MAIS RECENTE) e postcondição dos 24 pares exatos.
#   Roda como o db:aplicar: UMA transação (--single-transaction), arquivo sem BEGIN/COMMIT.
# ══════════════════════════════════════════════════════════════════════════════
MAPA="$REPO_ROOT/db/2026-10-13-fin-dre-mapa-colacor-fase2.sql"
V_OK="v1.5-dre-fora-dre-composicao"
F_OK=$(sed -n "s/^  v_fonte_esperada  constant text := '\([0-9a-f]*\)';$/\1/p" "$MAPA")
eq "M0 hash esperado do script = fingerprint versionado da omie-financeiro" \
  "$F_OK" "$(sed -n 's/^  "omie-financeiro": "\([0-9a-f]*\)",$/\1/p' "$REPO_ROOT/supabase/functions/_shared/sonda-fingerprints.ts")"
P -q <<'SQL'
ALTER TABLE public.fin_categoria_dre_mapping ADD COLUMN notas text;
CREATE TABLE public.deploy_atestacoes (request_id bigint, observado_em timestamptz, edge text, versao text, fonte text, via text);
CREATE TABLE public._janela (request_id bigint, observado_em timestamptz, edge text, versao text, fonte text, via text);
CREATE FUNCTION public.deploy_atestacoes_janela_viva()
  RETURNS TABLE(request_id bigint, observado_em timestamptz, edge text, versao text, fonte text, via text)
  LANGUAGE sql STABLE AS $f$ SELECT request_id, observado_em, edge, versao, fonte, via FROM public._janela $f$;
SQL
n_mapa() { Pq -c "SELECT count(*) FROM public.fin_categoria_dre_mapping WHERE notas LIKE 'DRE fase 2:%';"; }
roda_mapa() { # $1 rótulo · $2 sentinela esperada (precondicao|postcondicao|OK) · $3 arquivo (opcional)
  local out f="${3:-$MAPA}"
  if out=$(P -q --single-transaction -f "$f" 2>&1); then
    [ "$2" = OK ] && ok "$1" || bad "$1 — devia falhar com $2 e PASSOU"
  else
    case "$out" in *"$2:"*) [ "$2" != OK ] && ok "$1 ($2 abortou)" || bad "$1 — falhou: ${out:0:200}" ;;
      *) bad "$1 — falhou por outro motivo: ${out:0:200}" ;; esac
  fi
}
# motor velho servido (v1.4) → nada entra
P -q -c "INSERT INTO public.deploy_atestacoes VALUES (1, now() - interval '2 hours', 'omie-financeiro', 'v1.4-resumo-movimento-tipado', 'aaa', 'sonda');"
roda_mapa "M1 motor v1.4 servido: precondição barra" precondicao
eq "M1b nada inserido" "$(n_mapa)" "0"
# v1.5 com hash ERRADO → barra
P -q -c "INSERT INTO public.deploy_atestacoes VALUES (2, now() - interval '1 hour', 'omie-financeiro', '$V_OK', 'hash-de-outro-bundle', 'sonda');"
roda_mapa "M2 versão certa, fonte errada: barra" precondicao
# v1.5 certo no ledger, mas a janela viva tem observação MAIS NOVA divergente (rollback) → barra
P -q -c "INSERT INTO public.deploy_atestacoes VALUES (3, now() - interval '30 minutes', 'omie-financeiro', '$V_OK', '$F_OK', 'sonda');"
P -q -c "INSERT INTO public._janela VALUES (4, now() - interval '1 minute', 'omie-financeiro', 'v1.4-resumo-movimento-tipado', 'aaa', 'eco');"
roda_mapa "M3 observação mais nova divergente (janela viva): barra" precondicao
eq "M3b nada inserido" "$(n_mapa)" "0"
# FALSIFICAÇÃO da precondição: sem o IF, o mesmo estado (rollback) deixaria o mapa entrar
sed "s/  IF v.versao IS DISTINCT FROM v_versao_esperada OR v.fonte IS DISTINCT FROM v_fonte_esperada THEN/  IF false THEN/" "$MAPA" > "$TMPD/mapa-sab.sql"
if cmp -s "$TMPD/mapa-sab.sql" "$MAPA"; then bad "F-M3 sed não aplicou"; else
  roda_mapa "F-M3 precondição sabotada: o mapa ENTRA (o assert M3 tem dente)" OK "$TMPD/mapa-sab.sql"
  P -q -c "DELETE FROM public.fin_categoria_dre_mapping WHERE notas LIKE 'DRE fase 2:%';"
fi
# motor certo é o mais recente → entra
P -q -c "DELETE FROM public._janela; INSERT INTO public._janela VALUES (5, now(), 'omie-financeiro', '$V_OK', '$F_OK', 'cron');"
roda_mapa "M4 motor v1.5 com a fonte esperada servido: aplica" OK
eq "M4b 24 pares" "$(n_mapa)" "24"
eq "M4c 14 fora_dre colacor" "$(Pq -c "SELECT count(*) FROM public.fin_categoria_dre_mapping WHERE notas LIKE 'DRE fase 2:%' AND dre_linha='fora_dre' AND company='colacor';")" "14"
eq "M4d 2.06.01 → ded_icms" "$(Pq -c "SELECT dre_linha FROM public.fin_categoria_dre_mapping WHERE company='colacor' AND omie_codigo='2.06.01';")" "ded_icms"
eq "M4e 2.09 pai NÃO mapeado (não herda por prefixo)" "$(Pq -c "SELECT count(*) FROM public.fin_categoria_dre_mapping WHERE omie_codigo='2.09';")" "0"
roda_mapa "M5 reaplicação idempotente" OK
eq "M5b ainda 24" "$(n_mapa)" "24"
# postcondição: código já mapeado para OUTRA linha → aborta em vez de conviver
P -q -c "DELETE FROM public.fin_categoria_dre_mapping WHERE notas LIKE 'DRE fase 2:%'; INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha) VALUES ('colacor','2.06.01','despesas_administrativas');"
roda_mapa "M6 conflito pré-existente (2.06.01 administrativas): postcondição aborta" postcondicao
eq "M6b rollback: nenhum par fase 2" "$(n_mapa)" "0"
# FALSIFICAÇÃO da postcondição: sem o IF dos 24, o conflito conviveria em silêncio
sed "s/  IF v_ok IS DISTINCT FROM 24 THEN/  IF false THEN/" "$MAPA" > "$TMPD/mapa-sab2.sql"
roda_mapa "F-M6 postcondição sabotada: conflito PASSA (o assert M6 tem dente)" OK "$TMPD/mapa-sab2.sql"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
