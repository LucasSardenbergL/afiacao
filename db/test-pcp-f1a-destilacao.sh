#!/usr/bin/env bash
# Prova PG17 — destilação da BOM: recupera coeficientes da malha REAL (print KA169) e pega malha podre.
# Rodar: bash db/test-pcp-f1a-destilacao.sh > /tmp/t-dest.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="pcp-dest"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q "$@"; }  # -q OBRIGATÓRIO: sem ele, "SET ...; SELECT ..." vaza linhas SET na captura

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ ZONA 1: pré-requisitos + stub omie_products ═══"
P -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
CREATE TABLE public.omie_products (omie_codigo_produto bigint PRIMARY KEY, codigo text, descricao text,
  familia text, tipo_produto text, account text, metadata jsonb NOT NULL DEFAULT '{}');
-- staff (aaaa) e não-staff (bbbb) para a matriz RLS da ZONA 6
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000aaaa','employee');
SQL

echo "═══ ZONA 2: aplica M1 + M2 REAIS (M2 2×: re-colar no SQL Editor é esperado) ═══"
P -q -f "$REPO_ROOT/db/pcp-f1a-m1-staging.sql"
P -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql"
if P -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql" >/dev/null 2>&1; then ok "M2 re-aplicável (2ª colagem não quebra)"; else bad "M2 re-aplicação QUEBROU"; fi

echo "═══ ZONA 3: fixtures — produtos + 3 malhas KA169 (1 REAL do print + 2 sintéticas coerentes) ═══"
P -q <<'SQL'
-- sync_run_id é NOT NULL (M1): cria 1 run e dá DEFAULT temporário p/ os INSERTs de staging
-- (que omitem a coluna) não violarem a constraint — sem tocar nas tuplas de payload.
INSERT INTO public.pcp_run_logs (id, funcao, status) OVERRIDING SYSTEM VALUE VALUES (1,'omie-malha-sync','ok');
ALTER TABLE public.pcp_malha_staging ALTER COLUMN sync_run_id SET DEFAULT 1;
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, familia, tipo_produto, account) VALUES
 (4396000531,'PRD01832','CINTA KA169 150X6200MM P50','Cintas Estreitas','04','colacor'),
 (800002,'PRD80002','CINTA KA169 75X2000MM P80','Cintas Estreitas','04','colacor'),
 (800003,'PRD80003','CINTA KA169 300X3000MM P50','Cintas Estreitas','04','colacor'),
 (900001,'PRD90001','ROLO KA169 150X50000MM P50','Jumbo/Rolo de Lixa Óxido de Alumínio','03','colacor'),
 (900005,'PRD90005','ROLO KA169 75X50000MM P80','Jumbo/Rolo de Lixa Óxido de Alumínio','03','colacor'),
 (900006,'PRD90006','ROLO KA169 300X50000MM P50','Jumbo/Rolo de Lixa Óxido de Alumínio','03','colacor'),
 (900002,'PRD90002','A455 20% SHELDAHL ADESIVO','Colas','01','colacor'),
 (900003,'PRD90003','DESMODUR NE-S','Catalisadores PU','01','colacor'),
 (900004,'PRD90004','FITA SHELDAHL T188467 19MMX100M BLUE','Uso e Consumo','01','colacor');

INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload) VALUES
 (4396000531, '{"ident":{"idProduto":4396000531,"codProduto":"PRD01832"},"itens":[
   {"ident":{"idProdMalha":900001,"codProdMalha":"PRD90001","descrProdMalha":"ROLO KA169 150X50000MM P50"},"quantProdMalha":0.93,"unidProdMalha":"M2"},
   {"ident":{"idProdMalha":900002,"codProdMalha":"PRD90002","descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":1.611,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900003,"codProdMalha":"PRD90003","descrProdMalha":"DESMODUR NE-S"},"quantProdMalha":0.179,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900004,"codProdMalha":"PRD90004","descrProdMalha":"FITA SHELDAHL T188467 19MMX100M BLUE"},"quantProdMalha":16.9,"unidProdMalha":"CM"}]}'::jsonb),
 (800002, '{"ident":{"idProduto":800002,"codProduto":"PRD80002"},"itens":[
   {"ident":{"idProdMalha":900005,"codProdMalha":"PRD90005","descrProdMalha":"ROLO KA169 75X50000MM P80"},"quantProdMalha":0.15,"unidProdMalha":"M2"},
   {"ident":{"idProdMalha":900002,"codProdMalha":"PRD90002","descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":0.8055,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900003,"codProdMalha":"PRD90003","descrProdMalha":"DESMODUR NE-S"},"quantProdMalha":0.0895,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900004,"codProdMalha":"PRD90004","descrProdMalha":"FITA SHELDAHL T188467 19MMX100M BLUE"},"quantProdMalha":9.4,"unidProdMalha":"CM"}]}'::jsonb),
 (800003, '{"ident":{"idProduto":800003,"codProduto":"PRD80003"},"itens":[
   {"ident":{"idProdMalha":900006,"codProdMalha":"PRD90006","descrProdMalha":"ROLO KA169 300X50000MM P50"},"quantProdMalha":0.9,"unidProdMalha":"M2"},
   {"ident":{"idProdMalha":900002,"codProdMalha":"PRD90002","descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":3.222,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900003,"codProdMalha":"PRD90003","descrProdMalha":"DESMODUR NE-S"},"quantProdMalha":0.358,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900004,"codProdMalha":"PRD90004","descrProdMalha":"FITA SHELDAHL T188467 19MMX100M BLUE"},"quantProdMalha":31.9,"unidProdMalha":"CM"}]}'::jsonb);
