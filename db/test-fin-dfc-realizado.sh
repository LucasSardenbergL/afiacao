#!/usr/bin/env bash
# PROVA PG17 com FALSIFICAÇÃO — DFC realizado (tabela fin_categoria_fluxo_mapping + view
# v_fin_fluxo_caixa_realizado + script db/2026-11-22-fin-fluxo-mapa-proprio.sql).
#   bash db/test-fin-dfc-realizado.sh > /tmp/t.log 2>&1; echo "exit=$?"
# Cada regra de identidade medida em prod tem um caso: versão da mesma baixa, baixa sem identificador
# sombreada por baixa identificada, órfã, transferência pela ORIGEM, extrato repetido legítimo, conta
# sem mapa, ótica de título e valor 0 fora, RLS pelo INVOKER.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5485}"
SLUG="fin-dfc-realizado"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
# locale do CLUSTER parametrizável: `initdb --locale=C` prevaleceria sobre LC_ALL e a 2ª rodada não
# provaria pt_BR (Codex). O assert Z0 confere o lc_collate efetivo.
PG_LOCALE="${PG_LOCALE:-C}"
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$PG_LOCALE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG="$REPO_ROOT/supabase/migrations/20261122180000_fin_categoria_fluxo_mapping.sql"
MAPA="$REPO_ROOT/db/2026-11-22-fin-fluxo-mapa-proprio.sql"
FIX="$REPO_ROOT/db/fixtures/fin-dre-mapa-proprio-prod-20261122.sql"
TMPD="$(dirname "$DATA")"
for f in "$MIG" "$MAPA" "$FIX"; do [ -f "$f" ] || { echo "FALTA $f"; exit 2; }; done
echo "═══ setup pronto (PG17 :$PORT, locale $PG_LOCALE) ═══"

eq "Z0 lc_collate do cluster é o pedido" "$(Pq -c "SELECT datcollate FROM pg_database WHERE datname = current_database();")" "$PG_LOCALE"
# Simula o ACL padrão do projeto (ALL para authenticated em tabela nova) — a migration tem de REVOGAR o TRUNCATE.
P -q -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;"

# ZONA 1 — pré-requisitos como em PROD: user_roles/app_role, fin_categorias (fixture lida da prod),
# fin_movimentacoes com RLS (staff lê; aqui: só master, para provar o invoker).
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE TABLE public.fin_categoria_dre_mapping (company text, omie_codigo text, dre_linha text, notas text);
CREATE TABLE public.fin_categorias (company text, omie_codigo text, descricao text, updated_at timestamptz);
CREATE TABLE public.fin_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, natureza text, categoria_codigo text,
  categoria_descricao text, valor numeric, data_movimento date, omie_ncodbaixa bigint,
  omie_codigo_lancamento bigint, omie_ncodcc bigint, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
ALTER TABLE public.fin_movimentacoes ENABLE ROW LEVEL SECURITY;
-- como em PROD (fin_user_can_access): STAFF lê a movimentação — quem barra o funcionário é a VIEW.
CREATE POLICY mov_staff ON public.fin_movimentacoes FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('master', 'employee')));
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT ON public.fin_movimentacoes, public.user_roles TO authenticated;
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000000a', 'master'), ('00000000-0000-0000-0000-00000000000b', 'employee');
SQL
P -q -f "$FIX"

