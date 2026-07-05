#!/usr/bin/env bash
# Prova PG17 — modelo de dados do corte múltiplo (rota alternativa + coproduto + rateio de custo).
# Painel tri-modelo (BLOCK) → v3: geometria Σ=base [D] · perda absorve [B] · normalização [C] · valida
# origem+destino [A] · imutabilidade [G] · guard de custo [I] · anti-mistura [E] · INVOKER id-literal [F].
# FALSIFICAÇÃO (Step 8): 4 sabotagens confirmadas vermelhas (Σ>base, DEFINER, sem-CHECK-perda, sem-anti-mistura).
# Rodar: bash db/test-pcp-f1b-m2-corte-multiplo.sh > /tmp/t-m2.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
SLUG="pcp-m2corte"
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
# Cadastro é staff-gated (auth.uid()): prefixe o claim de staff. Como postgres (owner do DEFINER), o gate
# lê o claim e has_role(aaaa,employee)=t. Verificações via Pq puro (postgres) bypassam RLS de propósito.
STAFF="SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa';"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ ZONA 1: pré-requisitos (roles, auth.uid, has_role, staff aaaa) + stub pcp_itens (linha DRV1 [M]) ═══"
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
-- staff (aaaa) = employee; não-staff (bbbb) = sem role (fail-closed)
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000aaaa','employee');
-- stub pcp_itens (colunas usadas pela derivação). Linha DRV1 ISOLADA dos cadastros manuais [M]:
-- 50,100,150 => deriva 100->2x50 (k2) e 150->3x50 (k3); 150%100!=0 (não deriva).
CREATE TABLE public.pcp_itens (
  omie_codigo_produto bigint PRIMARY KEY, linha_modelo text, largura_mm int, tipo_item text);
INSERT INTO public.pcp_itens VALUES
 (1,'DRV1',50,'cinta'),(2,'DRV1',100,'cinta'),(3,'DRV1',150,'cinta');
SQL

echo "═══ ZONA 2: aplica a migration M2 REAL 2× (re-colar no SQL Editor é esperado — idempotável) ═══"
P -q -f "$REPO_ROOT/db/pcp-f1b-m2-corte-multiplo.sql"
if P -q -f "$REPO_ROOT/db/pcp-f1b-m2-corte-multiplo.sql" >/dev/null 2>&1; then ok "migration re-aplicável (2ª colagem não quebra)"; else bad "2ª aplicação QUEBROU"; fi

echo "═══ ZONA 3: rateio simples 150→3×50 (custo R\$30 → 10 cada; fração default) ═══"
eq "cadastro 150->3x50 retorna rota_id" "$(Pq -c "$STAFF SELECT fn_pcp_cadastrar_rota('2909',150,50,'[{\"largura_saida_mm\":50,\"quantidade\":3,\"papel\":\"principal\"}]'::jsonb)>0")" "t"
eq "fração default principal = 1.0" "$(Pq -c "SELECT round(fracao_rateio,4) FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='2909' AND r.largura_base_mm=150 AND r.esquema='padrao'")" "1.0000"
eq "custo_unitario R\$30/3 = 10" "$(Pq -c "SELECT custo_unitario FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='2909' AND largura_base_mm=150 AND largura_alvo_mm=50 AND esquema='padrao'),30)")" "10.0000"

echo "═══ ZONA 4: duas decomposições do MESMO alvo coexistem via 'esquema' + sobra carrega custo ═══"
Pq -c "$STAFF SELECT fn_pcp_cadastrar_rota('2909',150,50,'[{\"largura_saida_mm\":50,\"quantidade\":2,\"papel\":\"principal\"},{\"largura_saida_mm\":50,\"quantidade\":1,\"papel\":\"sobra\"}]'::jsonb, NULL, 'refilo')" >/dev/null
eq "2 esquemas p/ 2909 150->50 coexistem (chave de 4 colunas)" "$(Pq -c "SELECT count(*) FROM pcp_bom_rotas WHERE linha_modelo='2909' AND largura_base_mm=150 AND largura_alvo_mm=50")" "2"
eq "no esquema 'refilo' a sobra CARREGA custo (fração>0)" "$(Pq -c "SELECT fracao_rateio>0 FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='2909' AND r.esquema='refilo' AND s.papel='sobra'")" "t"