SQL

echo "═══ ZONA 4: refresh + destilar + validar ═══"
eq "refresh: total|dim|disco|sem_match" "$(Pq -c "SELECT total||'|'||dimensionais||'|'||discos||'|'||sem_match FROM fn_pcp_refresh_itens()")" "9|6|0|3"
eq "linha_modelo veio do token da descrição" "$(Pq -c "SELECT linha_modelo FROM pcp_itens WHERE omie_codigo_produto=4396000531")" "KA169"
eq "destilar: nº de regras (4 papéis × [KA169 + *])" "$(Pq -c "SELECT fn_pcp_destilar_bom()")" "8"
eq "coef cola g/mm (mediana)"   "$(Pq -c "SELECT round(coef,5) FROM pcp_bom_regras WHERE linha_modelo='KA169' AND papel='cola'")" "0.01074"
eq "coef catalisador (razão)"   "$(Pq -c "SELECT round(coef,4) FROM pcp_bom_regras WHERE linha_modelo='KA169' AND papel='catalisador'")" "0.1111"
eq "coef fita (overlap cm)"     "$(Pq -c "SELECT round(coef,2) FROM pcp_bom_regras WHERE linha_modelo='KA169' AND papel='fita'")" "1.90"
eq "validação: 12/12 ok"        "$(Pq -c "SELECT count(*) FILTER (WHERE status='ok')||'/'||count(*) FROM vw_pcp_bom_validacao")" "12/12"
eq "materializar: 0 exceções"   "$(Pq -c "SELECT fn_pcp_materializar_excecoes()")" "0"

echo "═══ ZONA 5: FALSIFICAÇÃO — malha PODRE (cola 10×) TEM que virar exceção ═══"
P -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, familia, tipo_produto, account) VALUES
 (800004,'PRD80004','CINTA KA169 100X1000MM P60','Cintas Estreitas','04','colacor'),
 (900007,'PRD90007','ROLO KA169 100X50000MM P60','Jumbo/Rolo de Lixa Óxido de Alumínio','03','colacor');
INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload) VALUES
 (800004, '{"ident":{"idProduto":800004,"codProduto":"PRD80004"},"itens":[
   {"ident":{"idProdMalha":900007,"codProdMalha":"PRD90007","descrProdMalha":"ROLO KA169 100X50000MM P60"},"quantProdMalha":0.1,"unidProdMalha":"M2"},
   {"ident":{"idProdMalha":900002,"codProdMalha":"PRD90002","descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":10.74,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900004,"codProdMalha":"PRD90004","descrProdMalha":"FITA SHELDAHL T188467 19MMX100M BLUE"},"quantProdMalha":11.9,"unidProdMalha":"CM"}]}'::jsonb);
SQL
P -q -c "SELECT fn_pcp_refresh_itens();" >/dev/null
# NÃO re-destila: as regras ficam as derivadas do conjunto limpo (fluxo incremental real).
EXC=$(Pq -c "SELECT fn_pcp_materializar_excecoes()")
eq "sabotagem materializou 1 exceção" "$EXC" "1"
eq "a exceção é a cola do pai sabotado" "$(Pq -c "SELECT pai_codigo||'|'||papel||'|'||status FROM pcp_bom_excecoes")" "800004|cola|excecao"
eq "esperado da exceção ≈ 1.074 g (0.01074×100)" "$(Pq -c "SELECT round(esperado,3) FROM pcp_bom_excecoes")" "1.074"

echo "═══ ZONA 6: endurecimentos do painel (fn_num, papel, regra instável, sem_base_cola, unidade, RLS, disposição) ═══"
eq "fn_pcp_num tolera vírgula pt-BR" "$(Pq -c "SELECT fn_pcp_num('1,611')")" "1.611"
eq "fn_pcp_num: lixo vira NULL (nunca fabrica)" "$(Pq -c "SELECT coalesce(fn_pcp_num('16,9 CM')::text,'nulo')")" "nulo"
eq "papel: FITA ADESIVA é fita (não cola)" "$(Pq -c "SELECT fn_pcp_papel_componente('FITA ADESIVA 25MM','Uso e Consumo')")" "fita"
eq "papel: COLA PU é cola" "$(Pq -c "SELECT fn_pcp_papel_componente('COLA PU BICOMPONENTE','Colas')")" "cola"

