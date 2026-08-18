#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260818121919_authz_fecho_execute_registrado_3_funcoes.sql                    ║
# ║  Rode: bash db/test-authz-fecho-execute-registrado.sh > /tmp/t.log 2>&1; echo "exit=$?"      ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                                      ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
#
# O QUE ESTA PROVA COBRE — e, tão importante quanto, o que ela NÃO cobre.
# ------------------------------------------------------------------------------------------------
# A migration sob teste não tem uma linha de plpgsql: são 3 `REVOKE`. Logo o risco clássico do
# harness PG17 (late-bound — SQL que passa no CREATE e só quebra ao EXECUTAR) não é o risco aqui.
# O risco aqui é de PRIVILÉGIO, e tem três formas, todas provadas EXECUTANDO abaixo:
#   1. o REVOKE não fechar de verdade (a armadilha do `FROM PUBLIC`, nº 1 de docs/agent/database.md);
#   2. o REVOKE fechar DEMAIS e quebrar quem consome (cron, os 2 triggers, service_role);
#   3. o fecho existir no arquivo mas ficar invisível para o gate estático (REVOKE dentro de `DO $$`).
#
# ⚠️ HONESTIDADE SOBRE OS CORPOS: as 3 funções são recriadas aqui com corpo MÍNIMO e observável —
#    não são os corpos de prod. Isso é deliberado e suficiente: a migration não toca corpo nenhum,
#    só ACL, e o que precisa ser fiel para a prova valer é a TRÍPLICE (assinatura exata, SECURITY
#    DEFINER, e o default privilege do schema `public`). As três são fiéis e MEDIDAS em prod
#    (psql-ro 2026-08-15, reconfirmado 2026-08-18). Quem quiser provar a LÓGICA delas está no
#    harness errado.
#
# ⚠️ LOCALE: o postmaster exige LC_ALL=C (sem isso aborta no startup), então este harness o força.
#    Isso não enfraquece nada: toda asserção aqui compara o booleano ASCII `t`/`f` devolvido pelo
#    Postgres — não há `grep -i` sobre string acentuada, que é o acidente do #1483. A prova de
#    dois locales pertence a db/test-authz-funcoes-falsificacao.sh, onde as asserções SÃO strings.
#
# FALSIFICAÇÃO (Lei #3): a sabotagem escreve uma CÓPIA em $TMP, nunca o arquivo do repo — o
# `restaurar()` por `git checkout --` dos harnesses estáticos já apagou trabalho não-commitado
# neste repo, e aqui não há por que correr esse risco.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="authz-fecho-execute"
TMPROOT="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPROOT/data"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20260818121919_authz_fecho_execute_registrado_3_funcoes.sql"
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 2; }

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 2; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPROOT"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# ⚠️ o INVERSO de eq, e é ele que dá dente à falsificação: exige que o valor NÃO seja o esperado.
ne()  { if [ "$2" != "$3" ]; then ok "$1 (veio [$2], ≠ [$3] como a sabotagem exige)"; else bad "$1 — a sabotagem NÃO ficou vermelha: veio [$2], o assert não tem dente"; fi; }

# EXECUTE de <role> sobre <assinatura> → 't'/'f' (ASCII, imune a locale).
hfp() { Pq -c "SELECT has_function_privilege('$1', '$2', 'EXECUTE');"; }

D_SIG='public.detectar_skus_sem_grupo(text)'
S_SIG='public.set_status_envio_portal_on_disparo()'
C_SIG='public.cmc_ledger_capture()'

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: o schema `public` do Supabase + as 3 funções + seus consumidores.
# ══════════════════════════════════════════════════════════════════════════════════════════════
# O default privilege é a PREMISSA de tudo: sem ele o PG local nasce com proacl NULL e o teste
# provaria outra coisa. Valor MEDIDO em pg_default_acl (schema public, objtype 'f'), 2026-08-15.
P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role;
SQL

