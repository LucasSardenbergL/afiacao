#!/usr/bin/env bash
# Teste PG17 da migration 20260626193000 (de-para Sayerlack AUTOMÁTICO — money-path).
# Aplica schema-snapshot + a migration e valida a RPC reposicao_aplicar_depara_sayerlack_auto
# em asserts: insere elegível, pula já-existente, rejeita fabricado (re-valida elegibilidade),
# REJEITA colisão de destino, idempotência (2ª rodada 0 inseridos), gate service_role (42501),
# e FALSIFICA (remove o gate de colisão → a colisão passa = vermelho esperado).
# Base: db/test-alerta-pedido-minimo.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5439
DATA="$(mktemp -d /tmp/pgtest-deparaauto.XXXXXX)/data"
export LC_ALL=C LANG=C
FAILS=0
chk() { # chk "rótulo" "esperado" "obtido"
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1 — esperado [$2] obtido [$3]"; FAILS=$((FAILS+1)); fi
}

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-deparaauto.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres deparaauto_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d deparaauto_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-deparaauto.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ aplica a migration 20260626193000 (de-para auto)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260626193000_reposicao_depara_sayerlack_auto.sql" >/dev/null

echo "→ auth.role() = service_role (a RPC é chamada pela edge/cron)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
SQL

echo "→ seed: catálogo OBEN + de-paras pré-existentes…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- catálogo: 1001 elegível (insere), 1002 já tem de-para, 1003 fabricado '04', 1004 colide, 1005 dono do destino
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, unidade, valor_unitario, ativo, account, tipo_produto)
VALUES
 (1001,'PRDX1','VERNIZ PU FOA05.6717.00BH','BH',100,true,'oben','00'),
 (1002,'PRDX2','VERNIZ PU FOSCO FO5.6717.00BH','BH',100,true,'oben','00'),
 (1003,'PRDX3','PRODUTO FABRICADO FAB.1234.00QT','QT',100,true,'oben','04'),
 (1004,'PRDX4','VERNIZ PU COLISAO CO.9999.00BH','BH',100,true,'oben','00'),
 (1005,'PRDX5','VERNIZ PU DONO CO.9999.00BH','BH',100,true,'oben','00'),
 -- 1006/1007: dois SKUs DIFERENTES com o MESMO código Sayerlack na descrição (duplicata no Omie)
 (1006,'PRDX6','VERNIZ PU INTRA IN.7777.00BH','BH',100,true,'oben','00'),
 (1007,'PRDX7','VERNIZ PU INTRA IN.7777.00BH','BH',100,true,'oben','00');
-- de-paras pré-existentes: 1002 (→ ja_existe) e 1005 (dono do destino CO.9999.00BH → 1004 colide)
INSERT INTO public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, unidade_portal, fator_conversao, ativo)
VALUES
 ('OBEN','RENNER SAYERLACK S/A','1002','FO5.6717.00BH','BH',1,true),
 ('OBEN','RENNER SAYERLACK S/A','1005','CO.9999.00BH','BH',1,true);
SQL

echo "→ ASSERT 1: view de elegibilidade lista 1001 e 1004, NÃO 1002/1003/1005…"
chk "1001 elegível"        "t" "$(P -tA -c "SELECT EXISTS(SELECT 1 FROM v_reposicao_depara_sayerlack_elegivel WHERE sku_omie='1001')")"
chk "1004 elegível"        "t" "$(P -tA -c "SELECT EXISTS(SELECT 1 FROM v_reposicao_depara_sayerlack_elegivel WHERE sku_omie='1004')")"
chk "1002 fora (tem de-para)" "f" "$(P -tA -c "SELECT EXISTS(SELECT 1 FROM v_reposicao_depara_sayerlack_elegivel WHERE sku_omie='1002')")"
chk "1003 fora (fabricado 04)" "f" "$(P -tA -c "SELECT EXISTS(SELECT 1 FROM v_reposicao_depara_sayerlack_elegivel WHERE sku_omie='1003')")"
chk "1005 fora (tem de-para)" "f" "$(P -tA -c "SELECT EXISTS(SELECT 1 FROM v_reposicao_depara_sayerlack_elegivel WHERE sku_omie='1005')")"