# Linha ZZ com cola DISPERSA (ratios 0.01/0.02/0.04 ⇒ MAD rel 0.5 > 0.10) — regra instável não valida ninguém.
# Pai XY: catalisador SEM cola no pai + cola em KG (unidade errada).
P -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, familia, tipo_produto, account) VALUES
 (810001,'PRD81001','CINTA ZZ9 100X1000MM P50','Cintas Estreitas','04','colacor'),
 (810002,'PRD81002','CINTA ZZ9 100X1000MM P80','Cintas Estreitas','04','colacor'),
 (810003,'PRD81003','CINTA ZZ9 100X1000MM P120','Cintas Estreitas','04','colacor'),
 (810004,'PRD81004','CINTA XY7 100X1000MM P50','Cintas Estreitas','04','colacor');
INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload) VALUES
 (810001,'{"ident":{"idProduto":810001},"itens":[{"ident":{"idProdMalha":900002,"descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":1.0,"unidProdMalha":"G"}]}'::jsonb),
 (810002,'{"ident":{"idProduto":810002},"itens":[{"ident":{"idProdMalha":900002,"descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":2.0,"unidProdMalha":"G"}]}'::jsonb),
 (810003,'{"ident":{"idProduto":810003},"itens":[{"ident":{"idProdMalha":900002,"descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":4.0,"unidProdMalha":"G"}]}'::jsonb),
 (810004,'{"ident":{"idProduto":810004},"itens":[
   {"ident":{"idProdMalha":900003,"descrProdMalha":"DESMODUR NE-S"},"quantProdMalha":0.111,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900002,"descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":0.001,"unidProdMalha":"KG"}]}'::jsonb);
SQL
P -q -c "SELECT fn_pcp_refresh_itens();" >/dev/null
eq "re-destilar com universo maior (KA169 4 + ZZ9 cola + '*' 4)" "$(Pq -c "SELECT fn_pcp_destilar_bom()")" "9"
eq "regra ZZ9/cola nasceu INSTÁVEL (MAD rel 0.5)" "$(Pq -c "SELECT round(dispersao,2) FROM pcp_bom_regras WHERE linha_modelo='ZZ9' AND papel='cola'")" "0.50"
eq "validação marca as 3 colas ZZ9 como regra_instavel" "$(Pq -c "SELECT count(*) FROM vw_pcp_bom_validacao WHERE status='regra_instavel'")" "3"
eq "catalisador sem cola G no pai ⇒ sem_base_cola" "$(Pq -c "SELECT status FROM vw_pcp_bom_validacao WHERE pai_codigo=810004 AND papel='catalisador'")" "sem_base_cola"
eq "cola em KG ⇒ unidade_inesperada" "$(Pq -c "SELECT status FROM vw_pcp_bom_validacao WHERE pai_codigo=810004 AND papel='cola'")" "unidade_inesperada"
eq "materializar: 6 exceções (1 sabotada + 3 instáveis + 2 do XY7)" "$(Pq -c "SELECT fn_pcp_materializar_excecoes()")" "6"

echo "── matriz RLS (painel: TODAS as pcp_% fail-closed) ──"
eq "6 tabelas pcp_% com RLS ligado" "$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'pcp\\_%' AND c.relkind='r' AND c.relrowsecurity")" "6"
eq "staff vê pcp_bom_regras" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*)>0 FROM pcp_bom_regras")" "t"
eq "não-staff vê 0 em pcp_bom_regras (fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM pcp_bom_regras")" "0"

echo "── governança da disposição (helper staff-gated + grant de coluna) ──"
eq "staff dispõe via helper" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT fn_pcp_dispor_excecao(800004,'cola',900002,'aceitar','conferido no print')")" "t"
P -q -c "SELECT fn_pcp_materializar_excecoes();" >/dev/null
eq "re-materializar PRESERVA a disposição" "$(Pq -c "SELECT count(*) FROM pcp_bom_excecoes WHERE disposicao='aceitar'")" "1"
NS_ERR=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT fn_pcp_dispor_excecao(800004,'cola',900002,'aceitar',NULL);" 2>&1 || true)
case "$NS_ERR" in *"apenas staff"*) ok "não-staff barrado no helper (fail-closed)";; *) bad "não-staff NÃO barrado: $NS_ERR";; esac
COL_ERR=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; UPDATE pcp_bom_excecoes SET observado=1 WHERE pai_codigo=800004;" 2>&1 || true)
case "$COL_ERR" in *"permission denied"*) ok "UPDATE cru de coluna não permitida bloqueado (grant de coluna)";; *) bad "UPDATE de observado NÃO bloqueado: $COL_ERR";; esac

echo ""
echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
