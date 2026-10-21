#!/usr/bin/env bash
# Prova PG17 da correção da eliminação intercompany no DRE consolidado.
# Migration: supabase/migrations/20261021120000_fin_consolidado_ic_sinal_cmv.sql (a REAL), aplicada sobre o
# predecessor REAL (o corpo de 20260525020001_fin_rpc_gate_auth_p1.sql, que é o vivo na prod: md5
# c645a48b2803e122e770341d44b9aaaf, psql-ro 2026-10-21). Tabelas e has_role entram como stubs com as
# colunas de prod que a função lê.
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
#   G   gate: authenticated sem papel → 42501; employee, master e service_role leem; anon sem EXECUTE
#   MIG PRE aceita o predecessor; re-aplicar passa; PRE recusa corpo estranho; grant extra sobrevive
#
#   bash db/test-fin-consolidado-ic.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-fin-consolidado-ic.sh   # o outro locale (rode os dois)
#   SABOTAGEM=<nome> bash db/test-fin-consolidado-ic.sh            # tem de ficar VERMELHA
#   bash db/test-fin-consolidado-ic.sh --falsificar                # controle verde + cada sabotagem vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261021120000_fin_consolidado_ic_sinal_cmv.sql"
MIG_PREDECESSOR="$REPO_ROOT/supabase/migrations/20260525020001_fin_rpc_gate_auth_p1.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="sinal:A1 so_receita:A1 coalesce_bruto:N1 nulo_parcial:N2 sem_escopo:C1 sem_status:S1 sem_pendente:P1 valor_igual:P2 mesmo_mes:P3a sem_categoria:P4 multi_linha:P9 cancelado:P5 status_nulo:P13 consist_d:P6 consist_r:P11 uso_unico:P7 teto:P8 empresa_do_titulo:P10 sem_gate:G1"
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
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências; padrão ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  sinal)          sabotar "THEN -e.valor_elim" "THEN e.valor_elim" ;;
  so_receita)     sabotar "IN ('receita_bruta', 'cmv') THEN -e.valor_elim" "IN ('receita_bruta') THEN -e.valor_elim" ;;
  coalesce_bruto) sabotar "CASE WHEN count(s.receita_bruta) = count(*) THEN sum(s.receita_bruta) END" "COALESCE(sum(s.receita_bruta), 0)" ;;
  nulo_parcial)   sabotar "CASE WHEN count(s.cmv) = count(*) THEN sum(s.cmv) END" "sum(s.cmv)" ;;
  sem_escopo)     sabotar "      JOIN snap sd ON sd.company = c.empresa_destino" "      LEFT JOIN snap sd ON sd.company = c.empresa_destino" ;;
  sem_status)     sabotar "WHERE m.status IN ('auto_matched', 'manual_matched')" "WHERE m.status IS NOT NULL" ;;
  sem_pendente)   sabotar "count(*) FILTER (WHERE NOT j.ok) > 0 OR " "" ;;
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
  sem_gate)       sabotar "  IF NOT (" "  IF false AND NOT (" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
# md5 do corpo ENTRE os dólares, como o banco o guarda em prosrc.
md5_corpo() {
  python3 -I - "$1" <<'PY2'
import hashlib, sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION public.fin_consolidado_intercompany")
j = s.index("AS $$", i) + len("AS $$"); k = s.index("$$;", j)
print(hashlib.md5(s[j:k].encode()).hexdigest())
PY2
}
# Corpo sabotado = corpo NOVO: reassina o "este" do PRE/PÓS (como faria quem mudasse a função e o
# arquivo juntos). Sem isso o P1 da PÓS aborta o apply e o vermelho não chega ao assert de comportamento.
if [ -n "${SABOTAGEM:-}" ]; then
  ESTE_ARQ="$(md5_corpo "$MIG")"; ESTE_SAB="$(md5_corpo "$MIG_USADA")"
  sabotar "$ESTE_ARQ" "$ESTE_SAB"
  echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"
fi
# O predecessor REAL: só o bloco da função (o arquivo também recria outras 3 RPCs financeiras).
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
  categoria_codigo text, categoria_descricao text, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.fin_contas_pagar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text NOT NULL,
  valor_documento numeric, data_emissao date, status_titulo text,
  categoria_codigo text, categoria_descricao text, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.fin_ic_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_origem text NOT NULL, empresa_destino text NOT NULL,
  cr_id uuid REFERENCES public.fin_contas_receber(id) ON DELETE SET NULL,
  cp_id uuid REFERENCES public.fin_contas_pagar(id) ON DELETE SET NULL,
  valor_origem numeric, valor_destino numeric, status text NOT NULL,
  CHECK (empresa_origem <> empresa_destino), CHECK (cr_id IS NOT NULL OR cp_id IS NOT NULL)
);

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
SQL
Pq -c "INSERT INTO public.user_roles VALUES ('$STAFF','employee'), ('$MASTER','master'), ('$CLIENTE','customer')"

# ── MIG0: o predecessor REAL é o corpo vivo da prod ──
P -q -f "$PRED"
eq "MIG0 predecessor = md5 da prod" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fin_consolidado_intercompany(integer,integer)'::regprocedure")" "c645a48b2803e122e770341d44b9aaaf"
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

# ── MIG4: a PRE recusa corpo estranho (nem o predecessor nem este) ──
Pq -c "CREATE OR REPLACE FUNCTION public.fin_consolidado_intercompany(p_ano integer, p_mes integer)
  RETURNS TABLE(conta text, total_bruto numeric, eliminacoes numeric, total_consolidado numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
  AS \$f\$ BEGIN RETURN; END \$f\$"
cp "$MIG_USADA" "$MIG_ESTRANHA"
saida_pre="$(P -qAt -f "$MIG_ESTRANHA" 2>&1 || true)"
if printf '%s' "$saida_pre" | grep -q "PRE FALHOU"; then eq "MIG4 PRE recusa corpo estranho" "recusou" "recusou"
else eq "MIG4 PRE recusa corpo estranho" "aplicou" "recusou"; fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK fin-consolidado-ic"
