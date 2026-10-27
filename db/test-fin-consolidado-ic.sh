#!/usr/bin/env bash
# Prova PG17 da eliminação intercompany no DRE consolidado (par CR↔CP e venda intragrupo sem cobrança).
# Migration: supabase/migrations/20261021190000_fin_ic_venda_sem_cobranca.sql (a REAL), aplicada sobre o
# predecessor REAL (o corpo de 20261021120000_fin_consolidado_ic_sinal_cmv.sql, que é o vivo na prod: md5
# 11832f17b7551cabe02a2224cb495aaf, psql-ro 2026-10-21). Os cenários A–P da versão anterior são
# re-exercidos sob a versão nova. Tabelas e has_role entram como stubs com as colunas, o CHECK de status
# e as policies de prod que a função e o trigger tocam.
#
#   A   par elegível: receita E cmv caem pelo MESMO valor; despesas e resultado intactos; ordem fixa
#   N   ausente ≠ zero: mês sem snapshot → bruto NULL; coluna NULL num snapshot → a conta sai NULL
#   C   escopo: par com a origem OU o destino sem snapshot no mês não elimina nem pende
#   S   status não confirmado (divergencia_valor) é ignorado
#   P   par confirmado que toca o mês e NÃO é elegível → eliminação/consolidado NULL nas 4 linhas:
#       P1 sem contrapartida · P2 valor divergente · P3 CP no mês seguinte (os DOIS meses pendem) ·
#       P4 CP fora do CMV · P5 CR cancelado · P13 CR sem status · P6/P11/P11b snapshot que não reflete
#       os títulos de hoje (CP novo na categoria, CR alterado, o par alterado — parecer Codex adversarial) ·
#       P7 CR em 2 pares · P8 eliminação acima do que a categoria compôs · P9 categoria com 2 linhas ·
#       P10 CR de outra empresa
#   Os snapshots da semente são CALCULADOS dos títulos com o recorte do motor (t_calcular), para que a
#   consistência composição × títulos atuais seja testável.
#   U   venda sem cobrança (status intragrupo_sem_cobranca): U1 elimina só do CMV e o resultado sobe ·
#       U2 com par no mesmo mês e categoria · U3 teto soma par + sem cobrança · U4 categoria fora do CMV ·
#       U5/U5b CP cancelado/sem status · U6 snapshot que não reflete os títulos · U7 origem fora da soma ·
#       U8/U9/U12 CR aparecido (mesmo valor / ≤30 dias / sem data) · U10 CR desconsiderado e U10b na outra
#       direção e U11 longe e de outro valor não bloqueiam · U14 marca com CR · U15 CP também num par ·
#       U16 CP de outra empresa · U17 valor 0 · U18 categoria com 2 linhas · Z1 mês sem marca intacto
#       U19–U24 CR aparecido pelo MAPA de identidade, sem linha informativa (apagada pela edge / CR sem
#       emissão) pende; cancelado, outro destino, outra origem, desconsiderado e vínculo não-documento não ·
#       U10c informativa para outro destino não bloqueia
#   T   trigger: só master marca e desfaz; só de sem_contrapartida CP-only; carimbo do trigger; INSERT e
#       DELETE recusados; títulos imutáveis; desfazer só para sem_contrapartida não resolvido
#   G   gate: authenticated sem papel → 42501; employee, master e service_role leem; anon sem EXECUTE
#   MIG PRE aceita o predecessor; re-aplicar passa (inclusive com linha marcada); PRE recusa corpo
#       estranho da RPC e do trigger; grant extra sobrevive; CHECK e trigger conferidos pela PÓS
#
#   bash db/test-fin-consolidado-ic.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-fin-consolidado-ic.sh   # o outro locale (rode os dois)
#   SABOTAGEM=<nome> bash db/test-fin-consolidado-ic.sh            # tem de ficar VERMELHA
#   bash db/test-fin-consolidado-ic.sh --falsificar                # controle verde + cada sabotagem vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261021190000_fin_ic_venda_sem_cobranca.sql"
MIG_PREDECESSOR="$REPO_ROOT/supabase/migrations/20261021120000_fin_consolidado_ic_sinal_cmv.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="sinal:A1 so_receita:A1 coalesce_bruto:N1 nulo_parcial:N2 sem_escopo:C1 sem_status:S1 sem_pendente:P1 valor_igual:P2 mesmo_mes:P3a sem_categoria:P4 multi_linha:P9 cancelado:P5 status_nulo:P13 consist_d:P6 consist_r:P11 uso_unico:P7 teto:P8 empresa_do_titulo:P10 sem_gate:G1
    sc_resultado:U1 sc_cmv:U1 sc_teto:U3 sc_categoria:U4 sc_cancelado:U5 sc_status_nulo:U5b sc_consist:U6 sc_escopo:U7
    sc_cr_aparecido:U8 sc_janela:U11 sc_sem_data:U12 sc_informativos:U10 sc_direcao:U10c sc_marca_cr:U14 sc_uso:U15
    sc_mapa:U19 sc_mapa_sem_data:U20 sc_mapa_cancelado:U21 sc_mapa_destino:U22 sc_origem_cr:U22b sc_mapa_decisao:U23 sc_mapa_fonte:U24
    sc_empresa:U16 sc_valor:U17 sc_multi_linha:U18 sc_pendente:U4 sc_mes:Z1
    trg_master:T1 trg_carimbo:T2 trg_insert:T3 trg_cr:T4 trg_origem:T5 trg_fica:T6 trg_sai_master:T7 trg_sai_destino:T8
    trg_sai_limpa:T9 trg_delete:T10 trg_sem_delete:MIG1 check_sem_status:MIG1"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-fin-consolidado-ic.XXXXXX")"
  echo "══ CONTROLE (mesma invocação, locale ${LOCALE_TESTE:-C}) ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1 || ! grep -q "FIM-OK fin-consolidado-ic" "$LOGDIR/controle.log"; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    if grep -q "FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5489}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-fin-consolidado-ic.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