echo "═══ ZONA 5: rateio misto 150→100+50 (área 2/3 e 1/3; conservação de R\$90 exata) ═══"
Pq -c "$STAFF SELECT fn_pcp_cadastrar_rota('KA169',150,100,'[{\"largura_saida_mm\":100,\"quantidade\":1,\"papel\":\"principal\"},{\"largura_saida_mm\":50,\"quantidade\":1,\"papel\":\"coproduto\"}]'::jsonb)" >/dev/null
eq "fração 100mm = 2/3" "$(Pq -c "SELECT round(fracao_rateio,4) FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='KA169' AND s.largura_saida_mm=100")" "0.6667"
eq "conservação: Σcusto_total de R\$90 == 90 (resíduo na maior)" "$(Pq -c "SELECT sum(custo_total) FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='KA169'),90)")" "90.0000"
eq "coproduto NÃO fica com custo 0 [E]" "$(Pq -c "SELECT custo_total>0 FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='KA169'),90) WHERE largura_saida_mm=50")" "t"

echo "═══ ZONA 6: perda absorvida — 140→2×50 + 40 perda (Σ=140=base; principal absorve 100%) ═══"
Pq -c "$STAFF SELECT fn_pcp_cadastrar_rota('XZ667',140,50,'[{\"largura_saida_mm\":50,\"quantidade\":2,\"papel\":\"principal\"},{\"largura_saida_mm\":40,\"quantidade\":1,\"papel\":\"perda\"}]'::jsonb)" >/dev/null
eq "perda tem fração 0" "$(Pq -c "SELECT fracao_rateio FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='XZ667' AND s.papel='perda'")" "0"
eq "principal absorve 100%" "$(Pq -c "SELECT round(fracao_rateio,4) FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='XZ667' AND s.papel='principal'")" "1.0000"
eq "rateio ignora a perda e conserva R\$50" "$(Pq -c "SELECT sum(custo_total) FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='XZ667'),50)")" "50.0000"

echo "═══ ZONA 7: derivação isolada (pcp_itens DRV1: 50,100,150 → 2 rotas) [M] ═══"
eq "derivar cria as rotas de fator inteiro" "$(Pq -c "SELECT fn_pcp_derivar_rotas_simples()>0")" "t"
eq "rota derivada DRV1 base150 alvo50 k3" "$(Pq -c "SELECT quantidade FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='DRV1' AND r.largura_base_mm=150 AND r.largura_alvo_mm=50 AND r.nota='derivada F1B-M2'")" "3"
eq "rota derivada DRV1 base100 alvo50 k2" "$(Pq -c "SELECT quantidade FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='DRV1' AND r.largura_base_mm=100 AND r.largura_alvo_mm=50")" "2"
eq "derivada é idempotente (2ª chamada não duplica)" "$(Pq -c "SELECT fn_pcp_derivar_rotas_simples()")" "0"