# Eventos de setembro/2026 na oben. R = CONTA_CORRENTE_REC, G = CONTA_CORRENTE_PAG.
P -q <<'SQL'
INSERT INTO public.fin_movimentacoes (company, natureza, categoria_codigo, categoria_descricao, valor, data_movimento, omie_ncodbaixa, omie_codigo_lancamento, omie_ncodcc, created_at, updated_at) VALUES
 -- 1+2: a MESMA baixa B1 em duas versões (hash mudou; a velha congelou) ⇒ conta uma vez
 ('oben','BAXR','1.01.03','CONTA_CORRENTE_REC',100,'2026-09-10',1,10,7,'2026-09-10','2026-11-20'),
 ('oben','BAXR','1.01.03','CONTA_CORRENTE_REC',100,'2026-08-31',1,10,7,'2026-09-10','2026-10-01'),  -- versão velha com a data de antes da correção
 -- 3: baixa SEM identificador num título (10) que já tem baixa identificada ⇒ pendente_identidade
 ('oben','BAXR','1.01.03','CONTA_CORRENTE_REC',100,'2026-09-09',NULL,10,7,'2026-09-09','2026-09-09'),
 -- 4: ÓRFÃ (título 20 sem baixa identificada) ⇒ entra no fluxo
 ('oben','BAXP','2.01.01','CONTA_CORRENTE_PAG',50,'2026-09-11',NULL,20,7,'2026-09-11','2026-09-11'),
 -- 5: transferência pareada
 ('oben','TRAP','0.01.02','CONTA_CORRENTE_PAG',30,'2026-09-12',NULL,NULL,7,now(),now()),
 ('oben','TRAR','0.01.01','CONTA_CORRENTE_REC',30,'2026-09-12',NULL,NULL,8,now(),now()),
 -- 6: TRAP com categoria de DESPESA ⇒ ainda transferência (decide a ORIGEM)
 ('oben','TRAP','2.04.01','CONTA_CORRENTE_PAG',7,'2026-09-12',NULL,NULL,7,now(),now()),
 -- 7: duas tarifas iguais no mesmo dia (lançamentos distintos) ⇒ entram as duas
 ('oben','EXTP','2.05.04','CONTA_CORRENTE_PAG',5,'2026-09-13',NULL,NULL,7,now(),now()),
 ('oben','EXTP','2.05.04','CONTA_CORRENTE_PAG',5,'2026-09-13',NULL,NULL,7,now(),now()),
 -- 8: conta sem decisão ⇒ nao_classificado (visível)
 ('oben','BAXP','9.99.99','CONTA_CORRENTE_PAG',20,'2026-09-14',2,30,7,now(),now()),
 -- 9: ótica do TÍTULO (dobraria) e 10: valor 0 ⇒ fora
 ('oben','BAXR','1.01.03','CONTA_A_RECEBER',100,'2026-09-10',1,10,7,now(),now()),
 ('oben','VENR','1.01.03','CONTA_CORRENTE_REC',0,'2026-09-10',NULL,40,7,now(),now()),
 -- 11: juros PAGOS ⇒ financiamento (IFRS 18)
 ('oben','EXTP','2.05.01','CONTA_CORRENTE_PAG',40,'2026-09-15',NULL,NULL,7,now(),now()),
 -- 12: empréstimo pago (parcela) ⇒ fin_amortizacao; aporte ⇒ fin_aporte
 ('oben','BAXP','2.05.03','CONTA_CORRENTE_PAG',300,'2026-09-16',3,50,7,now(),now()),
 ('oben','BAXR','1.04.04','CONTA_CORRENTE_REC',70,'2026-09-17',4,60,7,now(),now()),
 -- 13: baixa B5 CORRIGIDA para 0 (versão nova) — a velha de 80 NÃO pode ressuscitar
 ('oben','BAXP','2.04.01','CONTA_CORRENTE_PAG',80,'2026-09-18',5,70,7,'2026-09-18','2026-09-18'),
 ('oben','BAXP','2.04.01','CONTA_CORRENTE_PAG',0,'2026-09-18',5,70,7,'2026-09-18','2026-11-01'),
 -- 14: sem identificador, título 10 com baixa vencedora de VALOR diferente ⇒ pendente_revisao
 ('oben','BAXR','1.01.03','CONTA_CORRENTE_REC',60,'2026-09-19',NULL,10,7,'2026-09-19','2026-09-19'),
 -- 15: sem identificador, título 10, mas no sentido OPOSTO (pagamento) ⇒ não é a baixa do recebimento: entra
 ('oben','BAXP','2.04.01','CONTA_CORRENTE_PAG',100,'2026-09-20',NULL,10,7,'2026-09-20','2026-09-20'),
 -- 16: IRPJ ⇒ linha própria; 17: resgate de aplicação de liquidez (colacor) ⇒ equivalente_caixa
 ('oben','BAXP','2.06.05','CONTA_CORRENTE_PAG',9,'2026-09-21',6,80,7,now(),now()),
 ('colacor','EXTR','1.04.01','CONTA_CORRENTE_REC',25,'2026-09-22',NULL,NULL,9,now(),now());
SQL