MIG_ESTRANHA="$WORK/estranha.sql"
PRED="$WORK/predecessor.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal, com \n = quebra de linha; substitui TODAS; padrão ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
de, para = de.replace("\\n", "\n"), para.replace("\\n", "\n")
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  sinal)          sabotar "WHEN d.conta = 'cmv' THEN -(e.valor_par + e.valor_sc)" "WHEN d.conta = 'cmv' THEN (e.valor_par - e.valor_sc)" ;;
  so_receita)     sabotar "WHEN d.conta = 'cmv' THEN -(e.valor_par + e.valor_sc)" "WHEN d.conta = 'cmv' THEN -e.valor_sc" ;;
  coalesce_bruto) sabotar "CASE WHEN count(s.receita_bruta) = count(*) THEN sum(s.receita_bruta) END" "COALESCE(sum(s.receita_bruta), 0)" ;;
  nulo_parcial)   sabotar "CASE WHEN count(s.cmv) = count(*) THEN sum(s.cmv) END" "sum(s.cmv)" ;;
  sem_escopo)     sabotar "      JOIN snap sd ON sd.company = c.empresa_destino" "      LEFT JOIN snap sd ON sd.company = c.empresa_destino" ;;
  sem_status)     sabotar "WHERE m.status IN ('auto_matched', 'manual_matched')" "WHERE m.status IS NOT NULL" ;;
  sem_pendente)   sabotar "SELECT count(*) FILTER (WHERE NOT j.ok) > 0 AS pendente" "SELECT false AS pendente" ;;
  valor_igual)    sabotar " AND e.cr_valor = e.cp_valor" "" ;;
  mesmo_mes)      sabotar "AND e.cr_no_mes AND e.cp_no_mes" "AND e.cr_no_mes" ;;
  sem_categoria)  sabotar "THEN (x.comp_d ->> 'cmv')::numeric END AS comp_d_valor" \
                          "THEN (x.comp_d ->> 'cmv')::numeric ELSE (SELECT sum(j.v::numeric) FROM jsonb_each_text(x.comp_d) AS j(k, v)) END AS comp_d_valor" ;;
  multi_linha)    sabotar "AND (x.comp_d - 'cmv') = '{}'::jsonb" "" ;;
  cancelado)      sabotar "AND e.cr_status <> 'CANCELADO' AND e.cp_status <> 'CANCELADO'" "" ;;
  status_nulo)    sabotar "AND e.cr_status <> 'CANCELADO' AND e.cp_status <> 'CANCELADO'" \
                          "AND e.cr_status IS DISTINCT FROM 'CANCELADO' AND e.cp_status IS DISTINCT FROM 'CANCELADO'" ;;
  consist_r)      sabotar "AND abs(e.cr_cat_atual - e.comp_r_valor) <= 0.005" "AND e.comp_r_valor IS NOT NULL" ;;
  consist_d)      sabotar "AND abs(e.cp_cat_atual - e.comp_d_valor) <= 0.005" "AND e.comp_d_valor IS NOT NULL" ;;
  uso_unico)      sabotar "AND e.usos_cr = 1 AND e.usos_cp = 1" "" ;;
  teto)           sabotar " OR (SELECT t.ok FROM teto t) IS FALSE" "" ;;
  empresa_do_titulo) sabotar "AND e.cr_empresa = e.empresa_origem AND e.cp_empresa = e.empresa_destino" "" ;;
  sem_gate)       sabotar "    COALESCE(auth.role() = 'service_role', false)" "    true OR COALESCE(auth.role() = 'service_role', false)" ;;
  sc_resultado)   sabotar "WHEN d.conta = 'resultado_liquido' THEN e.valor_sc" "WHEN d.conta = 'resultado_liquido' THEN 0" ;;
  sc_cmv)         sabotar "WHEN d.conta = 'cmv' THEN -(e.valor_par + e.valor_sc)" "WHEN d.conta = 'cmv' THEN -e.valor_par" ;;
  sc_teto)        sabotar "FROM sc_julgado v WHERE v.ok) d" "FROM sc_julgado v WHERE false) d" ;;
  sc_categoria)   sabotar "THEN (u.sd_comp -> u.cp_chave ->> 'cmv')::numeric END AS comp_d_valor" \
                          "THEN (u.sd_comp -> u.cp_chave ->> 'cmv')::numeric ELSE (SELECT sum(j.v::numeric) FROM jsonb_each_text(u.sd_comp -> u.cp_chave) AS j(k, v)) END AS comp_d_valor" ;;
  sc_cancelado)   sabotar "            AND v.cp_status <> 'CANCELADO'" "" ;;
  sc_status_nulo) sabotar "            AND v.cp_status <> 'CANCELADO'" "            AND v.cp_status IS DISTINCT FROM 'CANCELADO'" ;;
  sc_consist)     sabotar "AND abs(v.cp_cat_atual - v.comp_d_valor) <= 0.005" "AND v.comp_d_valor IS NOT NULL" ;;
  sc_escopo)      sabotar "      JOIN snap so ON so.company = m.empresa_origem" "      LEFT JOIN snap so ON so.company = m.empresa_origem" ;;
  sc_cr_aparecido) sabotar "            AND NOT v.cr_aparecido" "" ;;
  sc_janela)      sabotar "OR abs(r3.data_emissao - u.cp_emissao) <= 30" "OR abs(r3.data_emissao - u.cp_emissao) <= 90" ;;
  sc_sem_data)    sabotar "OR r3.data_emissao IS NULL" "OR false" ;;
  sc_informativos) sabotar "AND m3.status IN ('divergencia_valor', 'divergencia_data', 'sem_contrapartida', 'duplicidade_possivel')" "AND m3.status IS NOT NULL" ;;
  sc_mapa)        sabotar "                           OR (EXISTS (SELECT 1 FROM omie_customer_account_map om" "                           OR (false AND EXISTS (SELECT 1 FROM omie_customer_account_map om" ;;
  sc_mapa_sem_data) sabotar "OR r3.data_emissao IS NULL" "OR false" ;;
  sc_mapa_cancelado) sabotar "AND r3.status_titulo IS DISTINCT FROM 'CANCELADO'" "" ;;
  sc_mapa_destino) sabotar "AND cc.company = u.empresa_destino" "AND cc.company IS NOT NULL" ;;
  sc_origem_cr)   sabotar "WHERE r3.company = u.empresa_origem" "WHERE true" ;;
  sc_mapa_decisao) sabotar "AND m4.status IN ('auto_matched', 'manual_matched', 'desconsiderado')" "AND false" ;;
  sc_mapa_fonte)  sabotar "WHERE om.source = 'document' AND om.account = r3.company" "WHERE om.account = r3.company" ;;
  sc_direcao)     sabotar "AND m3.empresa_origem = u.empresa_origem AND m3.empresa_destino = u.empresa_destino" "" ;;
  sc_marca_cr)    sabotar "(v.marca_cr_id IS NULL AND v.usos_cp = 1" "(v.usos_cp = 1" ;;
  sc_uso)         sabotar "(v.marca_cr_id IS NULL AND v.usos_cp = 1" "(v.marca_cr_id IS NULL" ;;
  sc_empresa)     sabotar "            AND v.cp_empresa = v.empresa_destino" "" ;;
  sc_valor)       sabotar "            AND v.cp_valor > 0" "" ;;
  sc_multi_linha) sabotar "AND ((u.sd_comp -> u.cp_chave) - 'cmv') = '{}'::jsonb" "" ;;
  sc_pendente)    sabotar "SELECT count(*) FILTER (WHERE NOT v.ok) > 0 AS pendente" "SELECT false AS pendente" ;;
  sc_mes)         sabotar "FROM sem_cobranca u\n     WHERE u.cp_no_mes IS TRUE" "FROM sem_cobranca u\n     WHERE true" ;;
  trg_master)     sabotar "IF NOT v_master THEN\n      RAISE EXCEPTION 'venda sem cobranca: so o master marca'" \
                          "IF false THEN\n      RAISE EXCEPTION 'venda sem cobranca: so o master marca'" ;;
  trg_carimbo)    sabotar "NEW.resolvido_por := auth.uid();" "NEW.resolvido_por := NEW.resolvido_por;" ;;
  trg_insert)     sabotar "IF TG_OP = 'INSERT' THEN" "IF TG_OP = 'INSERT' AND false THEN" ;;
  trg_cr)         sabotar "OR NEW.cr_id IS NOT NULL OR NEW.cp_id IS NULL" "OR NEW.cp_id IS NULL" ;;
  trg_origem)     sabotar "IF OLD.status <> 'sem_contrapartida' OR NEW.cr_id IS NOT NULL" "IF NEW.cr_id IS NOT NULL" ;;
  trg_fica)       sabotar "  ELSIF OLD.status = 'intragrupo_sem_cobranca' THEN" "  ELSIF false THEN" ;;
  trg_sai_master) sabotar "IF NOT v_master THEN\n      RAISE EXCEPTION 'venda sem cobranca: so o master desfaz'" \
                          "IF false THEN\n      RAISE EXCEPTION 'venda sem cobranca: so o master desfaz'" ;;
  trg_sai_destino) sabotar "    IF NEW.status <> 'sem_contrapartida'" "    IF false" ;;
  trg_sai_limpa)  sabotar "    NEW.resolvido_em := NULL;" "" ;;
  trg_delete)     sabotar "IF TG_OP = 'DELETE' THEN" "IF TG_OP = 'DELETE' AND false THEN" ;;
  trg_sem_delete) sabotar "BEFORE INSERT OR UPDATE OR DELETE ON public.fin_ic_matches" "BEFORE INSERT OR UPDATE ON public.fin_ic_matches" ;;
  check_sem_status) sabotar "  'duplicidade_possivel', 'desconsiderado', 'intragrupo_sem_cobranca'));" "  'duplicidade_possivel', 'desconsiderado'));" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