echo "→ ASSERT 2: 1ª chamada da RPC com os 4 candidatos…"
RET=$(P -tA -F',' -c "SELECT * FROM reposicao_aplicar_depara_sayerlack_auto('[
  {\"sku_omie\":\"1001\",\"sku_portal\":\"FOA05.6717.00BH\",\"unidade_portal\":\"BH\",\"sku_descricao\":\"VERNIZ PU FOA05.6717.00BH\"},
  {\"sku_omie\":\"1002\",\"sku_portal\":\"FO5.6717.00BH\",\"unidade_portal\":\"BH\",\"sku_descricao\":\"VERNIZ PU FOSCO FO5.6717.00BH\"},
  {\"sku_omie\":\"1003\",\"sku_portal\":\"FAB.1234.00QT\",\"unidade_portal\":\"QT\",\"sku_descricao\":\"PRODUTO FABRICADO\"},
  {\"sku_omie\":\"1004\",\"sku_portal\":\"CO.9999.00BH\",\"unidade_portal\":\"BH\",\"sku_descricao\":\"VERNIZ PU COLISAO\"}
]'::jsonb, 2, gen_random_uuid())")
chk "retorno (ins,col,exi,nel)=(1,1,1,1)" "1,1,1,1" "$RET"

echo "→ ASSERT 3: efeito no banco…"
chk "1001 inserido em sku_fornecedor_externo" "FOA05.6717.00BH" "$(P -tA -c "SELECT sku_portal FROM sku_fornecedor_externo WHERE empresa='OBEN' AND sku_omie='1001'")"
chk "1004 NÃO inserido (colisão)" "0" "$(P -tA -c "SELECT count(*) FROM sku_fornecedor_externo WHERE sku_omie='1004'")"
chk "audit 1001=inserido"        "inserido"        "$(P -tA -c "SELECT resultado FROM reposicao_depara_auto_log WHERE sku_omie='1001'")"
chk "audit 1002=ja_existe"       "ja_existe"       "$(P -tA -c "SELECT resultado FROM reposicao_depara_auto_log WHERE sku_omie='1002'")"
chk "audit 1003=nao_elegivel"    "nao_elegivel"    "$(P -tA -c "SELECT resultado FROM reposicao_depara_auto_log WHERE sku_omie='1003'")"
chk "audit 1004=colisao_destino" "colisao_destino" "$(P -tA -c "SELECT resultado FROM reposicao_depara_auto_log WHERE sku_omie='1004'")"

echo "→ ASSERT 4: idempotência (2ª chamada igual → 0 inseridos, 1001 agora ja_existe)…"
RET2=$(P -tA -F',' -c "SELECT * FROM reposicao_aplicar_depara_sayerlack_auto('[
  {\"sku_omie\":\"1001\",\"sku_portal\":\"FOA05.6717.00BH\",\"unidade_portal\":\"BH\",\"sku_descricao\":\"x\"}
]'::jsonb, 2, NULL)")
chk "2ª rodada (0,0,1,0)" "0,0,1,0" "$RET2"
chk "1001 não duplicou" "1" "$(P -tA -c "SELECT count(*) FROM sku_fornecedor_externo WHERE sku_omie='1001'")"

echo "→ ASSERT 5: gate service_role (auth.role()≠service_role → 42501)…"
P -v ON_ERROR_STOP=1 -q -c "CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$\$ SELECT 'authenticated'::text \$\$;"
SQLSTATE=$(P -tA -c "DO \$\$ BEGIN
  PERFORM reposicao_aplicar_depara_sayerlack_auto('[]'::jsonb, NULL, NULL);
  RAISE EXCEPTION 'NAO_BLOQUEOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK_42501';
  WHEN OTHERS THEN RAISE EXCEPTION 'SQLSTATE inesperada: %', SQLSTATE;
END \$\$;" 2>&1 | grep -oE "OK_42501|NAO_BLOQUEOU|SQLSTATE inesperada" | head -1)
chk "gate barra não-service_role com 42501" "OK_42501" "$SQLSTATE"
# restaura service_role para a falsificação
P -v ON_ERROR_STOP=1 -q -c "CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$\$ SELECT 'service_role'::text \$\$;"

echo "→ ASSERT 6: colisão INTRA-BATCH (2 SKUs, mesmo portal no mesmo lote → 1 insere, 1 colide)…"
RET3=$(P -tA -F',' -c "SELECT * FROM reposicao_aplicar_depara_sayerlack_auto('[
  {\"sku_omie\":\"1006\",\"sku_portal\":\"IN.7777.00BH\",\"unidade_portal\":\"BH\",\"sku_descricao\":\"x\"},
  {\"sku_omie\":\"1007\",\"sku_portal\":\"IN.7777.00BH\",\"unidade_portal\":\"BH\",\"sku_descricao\":\"x\"}
]'::jsonb, 2, NULL)")
chk "intra-batch (1 ins, 1 col, 0, 0)" "1,1,0,0" "$RET3"
chk "só 1 dos 2 duplicados ganhou de-para" "1" "$(P -tA -c "SELECT count(*) FROM sku_fornecedor_externo WHERE sku_omie IN ('1006','1007')")"

echo "→ ASSERT 7 (FALSIFICAÇÃO): sem o gate de colisão, 1004 É inserido (vermelho esperado)…"
# clona a RPC removendo o ramo de colisão; prova que é ESSE ramo que protege o destino
P -v ON_ERROR_STOP=1 -q <<'SQL'
DELETE FROM sku_fornecedor_externo WHERE sku_omie='1004';  -- limpa qualquer resíduo
CREATE OR REPLACE FUNCTION public.reposicao_aplicar_depara_sayerlack_auto(
  p_candidatos jsonb, p_parser_version int DEFAULT NULL, p_run_id uuid DEFAULT NULL
) RETURNS TABLE(inseridos int, colisao_destino int, ja_existe int, nao_elegivel int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE v_ins int:=0; v_col int:=0; v_exi int:=0; v_nel int:=0; c record; v_res text;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'x' USING ERRCODE='42501'; END IF;
  FOR c IN SELECT * FROM jsonb_to_recordset(COALESCE(p_candidatos,'[]'::jsonb))
           AS x(sku_omie text, sku_portal text, unidade_portal text, sku_descricao text) LOOP
    IF EXISTS (SELECT 1 FROM sku_fornecedor_externo fe WHERE fe.empresa='OBEN'
               AND fe.fornecedor_nome ILIKE '%SAYERLACK%' AND fe.sku_omie=c.sku_omie) THEN
      v_res:='ja_existe'; v_exi:=v_exi+1;
    -- (GATE DE COLISÃO REMOVIDO — sabotagem)
    ELSIF NOT EXISTS (SELECT 1 FROM v_reposicao_depara_sayerlack_elegivel e WHERE e.sku_omie=c.sku_omie) THEN
      v_res:='nao_elegivel'; v_nel:=v_nel+1;
    ELSE
      INSERT INTO sku_fornecedor_externo (empresa,fornecedor_nome,sku_omie,sku_portal,unidade_portal,fator_conversao,ativo)
      VALUES ('OBEN','RENNER SAYERLACK S/A',c.sku_omie,c.sku_portal,'UN',1,true)
      ON CONFLICT (empresa,fornecedor_nome,sku_omie) DO NOTHING;
      v_res:='inserido'; v_ins:=v_ins+1;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_ins,v_col,v_exi,v_nel;
END $f$;
SQL
SAB=$(P -tA -c "SELECT count(*) FROM sku_fornecedor_externo WHERE sku_omie='1004'")  # antes
P -tA -c "SELECT reposicao_aplicar_depara_sayerlack_auto('[{\"sku_omie\":\"1004\",\"sku_portal\":\"CO.9999.00BH\",\"unidade_portal\":\"BH\",\"sku_descricao\":\"x\"}]'::jsonb,2,NULL)" >/dev/null
SAB2=$(P -tA -c "SELECT count(*) FROM sku_fornecedor_externo WHERE sku_omie='1004'")  # depois
# Sem o gate, a colisão É inserida: 0 → 1. Confirma que o gate de colisão é o que protege.
chk "FALSIFICAÇÃO: sem gate, colisão insere (0→1)" "0 1" "$SAB $SAB2"

echo ""
if [ "$FAILS" -eq 0 ]; then echo "✅ TODOS OS ASSERTS PASSARAM (de-para auto provado no PG17)"; else echo "❌ $FAILS ASSERT(S) FALHARAM"; exit 1; fi