# ── PARTE 1: migration ──
sab_mig() {
  local f="$TMPD/sab-mig.sql" out
  sed "$2" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then bad "F-mig-$1: sed não aplicou"; return; fi
  if out=$(P -q -f "$f" 2>&1); then bad "F-mig-$1: sabotada PASSOU"; return; fi
  case "$out" in *"postcondicao:"*) ok "F-mig-$1: postcondição abortou" ;; *) bad "F-mig-$1: outro motivo: ${out:0:200}" ;; esac
  eq "F-mig-$1: rollback (tabela ausente)" "$(Pq -c "SELECT to_regclass('public.fin_categoria_fluxo_mapping') IS NULL;")" "t"
}
sab_mig "view-sem-invoker" "s/WITH (security_invoker = on) AS/AS/"
sab_mig "sem-rls" "s/^ALTER TABLE public.fin_categoria_fluxo_mapping ENABLE ROW LEVEL SECURITY;/SELECT 1;/"
sab_mig "aceita-default" "s/CHECK (company = ANY (ARRAY\['oben', 'colacor', 'colacor_sc'\]))/CHECK (true)/"
sab_mig "view-sem-predicado-master" "s/     AND public.has_role(auth.uid(), 'master'::public.app_role)/     AND true/"
sab_mig "truncate-herdado" "s/^REVOKE ALL ON public.fin_categoria_fluxo_mapping FROM authenticated;/SELECT 1;/"
sab_mig "anon-le-view" "s/^REVOKE ALL ON public.v_fin_fluxo_caixa_realizado FROM anon;/GRANT SELECT ON public.v_fin_fluxo_caixa_realizado TO anon;/"

P -q -f "$MIG" && ok "M0 migration real aplicou (controle verde, mesma invocação)"
P -q -f "$MIG" && ok "M0b reaplicação idempotente"

# ── PARTE 2: script do mapa ──
if out=$(P -q -1 -f "$MAPA" 2>&1); then ok "S0 mapa aplicou"; else bad "S0 mapa falhou: ${out:0:300}"; fi
P -q -1 -f "$MAPA" && ok "S0b reaplicação idempotente"
eq "S1 229 decisões" "$(Pq -c "SELECT count(*) FROM fin_categoria_fluxo_mapping;")" "229"
FL() { Pq -c "SELECT fluxo_linha FROM fin_categoria_fluxo_mapping WHERE company='$1' AND omie_codigo='$2';"; }
eq "S2 oben parcela de empréstimo → fin_amortizacao" "$(FL oben 2.05.03)" "fin_amortizacao"
eq "S3 oben rendimento de aplicação → inv_rendimentos (IFRS 18)" "$(FL oben 1.02.02)" "inv_rendimentos"
eq "S4 oben parcelamento federal → op_impostos_parcelamento" "$(FL oben 2.06.94)" "op_impostos_parcelamento"
eq "S5 colacor juros pagos → fin_juros" "$(FL colacor 2.05.98)" "fin_juros"
eq "S6 transferências 0.01.* → transferencia_interna" "$(Pq -c "SELECT count(*) FILTER (WHERE fluxo_linha<>'transferencia_interna') FROM fin_categoria_fluxo_mapping WHERE omie_codigo LIKE '0.01%';")" "0"
# descrição reaproveitada aborta e não deixa nada
P -q -c "DELETE FROM fin_categoria_fluxo_mapping;"
P -q -c "UPDATE fin_categorias SET descricao='Conta reaproveitada', updated_at=now() + interval '1 s' WHERE company='oben' AND omie_codigo='2.05.03';"
if out=$(P -q -1 -f "$MAPA" 2>&1); then bad "D1 aplicou com descrição mudada"; else
  case "$out" in *"descricao do Omie mudou"*"oben 2.05.03"*) ok "D1 código reaproveitado aborta" ;; *) bad "D1 outro motivo: ${out:0:200}" ;; esac; fi
eq "D1b rollback" "$(Pq -c "SELECT count(*) FROM fin_categoria_fluxo_mapping;")" "0"
P -q -c "UPDATE fin_categorias SET descricao='Pagamento de Empréstimos', updated_at=now() + interval '2 s' WHERE company='oben' AND omie_codigo='2.05.03';"
P -q -c "INSERT INTO fin_categoria_fluxo_mapping (company, omie_codigo, fluxo_linha) VALUES ('oben','2.05.03','op_despesas');"
if out=$(P -q -1 -f "$MAPA" 2>&1); then bad "C1 aplicou sobre decisão divergente"; else
  case "$out" in *"postcondicao: 228 de 229"*) ok "C1 decisão divergente aborta (228 de 229)" ;; *) bad "C1 outro motivo: ${out:0:200}" ;; esac; fi