# Recria do ZERO as 3 funções, tabelas e triggers. Idempotente e re-chamável: cada chamada zera o
# ACL (a função renasce herdando o default privilege), que é o que permite reencenar a
# falsificação num estado limpo sem derrubar o cluster.
estado_pre_migration() {
  P -q <<'SQL'
DROP TABLE IF EXISTS public.pedido_compra_sugerido CASCADE;
DROP TABLE IF EXISTS public.inventory_position     CASCADE;
DROP TABLE IF EXISTS public.cmc_ledger             CASCADE;
DROP FUNCTION IF EXISTS public.detectar_skus_sem_grupo(text);
DROP FUNCTION IF EXISTS public.set_status_envio_portal_on_disparo();
DROP FUNCTION IF EXISTS public.cmc_ledger_capture();

CREATE TABLE public.pedido_compra_sugerido (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status_envio_portal text
);
CREATE TABLE public.inventory_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text, cmc numeric
);
CREATE TABLE public.cmc_ledger (id bigserial PRIMARY KEY, sku text, cmc numeric);

-- assinatura e SECURITY DEFINER fiéis ao prod (medidos); corpo mínimo e observável.
CREATE FUNCTION public.detectar_skus_sem_grupo(p_empresa text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
BEGIN RETURN 42; END $f$;

CREATE FUNCTION public.set_status_envio_portal_on_disparo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
BEGIN NEW.status_envio_portal := 'enviado'; RETURN NEW; END $f$;

CREATE FUNCTION public.cmc_ledger_capture()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
BEGIN INSERT INTO public.cmc_ledger(sku, cmc) VALUES (NEW.sku, NEW.cmc); RETURN NEW; END $f$;

CREATE TRIGGER trg_set_status_envio_portal BEFORE INSERT ON public.pedido_compra_sugerido
  FOR EACH ROW EXECUTE FUNCTION public.set_status_envio_portal_on_disparo();
CREATE TRIGGER trg_cmc_ledger_capture AFTER INSERT ON public.inventory_position
  FOR EACH ROW EXECUTE FUNCTION public.cmc_ledger_capture();

-- O DML é o privilégio que o trigger de fato exige do chamador — ver A9/A10.
GRANT INSERT, SELECT ON public.pedido_compra_sugerido, public.inventory_position TO authenticated;

-- ⇩ o ESTADO DO REPO ANTES desta entrega: exatamente as linhas 31-32 e 64-65 da
--   20260510235956 ("Fatia E3 Fase 1"). cmc_ledger_capture não aparece porque NENHUMA migration
--   do repo emitia GRANT/REVOKE sobre ela — ela fica no default privilege puro.
REVOKE EXECUTE ON FUNCTION public.detectar_skus_sem_grupo(p_empresa text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.detectar_skus_sem_grupo(p_empresa text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.set_status_envio_portal_on_disparo() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_status_envio_portal_on_disparo() TO authenticated, service_role;
SQL
}

estado_pre_migration

# ══════════════════════════════════════════════════════════════════════════════════════════════
# FASE 1 — o estado que o REPO produzia (o problema, medido em vez de alegado)
# ══════════════════════════════════════════════════════════════════════════════════════════════
echo "── fase 1: o que um replay do repo (DR) produzia ANTES desta migration ──"
eq "A1a detectar_skus_sem_grupo: authenticated ALCANÇA (o repo concedia)" "$(hfp authenticated "$D_SIG")" "t"
eq "A1b set_status_envio_portal: authenticated ALCANÇA (o repo concedia)" "$(hfp authenticated "$S_SIG")" "t"
# A pior das três: sem NENHUM grant/revoke no repo, ela nasce alcançável até por `anon`.
eq "A1c cmc_ledger_capture: anon ALCANÇA (default privilege puro)"        "$(hfp anon "$C_SIG")"          "t"
eq "A1d cmc_ledger_capture: authenticated ALCANÇA (default privilege)"    "$(hfp authenticated "$C_SIG")" "t"

# A ARMADILHA nº 1 de docs/agent/database.md, provada em vez de citada: revogar de PUBLIC não
# desfaz o grant NOMEADO que veio do default privilege. É por isso que a migration nomeia as roles.
P -q -c "REVOKE EXECUTE ON FUNCTION public.cmc_ledger_capture() FROM PUBLIC;"
eq "A2 REVOKE FROM PUBLIC NÃO tira authenticated (por isso revoga-se por NOME)" "$(hfp authenticated "$C_SIG")" "t"
eq "A2b REVOKE FROM PUBLIC NÃO tira anon"                                       "$(hfp anon "$C_SIG")"          "t"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado, byte-a-byte)
# ══════════════════════════════════════════════════════════════════════════════════════════════
estado_pre_migration
P -q -f "$MIG"
echo "── fase 2: migration REAL aplicada ($(basename "$MIG")) ──"

eq "A3 detectar_skus_sem_grupo: authenticated NÃO alcança" "$(hfp authenticated "$D_SIG")" "f"
eq "A4 set_status_envio_portal: authenticated NÃO alcança" "$(hfp authenticated "$S_SIG")" "f"
eq "A5 cmc_ledger_capture: authenticated NÃO alcança"      "$(hfp authenticated "$C_SIG")" "f"
eq "A3b detectar_skus_sem_grupo: anon NÃO alcança"         "$(hfp anon "$D_SIG")"          "f"
eq "A4b set_status_envio_portal: anon NÃO alcança"         "$(hfp anon "$S_SIG")"          "f"
eq "A5b cmc_ledger_capture: anon NÃO alcança"              "$(hfp anon "$C_SIG")"          "f"

# O fecho tem de parar EXATAMENTE nas 2 roles do browser: service_role é quem faz as 3 rodarem.
eq "A6a service_role MANTÉM execute (detectar_skus_sem_grupo)" "$(hfp service_role "$D_SIG")" "t"
eq "A6b service_role MANTÉM execute (set_status_envio_portal)" "$(hfp service_role "$S_SIG")" "t"
eq "A6c service_role MANTÉM execute (cmc_ledger_capture)"      "$(hfp service_role "$C_SIG")" "t"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# FASE 3 — OS CONSUMIDORES CONTINUAM FUNCIONANDO (o outro lado do fecho)
# ══════════════════════════════════════════════════════════════════════════════════════════════
echo "── fase 3: os 3 consumidores reais seguem funcionando ──"

# A7 — o caminho do cron `detectar-outliers-diario`, que roda com username=postgres (superuser).
eq "A7 cron (postgres, superuser) executa detectar_skus_sem_grupo" \
   "$(Pq -c "SELECT public.detectar_skus_sem_grupo('OBEN');")" "42"

# A8 — negativo COM SQLSTATE (Lei #2): authenticated é barrado com 42501, e QUALQUER outro erro
#      é re-lançado. Um `WHEN OTHERS THEN 'OK'` aqui pintaria de verde até um erro de digitação.
if P -q >/dev/null 2>&1 <<'SQL'
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM public.detectar_skus_sem_grupo('OBEN');
  RAISE EXCEPTION 'ASSERT_FALHOU_authenticated_executou';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;   -- 42501: o ÚNICO desfecho aceito
  WHEN OTHERS THEN RAISE;
END $$;
SQL
then ok "A8 authenticated barrado com 42501 (insufficient_privilege)"
else bad "A8 authenticated NÃO foi barrado pela SQLSTATE esperada"
fi

# A9/A10 — o ponto que justifica revogar sem medo das 2 funções de trigger: Postgres NÃO checa
# EXECUTE da função de trigger no disparo; o privilégio checado é o DML na TABELA. Sem esta prova,
# "o fecho não quebra os triggers" seria alegação — e uma alegação errada aqui derrubaria compras.
# A escrita e a LEITURA vão em chamadas separadas de propósito: no mesmo `-c`, os command tags
# (`SET`/`INSERT 0 1`/`RESET`) entram na captura e o `eq` compararia o log, não o efeito.
P -q -c "SET ROLE authenticated; INSERT INTO public.pedido_compra_sugerido DEFAULT VALUES;" >/dev/null
eq "A9 trigger BEFORE dispara p/ authenticated SEM execute na função" \
   "$(Pq -c "SELECT status_envio_portal FROM public.pedido_compra_sugerido LIMIT 1;")" \
   "enviado"
P -q -c "SET ROLE authenticated; INSERT INTO public.inventory_position(sku, cmc) VALUES ('SKU-1', 9.9);" >/dev/null
eq "A10 trigger AFTER dispara p/ authenticated SEM execute na função" \
   "$(Pq -c "SELECT count(*) FROM public.cmc_ledger;")" \
   "1"

# A11 — idempotência: o founder pode colar duas vezes no SQL Editor.
P -q -f "$MIG"
eq "A11 re-aplicar a migration é no-op (idempotente)" "$(hfp authenticated "$D_SIG")" "f"

# A12 — a migration precisa manter os REVOKE TOP-LEVEL. Dentro de `DO $$`, eles deixam de ser
#       statements para o parser de scripts/lib/authz-funcoes.ts, a âncora fica MUDA e a migration
#       para de cumprir o que se propõe — sem que nada no banco mude. Falha silenciosa exata.
eq "A12 os 3 REVOKE são top-level (o gate estático consegue lê-los)" \
   "$(command grep -cE '^REVOKE EXECUTE ON FUNCTION public\.' "$MIG")" "3"
# ⚠️ conta só linhas de CÓDIGO: o cabeçalho da migration cita `DO $$` justamente para explicar por
#    que não o usa, e contar o comentário faria este assert falhar sobre a própria documentação.
eq "A12b a migration não embrulha nada em DO \$\$ (invisível ao parser)" \
   "$(command grep -v '^--' "$MIG" | command grep -c 'DO \$\$' || true)" "0"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# FASE 4 — FALSIFICAÇÃO (Lei #3): sabota a migration e EXIGE vermelho pelo motivo certo.
# ══════════════════════════════════════════════════════════════════════════════════════════════
# A sabotagem vai para uma CÓPIA em $TMPROOT — o arquivo do repo nunca é tocado.
echo "── fase 4: falsificação ──"

# F1 — a sabotagem mais perigosa porque é EXATAMENTE o falso-fecho que já existia no repo: revogar
#      de `PUBLIC, anon` e esquecer `authenticated`. Se A3/A4/A5 sobrevivessem a isto, eles não
#      estariam medindo o fecho — estariam medindo o default privilege.
SAB1="$TMPROOT/sabotagem-sem-authenticated.sql"
sed 's/FROM PUBLIC, anon, authenticated;/FROM PUBLIC, anon;/' "$MIG" > "$SAB1"
command grep -q 'FROM PUBLIC, anon;' "$SAB1" || { echo "F1 não casou nada — o harness ficaria verde por vacuidade"; exit 2; }
estado_pre_migration
P -q -f "$SAB1"
ne "F1 sem 'authenticated' no REVOKE → A3 fica VERMELHO" "$(hfp authenticated "$D_SIG")" "f"
ne "F1 sem 'authenticated' no REVOKE → A5 fica VERMELHO" "$(hfp authenticated "$C_SIG")" "f"

# F2 — a sabotagem canônica da armadilha: revogar SÓ de PUBLIC. É o que um autor desavisado
#      escreveria, e o gate/prova têm de recusar.
SAB2="$TMPROOT/sabotagem-so-public.sql"
sed 's/FROM PUBLIC, anon, authenticated;/FROM PUBLIC;/' "$MIG" > "$SAB2"
command grep -q 'FROM PUBLIC;' "$SAB2" || { echo "F2 não casou nada — vacuidade"; exit 2; }
estado_pre_migration
P -q -f "$SAB2"
ne "F2 REVOKE só de PUBLIC → A5 fica VERMELHO (authenticated sobrevive)" "$(hfp authenticated "$C_SIG")" "f"
ne "F2 REVOKE só de PUBLIC → A5b fica VERMELHO (anon sobrevive)"         "$(hfp anon "$C_SIG")"          "f"

# F3 — CONTRAPROVA de F1/F2: sem ela, os `ne` acima passariam mesmo que o harness estivesse
#      quebrado e sempre devolvesse 't'. Restaura a migration VERDADEIRA e exige verde de novo.
estado_pre_migration
P -q -f "$MIG"
eq "F3 contraprova: migration verdadeira volta a fechar (authenticated)" "$(hfp authenticated "$C_SIG")" "f"
eq "F3b contraprova: e service_role continua alcançando"                 "$(hfp service_role "$C_SIG")"  "t"

echo "══════════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "  ✅ prova verde: o fecho fecha, os 3 consumidores seguem, e a sabotagem fica vermelha."