# md5 do corpo ENTRE os delimitadores, como o banco o guarda em prosrc. $2 = função, $3 = delimitador.
md5_corpo() {
  python3 -I - "$1" "$2" "$3" <<'PY2'
import hashlib, sys
arq, funcao, tag = sys.argv[1:]
s = open(arq, encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION " + funcao)
j = s.index("AS " + tag, i) + len("AS " + tag); k = s.index(tag + ";", j)
print(hashlib.md5(s[j:k].encode()).hexdigest())
PY2
}
# Corpo sabotado = corpo NOVO: reassina o "este" do PRE/PÓS (como faria quem mudasse a função e o
# arquivo juntos). Sem isso o P1 da PÓS aborta o apply e o vermelho não chega ao assert de comportamento.
if [ -n "${SABOTAGEM:-}" ]; then
  for alvo in 'public.fin_consolidado_intercompany:$$' 'public.fin_ic_matches_guarda_sem_cobranca:$g$'; do
    ESTE_ARQ="$(md5_corpo "$MIG" "${alvo%%:*}" "${alvo#*:}")"; ESTE_SAB="$(md5_corpo "$MIG_USADA" "${alvo%%:*}" "${alvo#*:}")"
    [ "$ESTE_ARQ" = "$ESTE_SAB" ] || sabotar "$ESTE_ARQ" "$ESTE_SAB"
  done
  echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"
fi
# O predecessor REAL: só o bloco da função (o arquivo também tem TRAVA/PRE/ACL/PÓS da versão dele).
sed -n '/^CREATE OR REPLACE FUNCTION public.fin_consolidado_intercompany/,/^\$\$;/p' "$MIG_PREDECESSOR" > "$PRED"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars (VERBOSITY verbose).
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
# SQLSTATE + marca do ramo: o 42501 do DELETE e o do "so o master desfaz" são ramos distintos do mesmo
# trigger — casar só o código deixa um mascarar o outro (a falsificação de trg_delete mostrou).
estado_ramo() {
  local saida c
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  c="$(printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':')"
  if printf '%s\n' "$saida" | grep -qF -- "$2"; then echo "${c:-sem-codigo}+ramo"; else echo "${c:-sem-codigo}-outro-ramo"; fi
}
PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

STAFF=00000000-0000-0000-0000-0000000000e1; MASTER=00000000-0000-0000-0000-0000000000e2
CLIENTE=00000000-0000-0000-0000-0000000000c1

# ── Esquema mínimo com as colunas de prod que a função lê ──
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE sandbox_exec_teste NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, sandbox_exec_teste;
-- Default privileges do Supabase: função nova NASCE aberta (a migration tem de REVOGAR).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;

CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

CREATE TABLE public.fin_dre_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, ano integer NOT NULL, mes integer NOT NULL, regime text NOT NULL,
  receita_bruta numeric DEFAULT 0, cmv numeric DEFAULT 0,
  despesas_operacionais numeric DEFAULT 0, resultado_liquido numeric DEFAULT 0,
  detalhamento jsonb, calculated_at timestamptz,
  UNIQUE (company, ano, mes, regime)
);
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text NOT NULL,
  valor_documento numeric, data_emissao date, status_titulo text,
  categoria_codigo text, categoria_descricao text, created_at timestamptz DEFAULT now(),
  omie_codigo_cliente bigint
);
-- Mapa de identidade (código Omie do cliente → documento) e CNPJs do grupo, com as colunas que a RPC lê
-- (prod, psql-ro 2026-10-26). É a fonte do "CR aparecido" que NÃO depende das linhas informativas da edge.
CREATE TABLE public.company_cnpjs (company text PRIMARY KEY, cnpj_normalized text NOT NULL);
CREATE TABLE public.omie_customer_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text NOT NULL, omie_codigo_cliente bigint NOT NULL,
  source text NOT NULL DEFAULT 'document', evidence_document_normalized text
);
INSERT INTO public.company_cnpjs VALUES ('colacor', '11111111000111'), ('colacor_sc', '22222222000122'), ('oben', '33333333000133');
-- 777: cliente colacor no Omie da colacor_sc · 778: cliente oben no Omie da colacor_sc · 779: cliente
-- colacor no Omie da oben · 780: cliente colacor, mas vínculo que não veio de documento.
INSERT INTO public.omie_customer_account_map (account, omie_codigo_cliente, source, evidence_document_normalized) VALUES
  ('colacor_sc', 777, 'document', '11111111000111'), ('colacor_sc', 778, 'document', '33333333000133'),
  ('oben', 779, 'document', '11111111000111'), ('colacor_sc', 780, 'manual', '11111111000111');
CREATE TABLE public.fin_contas_pagar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text NOT NULL,
  valor_documento numeric, data_emissao date, status_titulo text,
  categoria_codigo text, categoria_descricao text, created_at timestamptz DEFAULT now()
);
-- fin_ic_matches como na prod (psql-ro 2026-10-21): CHECK de status com o NOME e a definição de lá, RLS
-- com as 2 policies de staff (SELECT/UPDATE), sem INSERT/DELETE para authenticated. Os UNIQUE parciais
-- em cr_id/cp_id ficam DE FORA de propósito: a RPC se defende sem eles (P7, U15) e o teste precisa montar
-- o caso que eles impediriam.
CREATE TABLE public.fin_ic_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_origem text NOT NULL, empresa_destino text NOT NULL,
  cr_id uuid REFERENCES public.fin_contas_receber(id) ON DELETE SET NULL,
  cp_id uuid REFERENCES public.fin_contas_pagar(id) ON DELETE SET NULL,
  valor_origem numeric, valor_destino numeric, status text NOT NULL,
  resolvido_por uuid, resolvido_em timestamptz, observacao text,
  CHECK (empresa_origem <> empresa_destino), CHECK (cr_id IS NOT NULL OR cp_id IS NOT NULL),
  CONSTRAINT fin_ic_matches_status_check CHECK (status = ANY (ARRAY['auto_matched'::text, 'manual_matched'::text,
    'divergencia_valor'::text, 'divergencia_data'::text, 'sem_contrapartida'::text, 'duplicidade_possivel'::text,
    'desconsiderado'::text]))
);
ALTER TABLE public.fin_ic_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY fin_ic_matches_select_staff ON public.fin_ic_matches FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = ANY (ARRAY['employee'::public.app_role, 'master'::public.app_role])));
CREATE POLICY fin_ic_matches_update_staff ON public.fin_ic_matches FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = ANY (ARRAY['employee'::public.app_role, 'master'::public.app_role])));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_ic_matches TO authenticated, service_role;
GRANT SELECT ON public.user_roles TO authenticated;

-- Semente fiel ao motor: os snapshots são CALCULADOS a partir dos títulos (mesmo recorte de competência:
-- emissão no mês, status <> 'CANCELADO'; mesma chave de composição), para que a consistência
-- composição × títulos atuais seja testável. O mapa categoria → linha é o do motor, reduzido à semente.
CREATE TABLE public.t_mapa (chave text PRIMARY KEY, linha text NOT NULL);
INSERT INTO public.t_mapa VALUES ('Venda', 'receita_bruta'), ('Compra mercadoria', 'cmv'), ('Insumo', 'cmv'),
  ('Aluguel', 'despesas_operacionais'), ('Servicos', 'despesas_operacionais');
-- Títulos de base no dia 5. Sem par: receita 3400 · cmv 2300 · despesas 350 · resultado 750.
CREATE FUNCTION public.t_titulos(p_ano int, p_mes int, p_compra_colacor numeric DEFAULT 1400)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.fin_contas_receber (company, valor_documento, data_emissao, status_titulo, categoria_descricao, created_at)
  SELECT x.c, x.v, make_date(p_ano, p_mes, 5), 'RECEBIDO', 'Venda', make_date(p_ano, p_mes, 5)
    FROM (VALUES ('oben', 900), ('colacor', 2000), ('colacor_sc', 500)) AS x(c, v);
  INSERT INTO public.fin_contas_pagar (company, valor_documento, data_emissao, status_titulo, categoria_descricao, created_at)
  SELECT x.c, x.v, make_date(p_ano, p_mes, 5), 'PAGO', x.k, make_date(p_ano, p_mes, 5)
    FROM (VALUES ('oben', 'Insumo', 600::numeric), ('oben', 'Aluguel', 100), ('colacor', 'Compra mercadoria', p_compra_colacor),
                 ('colacor', 'Servicos', 200), ('colacor_sc', 'Compra mercadoria', 300), ('colacor_sc', 'Servicos', 50)) AS x(c, k, v);
$$;
CREATE FUNCTION public.t_calcular(p_ano int, p_mes int, p_empresas text[] DEFAULT ARRAY['oben','colacor','colacor_sc'])
RETURNS void LANGUAGE sql AS $$
  WITH t AS (
    SELECT 'r' AS lado, company, COALESCE(NULLIF(categoria_descricao, ''), NULLIF(categoria_codigo, ''), 'Sem categoria') AS chave,
           valor_documento AS v
      FROM public.fin_contas_receber
     WHERE status_titulo <> 'CANCELADO' AND date_trunc('month', data_emissao) = make_date(p_ano, p_mes, 1)
    UNION ALL
    SELECT 'd', company, COALESCE(NULLIF(categoria_descricao, ''), NULLIF(categoria_codigo, ''), 'Sem categoria'), valor_documento
      FROM public.fin_contas_pagar
     WHERE status_titulo <> 'CANCELADO' AND date_trunc('month', data_emissao) = make_date(p_ano, p_mes, 1)
  ), c AS (
    SELECT t.lado, t.company, t.chave, COALESCE(m.linha, 'despesas_operacionais') AS linha, sum(t.v) AS v
      FROM t LEFT JOIN public.t_mapa m ON m.chave = t.chave GROUP BY 1, 2, 3, 4
  )
  INSERT INTO public.fin_dre_snapshots (company, ano, mes, regime, receita_bruta, cmv, despesas_operacionais,
                                        resultado_liquido, detalhamento, calculated_at)
  SELECT e, p_ano, p_mes, 'competencia',
         COALESCE(sum(c.v) FILTER (WHERE c.linha = 'receita_bruta'), 0),
         COALESCE(sum(c.v) FILTER (WHERE c.linha = 'cmv'), 0),
         COALESCE(sum(c.v) FILTER (WHERE c.linha = 'despesas_operacionais'), 0),
         COALESCE(sum(c.v) FILTER (WHERE c.linha = 'receita_bruta'), 0) - COALESCE(sum(c.v) FILTER (WHERE c.linha = 'cmv'), 0)
           - COALESCE(sum(c.v) FILTER (WHERE c.linha = 'despesas_operacionais'), 0),
         jsonb_build_object(
           'composicao_receitas', COALESCE(jsonb_object_agg(c.chave, jsonb_build_object(c.linha, c.v)) FILTER (WHERE c.lado = 'r'), '{}'::jsonb),
           'composicao_despesas', COALESCE(jsonb_object_agg(c.chave, jsonb_build_object(c.linha, c.v)) FILTER (WHERE c.lado = 'd'), '{}'::jsonb)),
         (make_date(p_ano, p_mes, 1) + interval '1 month')::timestamptz
    FROM unnest(p_empresas) AS e LEFT JOIN c ON c.company = e
   GROUP BY e;