P -q -c "DELETE FROM fin_categoria_fluxo_mapping;"
P -q -1 -f "$MAPA" >/dev/null && ok "S7 mapa reaplicado limpo"

# ── PARTE 3: a view ──
V() { P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000a'; SELECT coalesce(string_agg(fluxo_linha||'='||entradas||'/'||saidas, ' ' ORDER BY fluxo_linha),'') FROM v_fin_fluxo_caixa_realizado WHERE company='oben' AND mes='2026-09-01' $1;" | tail -1; }
LINHA() { V "AND fluxo_linha='$1'"; }
eq "V1 recebimento de clientes: a versão congelada NÃO dobra" "$(LINHA op_recebimento_clientes)" "op_recebimento_clientes=100.00/0.00"
eq "V2 baixa sem identificador sombreada ⇒ pendente_identidade (fora das atividades)" "$(LINHA pendente_identidade)" "pendente_identidade=100.00/0.00"
eq "V3 órfã entra no fluxo de fornecedores" "$(LINHA op_fornecedores)" "op_fornecedores=0.00/50.00"
eq "V4 transferência pela ORIGEM (inclui a de categoria de despesa)" "$(LINHA transferencia_interna)" "transferencia_interna=30.00/37.00"
eq "V5 tarifas iguais no mesmo dia entram as duas" "$(LINHA op_tarifas_bancarias)" "op_tarifas_bancarias=0.00/10.00"
eq "V6 conta sem decisão fica visível" "$(LINHA nao_classificado)" "nao_classificado=0.00/20.00"
eq "V7 juros pagos em financiamento" "$(LINHA fin_juros)" "fin_juros=0.00/40.00"
eq "V8 parcela de empréstimo e aporte" "$(LINHA fin_amortizacao) $(LINHA fin_aporte)" "fin_amortizacao=0.00/300.00 fin_aporte=70.00/0.00"
eq "V9 atividade derivada do prefixo" "$(P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000a'; SELECT string_agg(DISTINCT fluxo_linha||':'||atividade, ' ' ORDER BY fluxo_linha||':'||atividade) FROM v_fin_fluxo_caixa_realizado WHERE fluxo_linha IN ('fin_juros','op_fornecedores','transferencia_interna');" | tail -1)" "fin_juros:financiamento op_fornecedores:operacional transferencia_interna:transferencia_interna"
eq "V10 ótica do título, valor 0 e versões velhas fora (total de lançamentos)" "$(P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000a'; SELECT sum(lancamentos) FROM v_fin_fluxo_caixa_realizado;" | tail -1)" "16"
eq "V12b líquido = entradas − saídas na própria view (linha mista)" "$(P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000a'; SELECT liquido FROM v_fin_fluxo_caixa_realizado WHERE company='oben' AND mes='2026-09-01' AND fluxo_linha='transferencia_interna';" | tail -1)" "-7.00"
eq "V12c líquido de saída pura" "$(P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000a'; SELECT liquido FROM v_fin_fluxo_caixa_realizado WHERE company='oben' AND mes='2026-09-01' AND fluxo_linha='fin_juros';" | tail -1)" "-40.00"
eq "V13 baixa corrigida para 0 não ressuscita a versão de 80" "$(LINHA op_despesas)" "op_despesas=0.00/100.00"
eq "V14 só o título coincide (valor diferente) ⇒ pendente_revisao" "$(LINHA pendente_revisao)" "pendente_revisao=60.00/0.00"
eq "V15 IRPJ em linha própria" "$(LINHA op_impostos_lucro)" "op_impostos_lucro=0.00/9.00"
eq "V16 resgate de aplicação (colacor) ⇒ equivalente_caixa, fora das atividades" "$(P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000a'; SELECT fluxo_linha||'|'||atividade||'|'||entradas FROM v_fin_fluxo_caixa_realizado WHERE company='colacor';" | tail -1)" "equivalente_caixa|equivalente_caixa|25.00"
# Funcionário LÊ fin_movimentacoes (política de prod) — só o predicado master da view o barra
eq "V11a employee lê a movimentação direto (pré-condição do teste)" "$(P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000b'; SELECT count(*) > 0 FROM fin_movimentacoes;" | tail -1)" "t"
eq "V11 employee vê 0 linhas pela view" "$(P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000b'; SELECT count(*) FROM v_fin_fluxo_caixa_realizado;" | tail -1)" "0"