echo "═══ ZONA 8: invariantes negativos (cada um BARRA com a mensagem certa) ═══"
# [D] geometria Σ=base: 150->2x50 declara só 100mm => material sumiria => BARRA
ERR=$(P -tA -c "${STAFF} BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,50,'[{\"largura_saida_mm\":50,\"quantidade\":2,\"papel\":\"principal\"}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"refilo deve virar"*|*"<> base"*) ok "Σ<base (2x50 de 150) => barra [D]";; *) bad "material sumindo NÃO barrou: $ERR";; esac
# sem principal na alvo
ERR=$(P -tA -c "${STAFF} BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,50,'[{\"largura_saida_mm\":50,\"quantidade\":3,\"papel\":\"coproduto\"}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"principal"*) ok "sem principal na alvo => barra";; *) bad "sem principal NÃO barrou: $ERR";; esac
# Σfração<>1 (TODAS explícitas p/ passar o anti-mistura; 0.9 quebra a conservação)
ERR=$(P -tA -c "${STAFF} BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,50,'[{\"largura_saida_mm\":50,\"quantidade\":3,\"papel\":\"principal\",\"fracao_rateio\":0.9}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"conservado"*) ok "Σfração<>1 => barra";; *) bad "fração ruim NÃO barrou: $ERR";; esac
# [E] mistura: 100→1.0 (explícita) + 50 coproduto omitido. Σfração=1 e geometria OK => o ÚNICO guard é o
#     anti-mistura; sem ele o cadastro passaria com o coproduto a custo 0 (o bug E). => barra "nao misturar".
ERR=$(P -tA -c "${STAFF} BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,100,'[{\"largura_saida_mm\":100,\"quantidade\":1,\"papel\":\"principal\",\"fracao_rateio\":1.0},{\"largura_saida_mm\":50,\"quantidade\":1,\"papel\":\"coproduto\"}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"nao misturar"*) ok "mistura de frações => barra [E]";; *) bad "mistura NÃO barrou: $ERR";; esac
# [B] perda com fração>0: rota 140→2×50+40perda geometricamente VÁLIDA (Σ=140, principal ok, Σfração boas=1)
#     => o ÚNICO invariante violado é o CHECK. Sem o CHECK o cadastro passaria (perda carregaria custo).
ERR=$(P -tA -c "DO \$\$ DECLARE v_r bigint; BEGIN INSERT INTO pcp_bom_rotas(linha_modelo,largura_base_mm,largura_alvo_mm) VALUES('BADP',140,50) RETURNING id INTO v_r; INSERT INTO pcp_bom_rota_saidas(rota_id,largura_saida_mm,quantidade,papel,fracao_rateio) VALUES(v_r,50,2,'principal',1.0); INSERT INTO pcp_bom_rota_saidas(rota_id,largura_saida_mm,quantidade,papel,fracao_rateio) VALUES(v_r,40,1,'perda',0.2); END \$\$;" 2>&1 || true)
case "$ERR" in *"violates"*|*"check"*) ok "perda fração>0 => CHECK barra [B]";; *) bad "perda c/ fração NÃO barrou: $ERR";; esac
# alvo>base => CHECK
ERR=$(P -tA -c "INSERT INTO pcp_bom_rotas(linha_modelo,largura_base_mm,largura_alvo_mm) VALUES('BADA',50,150);" 2>&1 || true)
case "$ERR" in *"check"*|*"violates"*) ok "alvo>base => CHECK barra";; *) bad "alvo>base NÃO barrou: $ERR";; esac
# [G] imutabilidade base/alvo => barra
ERR=$(P -tA -c "UPDATE pcp_bom_rotas SET largura_base_mm=200 WHERE linha_modelo='2909' AND esquema='padrao';" 2>&1 || true)
case "$ERR" in *"imutaveis"*) ok "UPDATE de base => barra [G]";; *) bad "base mutável NÃO barrou: $ERR";; esac
# [I] custo negativo => RAISE
ERR=$(P -tA -c "SELECT fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='2909' AND esquema='padrao'), -5);" 2>&1 || true)
case "$ERR" in *"custo base invalido"*) ok "custo negativo => barra [I]";; *) bad "custo negativo NÃO barrou: $ERR";; esac

echo "═══ ZONA 9: RLS + gate + INVOKER (custo não vaza) — id LITERAL capturado como staff [F] ═══"
eq "2 tabelas de rota com RLS" "$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('pcp_bom_rotas','pcp_bom_rota_saidas') AND c.relrowsecurity")" "2"
eq "staff vê rotas" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*)>0 FROM pcp_bom_rotas")" "t"
eq "não-staff vê 0 rotas (fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM pcp_bom_rotas")" "0"
# [F] capturar o rota_id como postgres (fora de RLS) e passar o LITERAL — senão o SELECT interno sob
#     não-staff daria NULL e mascararia um eventual DEFINER (falso-verde do v2).
RID=$(Pq -c "SELECT id FROM pcp_bom_rotas WHERE linha_modelo='2909' AND esquema='padrao'")
eq "staff VÊ custo via ratear_corte (id literal)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*)>0 FROM fn_pcp_ratear_corte(${RID},100)")" "t"
eq "não-staff NÃO vê custo (INVOKER, id literal) [F]" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM fn_pcp_ratear_corte(${RID},100)")" "0"
NS=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT fn_pcp_cadastrar_rota('X',150,50,'[]'::jsonb);" 2>&1 || true)
case "$NS" in *"apenas staff"*) ok "não-staff barrado no cadastro";; *) bad "não-staff NÃO barrado: $NS";; esac

echo ""
echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