$$;
-- Um par CR(origem)→CP(destino), criado na emissão.
CREATE FUNCTION public.t_par(p_origem text, p_destino text, p_emis_cr date, p_emis_cp date,
                             p_valor_cr numeric DEFAULT 100, p_valor_cp numeric DEFAULT 100,
                             p_status text DEFAULT 'auto_matched', p_cat_cr text DEFAULT 'Venda',
                             p_cat_cp text DEFAULT 'Compra mercadoria', p_status_cr text DEFAULT 'RECEBIDO',
                             p_com_cp boolean DEFAULT true, p_empresa_cr text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_cr uuid; v_cp uuid;
BEGIN
  INSERT INTO public.fin_contas_receber (company, valor_documento, data_emissao, status_titulo, categoria_descricao, created_at)
  VALUES (COALESCE(p_empresa_cr, p_origem), p_valor_cr, p_emis_cr, p_status_cr, p_cat_cr, p_emis_cr::timestamptz) RETURNING id INTO v_cr;
  IF p_com_cp THEN
    INSERT INTO public.fin_contas_pagar (company, valor_documento, data_emissao, status_titulo, categoria_descricao, created_at)
    VALUES (p_destino, p_valor_cp, p_emis_cp, 'PAGO', p_cat_cp, p_emis_cp::timestamptz) RETURNING id INTO v_cp;
  END IF;
  INSERT INTO public.fin_ic_matches (empresa_origem, empresa_destino, cr_id, cp_id, valor_origem, valor_destino, status)
  VALUES (p_origem, p_destino, v_cr, v_cp, p_valor_cr, CASE WHEN p_com_cp THEN p_valor_cp END, p_status);
  RETURN v_cr;
END $$;
-- Venda sem cobrança: CP no destino (ou em p_empresa_cp), linha CP-only 'sem_contrapartida' como a edge
-- grava, e a marcação pelo master pela porta real (o trigger), como a fila faz.
CREATE FUNCTION public.t_sc(p_origem text, p_destino text, p_emis date, p_valor numeric DEFAULT 100,
                            p_cat text DEFAULT 'Compra mercadoria', p_status_cp text DEFAULT 'PAGO',
                            p_empresa_cp text DEFAULT NULL, p_marcar boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_cp uuid; v_m uuid;
BEGIN
  INSERT INTO public.fin_contas_pagar (company, valor_documento, data_emissao, status_titulo, categoria_descricao, created_at)
  VALUES (COALESCE(p_empresa_cp, p_destino), p_valor, p_emis, p_status_cp, p_cat, p_emis::timestamptz) RETURNING id INTO v_cp;
  INSERT INTO public.fin_ic_matches (empresa_origem, empresa_destino, cp_id, valor_destino, status)
  VALUES (p_origem, p_destino, v_cp, p_valor, 'sem_contrapartida') RETURNING id INTO v_m;
  IF p_marcar THEN
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
    UPDATE public.fin_ic_matches SET status = 'intragrupo_sem_cobranca' WHERE id = v_m;
    PERFORM set_config('request.jwt.claim.sub', '', true);
  END IF;
  RETURN v_m;
END $$;
-- CR com código de cliente e SEM linha em fin_ic_matches: a evidência que a edge apagou e não reinseriu
-- (publicação DELETE→INSERT em 2 requisições) ou que nunca gravou (CR sem emissão sai do pool).
CREATE FUNCTION public.t_cr_mapa(p_empresa text, p_emis date, p_valor numeric, p_codigo bigint,
                                 p_status text DEFAULT 'RECEBIDO')
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.fin_contas_receber (company, valor_documento, data_emissao, status_titulo, categoria_descricao, omie_codigo_cliente)
  VALUES (p_empresa, p_valor, p_emis, p_status, 'Venda', p_codigo) RETURNING id
$$;
-- CR intragrupo que a edge gravou sem CP (linha CR-only), na origem, fora do recorte se a data cair fora.
CREATE FUNCTION public.t_cr_ic(p_origem text, p_destino text, p_emis date, p_valor numeric,
                               p_status text DEFAULT 'sem_contrapartida')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_cr uuid; v_m uuid;
BEGIN
  INSERT INTO public.fin_contas_receber (company, valor_documento, data_emissao, status_titulo, categoria_descricao, created_at)
  VALUES (p_origem, p_valor, p_emis, 'RECEBIDO', 'Venda', now()) RETURNING id INTO v_cr;
  INSERT INTO public.fin_ic_matches (empresa_origem, empresa_destino, cr_id, valor_origem, status)
  VALUES (p_origem, p_destino, v_cr, p_valor, p_status) RETURNING id INTO v_m;
  RETURN v_m;
END $$;
SQL
Pq -c "INSERT INTO public.user_roles VALUES ('$STAFF','employee'), ('$MASTER','master'), ('$CLIENTE','customer')"

# ── MIG0: o predecessor REAL é o corpo vivo da prod ──
P -q -f "$PRED"
eq "MIG0 predecessor = md5 da prod" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fin_consolidado_intercompany(integer,integer)'::regprocedure")" "11832f17b7551cabe02a2224cb495aaf"
Pq -c "GRANT EXECUTE ON FUNCTION public.fin_consolidado_intercompany(integer,integer) TO sandbox_exec_teste"

# ── Aplicar a migration REAL sobre o predecessor (a PRE tem de aceitá-lo) ──
eq "MIG1 aplica sobre o predecessor" "$(estado "$(cat "$MIG_USADA")")" "verde"
eq "MIG2 re-aplicar passa (idempotente)" "$(estado "$(cat "$MIG_USADA")")" "verde"
eq "MIG3 grant extra sobrevive ao replace" "$(Pq -c "SELECT has_function_privilege('sandbox_exec_teste', 'public.fin_consolidado_intercompany(integer,integer)', 'EXECUTE')")" "t"

# Leitura padrão: como service_role, em uma linha "conta=bruto/elim/consolidado;..." na ordem devolvida.
le() { Pq -c "SET request.jwt.claim.role = 'service_role';
  SELECT string_agg(r.conta || '=' || COALESCE(r.total_bruto::text, '(null)') || '/' || COALESCE(r.eliminacoes::text, '(null)')
                    || '/' || COALESCE(r.total_consolidado::text, '(null)'), ';' ORDER BY r.n)
    FROM public.fin_consolidado_intercompany($1, $2) WITH ORDINALITY AS r(conta, total_bruto, eliminacoes, total_consolidado, n)"; }
# Só eliminação/consolidado (os cenários de pendência têm brutos diferentes entre si).
le_ec() { Pq -c "SET request.jwt.claim.role = 'service_role';
  SELECT string_agg(r.conta || '=' || COALESCE(r.eliminacoes::text, '(null)') || '/' || COALESCE(r.total_consolidado::text, '(null)'), ';' ORDER BY r.n)
    FROM public.fin_consolidado_intercompany($1, $2) WITH ORDINALITY AS r(conta, total_bruto, eliminacoes, total_consolidado, n)"; }
PEND="receita_bruta=(null)/(null);cmv=(null)/(null);despesas_operacionais=(null)/(null);resultado_liquido=(null)/(null)"
mes() { Pq -c "$1" >/dev/null; }   # semente de um cenário

# ── A: par elegível ──
mes "SELECT public.t_titulos(2026, 1); SELECT public.t_par('oben', 'colacor', '2026-01-10', '2026-01-12'); SELECT public.t_calcular(2026, 1)"
eq "A1 receita e cmv caem pelo mesmo valor, despesas e resultado intactos" "$(le 2026 1)" \
   "receita_bruta=3500/-100/3400;cmv=2400/-100/2300;despesas_operacionais=350/0/350;resultado_liquido=750/0/750"
mes "SELECT public.t_titulos(2026, 2); SELECT public.t_calcular(2026, 2)"
eq "A2 mês com snapshots e sem par: eliminação 0" "$(le 2026 2)" \
   "receita_bruta=3400/0/3400;cmv=2300/0/2300;despesas_operacionais=350/0/350;resultado_liquido=750/0/750"

# ── N: ausente ≠ zero ──
eq "N1 mês sem snapshot: bruto e consolidado NULL" "$(le 2030 1)" \
   "receita_bruta=(null)/0/(null);cmv=(null)/0/(null);despesas_operacionais=(null)/0/(null);resultado_liquido=(null)/0/(null)"
mes "SELECT public.t_titulos(2026, 3); SELECT public.t_calcular(2026, 3);
     UPDATE public.fin_dre_snapshots SET cmv = NULL WHERE ano = 2026 AND mes = 3 AND company = 'oben'"
eq "N2 cmv NULL num snapshot: a conta cmv sai NULL, as outras não" "$(le 2026 3)" \
   "receita_bruta=3400/0/3400;cmv=(null)/0/(null);despesas_operacionais=350/0/350;resultado_liquido=750/0/750"

# ── C: escopo da soma parcial ──
mes "SELECT public.t_titulos(2026, 4); SELECT public.t_par('oben', 'colacor_sc', '2026-04-10', '2026-04-10'); SELECT public.t_calcular(2026, 4, ARRAY['oben','colacor'])"
eq "C1 destino sem snapshot: par fora da soma, nem elimina nem pende" "$(le 2026 4)" \
   "receita_bruta=3000/0/3000;cmv=2000/0/2000;despesas_operacionais=300/0/300;resultado_liquido=700/0/700"
mes "SELECT public.t_titulos(2026, 5); SELECT public.t_par('colacor_sc', 'colacor', '2026-05-10', '2026-05-10'); SELECT public.t_calcular(2026, 5, ARRAY['oben','colacor'])"
eq "C2 origem sem snapshot: par fora da soma" "$(le 2026 5)" \
   "receita_bruta=2900/0/2900;cmv=2100/0/2100;despesas_operacionais=300/0/300;resultado_liquido=500/0/500"

# ── S: status não confirmado ──
mes "SELECT public.t_titulos(2026, 6); SELECT public.t_par('oben', 'colacor', '2026-06-10', '2026-06-10', p_status => 'divergencia_valor'); SELECT public.t_calcular(2026, 6)"
eq "S1 divergencia_valor não entra" "$(le 2026 6)" \
   "receita_bruta=3500/0/3500;cmv=2400/0/2400;despesas_operacionais=350/0/350;resultado_liquido=750/0/750"

# ── P: confirmado e não elegível → consolidado desconhecido ──
mes "SELECT public.t_titulos(2026, 7); SELECT public.t_par('oben', 'colacor', '2026-07-10', NULL, p_status => 'manual_matched', p_com_cp => false); SELECT public.t_calcular(2026, 7)"
eq "P1 sem contrapartida aprovado à mão (o bruto segue)" "$(le 2026 7)" \
   "receita_bruta=3500/(null)/(null);cmv=2300/(null)/(null);despesas_operacionais=350/(null)/(null);resultado_liquido=850/(null)/(null)"
mes "SELECT public.t_titulos(2026, 8); SELECT public.t_par('oben', 'colacor', '2026-08-10', '2026-08-10', p_valor_cp => 96, p_status => 'manual_matched'); SELECT public.t_calcular(2026, 8)"
eq "P2 valor divergente aprovado à mão" "$(le_ec 2026 8)" "$PEND"
mes "SELECT public.t_titulos(2026, 9); SELECT public.t_titulos(2026, 10); SELECT public.t_par('oben', 'colacor', '2026-09-30', '2026-10-01');
     SELECT public.t_calcular(2026, 9); SELECT public.t_calcular(2026, 10)"
eq "P3a CR no mês, CP no seguinte: o mês do CR pende" "$(le_ec 2026 9)" "$PEND"
eq "P3b ... e o mês do CP também" "$(le_ec 2026 10)" "$PEND"
mes "SELECT public.t_titulos(2026, 11); SELECT public.t_par('oben', 'colacor', '2026-11-10', '2026-11-10', p_cat_cp => 'Servicos'); SELECT public.t_calcular(2026, 11)"
eq "P4 CP compôs despesas, não cmv" "$(le_ec 2026 11)" "$PEND"
mes "SELECT public.t_titulos(2026, 12); SELECT public.t_par('oben', 'colacor', '2026-12-10', '2026-12-10', p_status_cr => 'CANCELADO'); SELECT public.t_calcular(2026, 12)"
eq "P5 CR cancelado (o motor não o somou)" "$(le_ec 2026 12)" "$PEND"
mes "SELECT public.t_titulos(2025, 1); SELECT public.t_par('oben', 'colacor', '2025-01-10', '2025-01-10'); SELECT public.t_calcular(2025, 1);
     INSERT INTO public.fin_contas_pagar (company, valor_documento, data_emissao, status_titulo, categoria_descricao, created_at)
     VALUES ('colacor', 50, '2025-01-20', 'PAGO', 'Compra mercadoria', '2025-01-20')"
eq "P6 CP novo na categoria do destino depois do cálculo: snapshot velho" "$(le_ec 2025 1)" "$PEND"
mes "SELECT public.t_titulos(2025, 2); SELECT public.t_par('oben', 'colacor', '2025-02-10', '2025-02-10'); SELECT public.t_calcular(2025, 2);
     UPDATE public.fin_contas_receber SET valor_documento = 950 WHERE company = 'oben' AND data_emissao = '2025-02-05'"
eq "P11 CR da categoria da origem mudou de valor depois do cálculo" "$(le_ec 2025 2)" "$PEND"
mes "SELECT public.t_titulos(2025, 3); SELECT public.t_par('oben', 'colacor', '2025-03-10', '2025-03-10'); SELECT public.t_calcular(2025, 3);
     UPDATE public.fin_contas_receber SET valor_documento = 200 WHERE company = 'oben' AND data_emissao = '2025-03-10';
     UPDATE public.fin_contas_pagar SET valor_documento = 200 WHERE company = 'colacor' AND data_emissao = '2025-03-10'"
eq "P11b o par inteiro mudou de valor depois do cálculo (cenário do Codex)" "$(le_ec 2025 3)" "$PEND"
mes "SELECT public.t_titulos(2025, 4);
     DO \$\$ DECLARE v_cr uuid; v_cp uuid; BEGIN
       v_cr := public.t_par('oben', 'colacor', '2025-04-10', '2025-04-10');
       INSERT INTO public.fin_contas_pagar (company, valor_documento, data_emissao, status_titulo, categoria_descricao, created_at)
       VALUES ('colacor', 100, '2025-04-11', 'PAGO', 'Compra mercadoria', '2025-04-11') RETURNING id INTO v_cp;
       INSERT INTO public.fin_ic_matches (empresa_origem, empresa_destino, cr_id, cp_id, valor_origem, valor_destino, status)
       VALUES ('oben', 'colacor', v_cr, v_cp, 100, 100, 'manual_matched'); END \$\$;
     SELECT public.t_calcular(2025, 4)"
eq "P7a semente: o CR está em 2 pares confirmados" "$(Pq -c "SELECT count(*) FROM public.fin_ic_matches m JOIN public.fin_contas_receber cr ON cr.id = m.cr_id WHERE cr.data_emissao = '2025-04-10'")" "2"
eq "P7 o mesmo CR em 2 pares" "$(le_ec 2025 4)" "$PEND"
mes "SELECT public.t_titulos(2025, 5, p_compra_colacor => -150); SELECT public.t_par('oben', 'colacor', '2025-05-10', '2025-05-10'); SELECT public.t_calcular(2025, 5)"
eq "P8 eliminação acima do que a categoria compôs (-150 + 100 = -50)" "$(le_ec 2025 5)" "$PEND"
mes "SELECT public.t_titulos(2025, 6); SELECT public.t_par('oben', 'colacor', '2025-06-10', '2025-06-10'); SELECT public.t_calcular(2025, 6);
     UPDATE public.fin_dre_snapshots SET detalhamento = jsonb_set(detalhamento, '{composicao_despesas,Compra mercadoria,despesas_operacionais}', '0')
      WHERE ano = 2025 AND mes = 6 AND company = 'colacor'"
eq "P9 categoria do CP compôs 2 linhas" "$(le_ec 2025 6)" "$PEND"
mes "SELECT public.t_titulos(2025, 7); SELECT public.t_par('oben', 'colacor', '2025-07-10', '2025-07-10', p_empresa_cr => 'colacor_sc'); SELECT public.t_calcular(2025, 7)"
eq "P10 CR de outra empresa que não a origem do par" "$(le_ec 2025 7)" "$PEND"
mes "SELECT public.t_titulos(2025, 8); SELECT public.t_par('oben', 'colacor', '2025-08-10', '2025-08-10', p_status_cr => NULL); SELECT public.t_calcular(2025, 8)"
eq "P13 CR sem status (o motor não o somou)" "$(le_ec 2025 8)" "$PEND"
eq "P0 controle: o mês elegível segue elegível" "$(le 2026 1)" \
   "receita_bruta=3500/-100/3400;cmv=2400/-100/2300;despesas_operacionais=350/0/350;resultado_liquido=750/0/750"

# ── U: venda intragrupo sem cobrança (marcada pelo master) ──
# Base de cada mês (t_titulos): receita 3400 · cmv 2300 · despesas 350 · resultado 750.
UOK="receita_bruta=3400/0/3400;cmv=2400/-100/2300;despesas_operacionais=350/0/350;resultado_liquido=650/100/750"
mes "SELECT public.t_titulos(2027, 1); SELECT public.t_sc('colacor', 'oben', '2027-01-10'); SELECT public.t_calcular(2027, 1)"
eq "U1a semente: a linha foi marcada pela porta real (o trigger)" "$(Pq -c "SELECT count(*) FROM public.fin_ic_matches m JOIN public.fin_contas_pagar cp ON cp.id = m.cp_id WHERE m.status = 'intragrupo_sem_cobranca' AND cp.data_emissao = '2027-01-10'")" "1"
eq "U1 sem cobrança: só o CMV cai, a receita não, e o resultado sobe pelo valor" "$(le 2027 1)" "$UOK"
mes "SELECT public.t_titulos(2027, 2); SELECT public.t_par('oben', 'colacor', '2027-02-10', '2027-02-10');
     SELECT public.t_sc('colacor_sc', 'colacor', '2027-02-11', 50); SELECT public.t_calcular(2027, 2)"
eq "U2 par e sem cobrança no mesmo mês e na mesma categoria do destino" "$(le 2027 2)" \
   "receita_bruta=3500/-100/3400;cmv=2450/-150/2300;despesas_operacionais=350/0/350;resultado_liquido=700/50/750"
mes "SELECT public.t_titulos(2027, 3, p_compra_colacor => -50); SELECT public.t_par('oben', 'colacor', '2027-03-10', '2027-03-10');
     SELECT public.t_sc('colacor_sc', 'colacor', '2027-03-11'); SELECT public.t_calcular(2027, 3)"
eq "U3 teto: par (100) e sem cobrança (100) cabem sozinhos na categoria (150), juntos não" "$(le_ec 2027 3)" "$PEND"
mes "SELECT public.t_titulos(2027, 4); SELECT public.t_sc('colacor_sc', 'colacor', '2027-04-10', p_cat => 'Servicos'); SELECT public.t_calcular(2027, 4)"
eq "U4 CP marcado compôs despesas, não cmv" "$(le_ec 2027 4)" "$PEND"
mes "SELECT public.t_titulos(2027, 5); SELECT public.t_sc('colacor_sc', 'colacor', '2027-05-10', p_status_cp => 'CANCELADO'); SELECT public.t_calcular(2027, 5)"
eq "U5 CP marcado cancelado (o motor não o somou)" "$(le_ec 2027 5)" "$PEND"
mes "SELECT public.t_titulos(2027, 6); SELECT public.t_sc('colacor_sc', 'colacor', '2027-06-10', p_status_cp => NULL); SELECT public.t_calcular(2027, 6)"
eq "U5b CP marcado sem status (o motor não o somou)" "$(le_ec 2027 6)" "$PEND"
mes "SELECT public.t_titulos(2027, 7); SELECT public.t_sc('colacor_sc', 'colacor', '2027-07-10'); SELECT public.t_calcular(2027, 7);
     INSERT INTO public.fin_contas_pagar (company, valor_documento, data_emissao, status_titulo, categoria_descricao, created_at)
     VALUES ('colacor', 50, '2027-07-20', 'PAGO', 'Compra mercadoria', '2027-07-20')"
eq "U6 CP novo na categoria do destino depois do cálculo: snapshot velho" "$(le_ec 2027 7)" "$PEND"
mes "SELECT public.t_titulos(2027, 8); SELECT public.t_sc('colacor_sc', 'colacor', '2027-08-10'); SELECT public.t_calcular(2027, 8, ARRAY['oben','colacor'])"
eq "U7 origem sem snapshot: a compra é de quem está fora da soma, nem elimina nem pende" "$(le 2027 8)" \
   "receita_bruta=2900/0/2900;cmv=2100/0/2100;despesas_operacionais=300/0/300;resultado_liquido=500/0/500"
mes "SELECT public.t_titulos(2027, 9); SELECT public.t_sc('colacor', 'oben', '2027-09-10'); SELECT public.t_calcular(2027, 9)"
CR="$(Pq -c "SELECT public.t_cr_ic('colacor', 'oben', '2028-12-01', 100)")"
eq "U8 CR aparecido na mesma direção, de mesmo valor (mesmo longe): a marcação fica em dúvida" "$(le_ec 2027 9)" "$PEND"
mes "DELETE FROM public.fin_ic_matches WHERE id = '$CR'"
mes "SELECT public.t_titulos(2027, 10); SELECT public.t_sc('colacor', 'oben', '2027-10-10');
     SELECT public.t_cr_ic('colacor', 'oben', '2027-10-20', 37); SELECT public.t_calcular(2027, 10)"
eq "U9 CR aparecido na mesma direção, a 10 dias do CP (outro valor)" "$(le_ec 2027 10)" "$PEND"
mes "DELETE FROM public.fin_ic_matches m USING public.fin_contas_receber r WHERE r.id = m.cr_id AND r.data_emissao = '2027-10-20'"
mes "SELECT public.t_titulos(2027, 11); SELECT public.t_sc('colacor', 'oben', '2027-11-10'); SELECT public.t_calcular(2027, 11)"
CR="$(Pq -c "SELECT public.t_cr_ic('colacor', 'oben', '2028-11-01', 100, 'desconsiderado')")"
eq "U10 CR de mesmo valor que o founder desconsiderou não bloqueia" "$(le 2027 11)" "$UOK"
mes "DELETE FROM public.fin_ic_matches WHERE id = '$CR'"
mes "SELECT public.t_titulos(2027, 12); SELECT public.t_sc('colacor', 'oben', '2027-12-10'); SELECT public.t_calcular(2027, 12)"
CR="$(Pq -c "SELECT public.t_cr_ic('oben', 'colacor', '2028-10-01', 100)")"
eq "U10b CR de mesmo valor na OUTRA direção não bloqueia" "$(le 2027 12)" "$UOK"
mes "DELETE FROM public.fin_ic_matches WHERE id = '$CR'"
mes "SELECT public.t_titulos(2028, 1); SELECT public.t_sc('colacor', 'oben', '2028-01-10'); SELECT public.t_calcular(2028, 1)"
CR="$(Pq -c "SELECT public.t_cr_ic('colacor', 'oben', '2028-03-15', 37)")"
eq "U11 CR a 64 dias e de outro valor não bloqueia (a janela é de 30)" "$(le 2028 1)" "$UOK"
mes "DELETE FROM public.fin_ic_matches WHERE id = '$CR'"
mes "SELECT public.t_titulos(2028, 2); SELECT public.t_sc('colacor', 'oben', '2028-02-10'); SELECT public.t_calcular(2028, 2)"
CR="$(Pq -c "SELECT public.t_cr_ic('colacor', 'oben', NULL, 37)")"
eq "U12 CR aparecido sem data de emissão: não dá para afastar" "$(le_ec 2028 2)" "$PEND"
mes "DELETE FROM public.fin_ic_matches WHERE id = '$CR'"
# U14 e U16 ficam em colacor_sc→colacor de propósito: o S1 deixou uma linha informativa oben→colacor de
# 100, que é "CR aparecido" para qualquer sem cobrança oben→colacor de 100 e mascararia a trava testada
# (achado da falsificação: as duas sabotagens ficavam verdes).
mes "SELECT public.t_titulos(2028, 3); SELECT public.t_sc('colacor_sc', 'colacor', '2028-03-10'); SELECT public.t_calcular(2028, 3);
     ALTER TABLE public.fin_ic_matches DISABLE TRIGGER fin_ic_matches_guarda_sem_cobranca;
     WITH r AS (INSERT INTO public.fin_contas_receber (company, valor_documento, data_emissao, status_titulo, categoria_descricao)
                VALUES ('colacor_sc', 5, '2028-09-05', 'RECEBIDO', 'Venda') RETURNING id)
     UPDATE public.fin_ic_matches m SET cr_id = (SELECT id FROM r) FROM public.fin_contas_pagar cp
      WHERE cp.id = m.cp_id AND cp.data_emissao = '2028-03-10';
     ALTER TABLE public.fin_ic_matches ENABLE TRIGGER fin_ic_matches_guarda_sem_cobranca"
eq "U14 linha marcada que ganhou CR (por fora do trigger) não elimina" "$(le_ec 2028 3)" "$PEND"
mes "SELECT public.t_titulos(2028, 4); SELECT public.t_par('oben', 'colacor', '2028-04-10', '2028-04-10');
     DO \$\$ DECLARE v_m uuid; BEGIN
       INSERT INTO public.fin_ic_matches (empresa_origem, empresa_destino, cp_id, valor_destino, status)
       SELECT 'colacor_sc', 'colacor', m.cp_id, 100, 'sem_contrapartida' FROM public.fin_ic_matches m
         JOIN public.fin_contas_pagar cp ON cp.id = m.cp_id WHERE cp.data_emissao = '2028-04-10' AND m.status = 'auto_matched'
       RETURNING id INTO v_m;
       PERFORM set_config('request.jwt.claim.sub', '$MASTER', true);
       UPDATE public.fin_ic_matches SET status = 'intragrupo_sem_cobranca' WHERE id = v_m; END \$\$;
     SELECT public.t_calcular(2028, 4)"
eq "U15 o CP marcado também está num par confirmado" "$(le_ec 2028 4)" "$PEND"
mes "SELECT public.t_titulos(2028, 5); SELECT public.t_sc('colacor_sc', 'colacor', '2028-05-10', p_empresa_cp => 'oben'); SELECT public.t_calcular(2028, 5)"
eq "U16 CP marcado é de outra empresa que não o destino" "$(le_ec 2028 5)" "$PEND"
mes "SELECT public.t_titulos(2028, 6); SELECT public.t_sc('colacor_sc', 'colacor', '2028-06-10', 0); SELECT public.t_calcular(2028, 6)"
eq "U17 CP marcado de valor 0" "$(le_ec 2028 6)" "$PEND"
mes "SELECT public.t_titulos(2028, 7); SELECT public.t_sc('colacor_sc', 'colacor', '2028-07-10'); SELECT public.t_calcular(2028, 7);
     UPDATE public.fin_dre_snapshots SET detalhamento = jsonb_set(detalhamento, '{composicao_despesas,Compra mercadoria,despesas_operacionais}', '0')
      WHERE ano = 2028 AND mes = 7 AND company = 'colacor'"
eq "U18 categoria do CP marcado compôs 2 linhas" "$(le_ec 2028 7)" "$PEND"
# U19–U24: "CR aparecido" pelo mapa de identidade, sem linha informativa (achados 1 e 2 do Codex). Cada
# CR sai da tabela depois do cenário: o critério "mesmo valor" não tem janela de data e contaminaria o resto.
# O CR é emitido em 2032 (fora dos meses lidos) para não mexer na soma das categorias dos snapshots.
mes "SELECT public.t_titulos(2031, 1); SELECT public.t_sc('colacor_sc', 'colacor', '2031-01-10'); SELECT public.t_calcular(2031, 1)"
CR="$(Pq -c "SELECT public.t_cr_mapa('colacor_sc', '2032-06-01', 100, 777)")"
eq "U19 CR do destino pelo mapa, sem linha na fila (a edge apagou e não reinseriu): pende" "$(le_ec 2031 1)" "$PEND"
mes "DELETE FROM public.fin_contas_receber WHERE id = '$CR'"
mes "SELECT public.t_titulos(2031, 2); SELECT public.t_sc('colacor_sc', 'colacor', '2031-02-10'); SELECT public.t_calcular(2031, 2)"
CR="$(Pq -c "SELECT public.t_cr_mapa('colacor_sc', NULL, 37, 777)")"
eq "U20 CR do destino sem emissão (a edge o descarta, nunca vira linha): pende" "$(le_ec 2031 2)" "$PEND"
mes "DELETE FROM public.fin_contas_receber WHERE id = '$CR'"
mes "SELECT public.t_titulos(2031, 3); SELECT public.t_sc('colacor_sc', 'colacor', '2031-03-10'); SELECT public.t_calcular(2031, 3)"
CR="$(Pq -c "SELECT public.t_cr_mapa('colacor_sc', '2032-06-01', 100, 777, 'CANCELADO')")"
eq "U21 CR do destino CANCELADO não é cobrança: não bloqueia" "$(le 2031 3)" "$UOK"
mes "DELETE FROM public.fin_contas_receber WHERE id = '$CR'"
mes "SELECT public.t_titulos(2031, 4); SELECT public.t_sc('colacor_sc', 'colacor', '2031-04-10'); SELECT public.t_calcular(2031, 4)"
CR="$(Pq -c "SELECT public.t_cr_mapa('colacor_sc', '2032-06-01', 100, 778)")"
eq "U22 CR da origem para OUTRA empresa do grupo não bloqueia" "$(le 2031 4)" "$UOK"
mes "DELETE FROM public.fin_contas_receber WHERE id = '$CR'"
mes "SELECT public.t_titulos(2031, 5); SELECT public.t_sc('colacor_sc', 'colacor', '2031-05-10'); SELECT public.t_calcular(2031, 5)"
CR="$(Pq -c "SELECT public.t_cr_mapa('oben', '2032-06-01', 100, 779)")"
eq "U22b CR de OUTRA empresa para o destino não bloqueia" "$(le 2031 5)" "$UOK"
mes "DELETE FROM public.fin_contas_receber WHERE id = '$CR'"
mes "SELECT public.t_titulos(2031, 6); SELECT public.t_sc('colacor_sc', 'colacor', '2031-06-10'); SELECT public.t_calcular(2031, 6)"
CR="$(Pq -c "SELECT public.t_cr_mapa('colacor_sc', '2032-06-01', 100, 777)")"
mes "INSERT INTO public.fin_ic_matches (empresa_origem, empresa_destino, cr_id, valor_origem, status) VALUES ('colacor_sc', 'colacor', '$CR', 100, 'desconsiderado')"
eq "U23 CR do destino que o founder desconsiderou não bloqueia" "$(le 2031 6)" "$UOK"
mes "DELETE FROM public.fin_ic_matches WHERE cr_id = '$CR'; DELETE FROM public.fin_contas_receber WHERE id = '$CR'"
mes "SELECT public.t_titulos(2031, 7); SELECT public.t_sc('colacor_sc', 'colacor', '2031-07-10'); SELECT public.t_calcular(2031, 7)"
CR="$(Pq -c "SELECT public.t_cr_mapa('colacor_sc', '2032-06-01', 100, 780)")"
eq "U24 vínculo do mapa que não veio de documento não conta" "$(le 2031 7)" "$UOK"
mes "DELETE FROM public.fin_contas_receber WHERE id = '$CR'"
mes "SELECT public.t_titulos(2031, 8); SELECT public.t_sc('colacor_sc', 'colacor', '2031-08-10'); SELECT public.t_calcular(2031, 8)"
CR="$(Pq -c "SELECT public.t_cr_ic('colacor_sc', 'oben', '2032-06-01', 100)")"
eq "U10c CR da origem numa informativa para OUTRO destino não bloqueia" "$(le 2031 8)" "$UOK"
mes "DELETE FROM public.fin_ic_matches WHERE id = '$CR'"
eq "U0 controle: o mês elegível segue elegível" "$(le 2027 1)" "$UOK"
eq "Z1 mês sem venda sem cobrança: nada muda" "$(le 2026 2)" \
   "receita_bruta=3400/0/3400;cmv=2300/0/2300;despesas_operacionais=350/0/350;resultado_liquido=750/0/750"
eq "Z2 o par elegível segue igual (o resultado intacto)" "$(le 2026 1)" \
   "receita_bruta=3500/-100/3400;cmv=2400/-100/2300;despesas_operacionais=350/0/350;resultado_liquido=750/0/750"

# ── G: gate e ACL ──
como() { printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"; }
Q="SELECT count(*) FROM public.fin_consolidado_intercompany(2026, 1)"
eq "G1 authenticated sem papel staff → 42501" "$(estado "$(como "$CLIENTE" "$Q")")" "42501"
eq "G2 employee lê" "$(Pq -c "$(como "$STAFF" "$Q")")" "4"
eq "G3 master lê" "$(Pq -c "$(como "$MASTER" "$Q")")" "4"
eq "G4 service_role lê" "$(Pq -c "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; $Q")" "4"
eq "G5 anon sem EXECUTE" "$(estado "SET ROLE anon; $Q")" "42501"
eq "G6 ACL: anon/PUBLIC sem, authenticated/service_role com" "$(Pq -c "SELECT string_agg(r || '=' || has_function_privilege(r, 'public.fin_consolidado_intercompany(integer,integer)', 'EXECUTE')::text, ',' ORDER BY r) FROM unnest(ARRAY['anon','authenticated','public','service_role']) r")" \
   "anon=false,authenticated=true,public=false,service_role=true"

# ── T: o trigger — só o master põe e tira a marcação, pela forma certa ──
# Linhas no ano 2029 (nenhum cenário lê esse ano). como() roda como authenticated com o sub dado.
upd() { Pq -c "$(como "$1" "WITH u AS ($2 RETURNING 1) SELECT count(*) FROM u")"; }
LA="$(Pq -c "SELECT public.t_sc('colacor', 'oben', '2029-01-10', p_marcar => false)")"
LD="$(Pq -c "SELECT public.t_sc('colacor', 'oben', '2029-01-11', p_marcar => false)")"
MARCA="UPDATE public.fin_ic_matches SET status = 'intragrupo_sem_cobranca'"
eq "T1 employee não marca → 42501" "$(estado "$(como "$STAFF" "$MARCA WHERE id = '$LA'")")" "42501"
eq "T2a master marca (o cliente manda outro carimbo)" "$(upd "$MASTER" "$MARCA, resolvido_por = '$STAFF', resolvido_em = NULL WHERE id = '$LA'")" "1"
eq "T2 o carimbo é do trigger: resolvido_por = master, resolvido_em preenchido" \
   "$(Pq -c "SELECT status || ',' || COALESCE(resolvido_por::text, '(null)') || ',' || (resolvido_em IS NOT NULL) FROM public.fin_ic_matches WHERE id = '$LA'")" \
   "intragrupo_sem_cobranca,$MASTER,true"
eq "T3 INSERT já no status → 23514" "$(estado "INSERT INTO public.fin_ic_matches (empresa_origem, empresa_destino, cp_id, status)
   SELECT 'colacor', 'oben', cp_id, 'intragrupo_sem_cobranca' FROM public.fin_ic_matches WHERE id = '$LD'")" "23514"
CRB="$(Pq -c "SELECT public.t_par('oben', 'colacor', '2029-02-10', '2029-02-10', p_status => 'sem_contrapartida')")"
LB="$(Pq -c "SELECT id FROM public.fin_ic_matches WHERE cr_id = '$CRB'")"
eq "T4 marcar candidato com CR → 23514" "$(estado "$(como "$MASTER" "$MARCA WHERE id = '$LB'")")" "23514"
LC="$(Pq -c "SELECT public.t_sc('colacor', 'oben', '2029-03-10', p_marcar => false)")"
mes "UPDATE public.fin_ic_matches SET status = 'divergencia_valor' WHERE id = '$LC'"
eq "T5 marcar linha que não é sem_contrapartida → 23514" "$(estado "$(como "$MASTER" "$MARCA WHERE id = '$LC'")")" "23514"
eq "T6 trocar o CP da linha marcada → 23514" "$(estado "$(como "$MASTER" "UPDATE public.fin_ic_matches SET cp_id = (SELECT cp_id FROM public.fin_ic_matches WHERE id = '$LC') WHERE id = '$LA'")")" "23514"
DESFAZ="UPDATE public.fin_ic_matches SET status = 'sem_contrapartida', resolvido_em = now()"
eq "T7 employee não desfaz → 42501" "$(estado "$(como "$STAFF" "$DESFAZ WHERE id = '$LA'")")" "42501"
eq "T8 desfazer para outro status que não sem_contrapartida → 23514" "$(estado "$(como "$MASTER" "UPDATE public.fin_ic_matches SET status = 'desconsiderado' WHERE id = '$LA'")")" "23514"
eq "T9a master desfaz" "$(upd "$MASTER" "$DESFAZ WHERE id = '$LA'")" "1"
eq "T9 desfeito volta a sem_contrapartida NÃO resolvido (a edge refaz a linha)" \
   "$(Pq -c "SELECT status || ',' || (resolvido_por IS NULL) || ',' || (resolvido_em IS NULL) FROM public.fin_ic_matches WHERE id = '$LA'")" "sem_contrapartida,true,true"
eq "T9b master marca de novo" "$(upd "$MASTER" "$MARCA WHERE id = '$LA'")" "1"
eq "T10 DELETE da linha marcada (até como postgres) → 42501 do ramo DELETE" "$(estado_ramo "DELETE FROM public.fin_ic_matches WHERE id = '$LA'" "nao se apaga")" "42501+ramo"
eq "T11 employee muda só a observação da linha marcada" "$(upd "$STAFF" "UPDATE public.fin_ic_matches SET observacao = 'nota' WHERE id = '$LA'")" "1"
eq "T12 service_role (sem usuário) não marca → 42501" "$(estado "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; $MARCA WHERE id = '$LD'")" "42501"
eq "T13 customer: a RLS não deixa tocar (0 linhas)" "$(upd "$CLIENTE" "UPDATE public.fin_ic_matches SET status = 'sem_contrapartida' WHERE id = '$LA'")" "0"
# A edge escreve como service_role, sem usuário: o trigger não pode atrapalhar o INSERT e o DELETE dela.
EDGE="SET ROLE service_role; SET request.jwt.claim.role = 'service_role';"
# CP próprio: na prod o UNIQUE parcial em cp_id recusaria uma 2ª linha com o CP de $LC.
CPN="$(Pq -c "INSERT INTO public.fin_contas_pagar (company, valor_documento, data_emissao, status_titulo, categoria_descricao) VALUES ('oben', 100, '2029-03-11', 'PAGO', 'Compra mercadoria') RETURNING id")"
eq "T15 a edge (service_role) insere linha informativa com o trigger ligado" "$(Pq -c "$EDGE WITH i AS (INSERT INTO public.fin_ic_matches (empresa_origem, empresa_destino, cp_id, status)
   VALUES ('colacor', 'oben', '$CPN', 'sem_contrapartida') RETURNING 1) SELECT count(*) FROM i")" "1"
# Como a edge apaga: pelos ids lidos antes (aqui, todas as linhas de 2029, a marcada inclusive), refiltrando
# status informativo e resolvido_em no próprio DELETE (casamento.ts, apagarInformativos).
IDS2029="$(Pq -c "SELECT string_agg(quote_literal(m.id::text), ',') FROM public.fin_ic_matches m JOIN public.fin_contas_pagar cp ON cp.id = m.cp_id WHERE cp.data_emissao BETWEEN '2029-01-01' AND '2029-12-31'")"
eq "T16 ... e apaga as informativas não resolvidas pelos ids, como a edge faz (a marcada fica)" "$(Pq -c "$EDGE WITH d AS (DELETE FROM public.fin_ic_matches
   WHERE id IN ($IDS2029) AND status IN ('divergencia_valor', 'divergencia_data', 'sem_contrapartida', 'duplicidade_possivel')
   AND resolvido_em IS NULL RETURNING 1) SELECT count(*) FROM d")" "4"
eq "T14 a linha marcada sobreviveu a tudo" "$(Pq -c "SELECT status || ',' || observacao FROM public.fin_ic_matches WHERE id = '$LA'")" "intragrupo_sem_cobranca,nota"

# ── MIG7: re-aplicar com linhas marcadas passa e não as toca ──
antes="$(Pq -c "SELECT count(*) FROM public.fin_ic_matches WHERE status = 'intragrupo_sem_cobranca'")"
eq "MIG7 re-aplicar com linhas marcadas passa" "$(estado "$(cat "$MIG_USADA")")" "verde"
eq "MIG7b ... e as linhas marcadas seguem lá" "$(Pq -c "SELECT count(*) FROM public.fin_ic_matches WHERE status = 'intragrupo_sem_cobranca'")" "$antes"

# ── MIG5: a PRE recusa função de trigger estranha ──
Pq -c "CREATE OR REPLACE FUNCTION public.fin_ic_matches_guarda_sem_cobranca() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END \$f\$"
saida_pre="$(P -qAt -f "$MIG_USADA" 2>&1 || true)"
if printf '%s' "$saida_pre" | grep -q "PRE FALHOU: fin_ic_matches_guarda_sem_cobranca viva"; then eq "MIG5 PRE recusa trigger estranho" "recusou" "recusou"
else eq "MIG5 PRE recusa trigger estranho" "aplicou" "recusou"; fi

# ── MIG4: a PRE recusa corpo estranho (nem o predecessor nem este) ──
Pq -c "CREATE OR REPLACE FUNCTION public.fin_consolidado_intercompany(p_ano integer, p_mes integer)
  RETURNS TABLE(conta text, total_bruto numeric, eliminacoes numeric, total_consolidado numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
  AS \$f\$ BEGIN RETURN; END \$f\$"
cp "$MIG_USADA" "$MIG_ESTRANHA"
saida_pre="$(P -qAt -f "$MIG_ESTRANHA" 2>&1 || true)"
if printf '%s' "$saida_pre" | grep -q "PRE FALHOU: fin_consolidado_intercompany vivo"; then eq "MIG4 PRE recusa corpo estranho" "recusou" "recusou"
else eq "MIG4 PRE recusa corpo estranho" "aplicou" "recusou"; fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK fin-consolidado-ic"