# F-view: cada regra sabotada na migration (copiada) tem de deixar um assert V vermelho.
sab_view() { # $1 rótulo · $2 sed · $3 linha a conferir · $4 valor correto (tem de MUDAR)
  local f="$TMPD/sab-view.sql" got
  sed "$2" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then bad "F-view-$1: sed não aplicou"; return; fi
  P -q -c "DROP VIEW v_fin_fluxo_caixa_realizado;"
  if ! P -q -f "$f" >/dev/null 2>&1; then bad "F-view-$1: cópia sabotada NÃO aplicou (assert ficaria vermelho por ausência — teatro)"; P -q -f "$MIG" >/dev/null; return; fi
  if [ "$3" = TOTAL ]; then got="$(TOTAL)"; else got="$(LINHA "$3")"; fi
  if [ "$got" != "$4" ]; then ok "F-view-$1: sabotagem muda $3 ($got)"; else bad "F-view-$1: SEM dente ($got)"; fi
  P -q -c "DROP VIEW v_fin_fluxo_caixa_realizado;" && P -q -f "$MIG" >/dev/null
}
# recebimento de clientes em TODOS os meses (a versão velha está em agosto): com dedupe = 100
TOTAL() { P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000a'; SELECT sum(entradas) FROM v_fin_fluxo_caixa_realizado WHERE company='oben' AND fluxo_linha='op_recebimento_clientes';" | tail -1; }
eq "V12 recebimento de clientes em todos os meses: a versão velha não aparece em agosto" "$(TOTAL)" "100.00"
sab_view "sem-dedupe" "s/  SELECT \* FROM cc WHERE cc.omie_ncodbaixa IS NOT NULL AND cc.rn = 1/  SELECT * FROM cc WHERE cc.omie_ncodbaixa IS NOT NULL/" TOTAL "100.00"
sab_view "sem-pendente" "s/             THEN 'pendente_identidade'/             THEN NULL/" op_recebimento_clientes "op_recebimento_clientes=100.00/0.00"
sab_view "transferencia-pela-categoria" "s/  SELECT e.company, date_trunc('month', e.data_movimento)::date AS mes,/&/; s/         CASE WHEN e.natureza IN ('TRAP', 'TRAR') THEN 'transferencia_interna'/         CASE WHEN false THEN 'transferencia_interna'/" transferencia_interna "transferencia_interna=30.00/37.00"
LIQ() { P -tA -c "SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000000a'; SELECT liquido FROM v_fin_fluxo_caixa_realizado WHERE company='oben' AND mes='2026-09-01' AND fluxo_linha='fin_juros';" | tail -1; }
sab_view_liq() {
  local f="$TMPD/sab-view.sql" got
  sed "s/       round(sum(entrada) - sum(saida), 2) AS liquido,/       0::numeric AS liquido,/" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then bad "F-view-liquido-zerado: sed não aplicou"; return; fi
  P -q -c "DROP VIEW v_fin_fluxo_caixa_realizado;"
  if ! P -q -f "$f" >/dev/null 2>&1; then bad "F-view-liquido-zerado: cópia não aplicou"; P -q -f "$MIG" >/dev/null; return; fi
  got="$(LIQ)"
  if [ "$got" != "-40.00" ]; then ok "F-view-liquido-zerado: sabotagem muda o líquido ($got)"; else bad "F-view-liquido-zerado: SEM dente"; fi
  P -q -c "DROP VIEW v_fin_fluxo_caixa_realizado;" && P -q -f "$MIG" >/dev/null
}
sab_view_liq
sab_view "dedupe-mantem-velha" "s/ORDER BY m.updated_at DESC, m.created_at DESC, m.id DESC/ORDER BY m.updated_at ASC, m.created_at ASC, m.id ASC/" op_recebimento_clientes "op_recebimento_clientes=100.00/0.00"
eq "F-view-controle: view restaurada volta ao verde" "$(LINHA op_recebimento_clientes)" "op_recebimento_clientes=100.00/0.00"

echo "═══ PASS=$PASS FAIL=$FAIL ═══"
[ "$FAIL" -eq 0 ] && echo "PROVA-VERDE-FIM"
[ "$FAIL" -eq 0 ]
