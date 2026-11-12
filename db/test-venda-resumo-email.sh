#!/usr/bin/env bash
# Prova PG17 da 20261113110100_venda_resumo_email_controle (venda R2 · Entrega 1): grupo controle estável + resumo
# diário por e-mail + sensor com denominador.
#
# O que prova EXECUTANDO (PL/pgSQL é late-bound):
#  T0  os predecessores montados aqui (recortados das migrations do repo) são os vivos em prod (md5 medidos 12/11)
#  S1  régua do hash: u ∈ [0,1) em 4.000 uuids (nunca negativo — bit(32)→bigint), fração de controle ≈ 15%, e o u de
#      um caso fixo bate com o md5 calculado FORA do banco (python)
#  S2  sorteio inicial: universo = compradores já em venda_sugestao; início = próximo dia útil; P1/P2 da PÓS
#  S3  imutabilidade: UPDATE/DELETE/TRUNCATE do sorteio e dos braços → 55000
#  B1  trigger: ativa ≥ início recebe o braço do comprador (inclusive comprador NOVO, pela mesma régua); antes do
#      início, historico e sombra → NULL; braço informado errado → 55000; braço gravado não muda; transição
#      sombra→ativa recebe braço; UPDATE de desfecho preserva
#  L1  a farmer não vê o controle: lista do Meu Dia, marcar_mostrada, policy de SELECT; linha anterior ao início segue
#  R1  preparar: seleção top-8 sobre os DOIS braços (5 cidade + 3 atraso), e-mail só com o tratamento, cópia ao master
#      com tokens próprios, itens gravados, último preço em R$ 1.234,50, sem custo; idempotente; falha → tentativa 2;
#      antes do início / sem lista do dia → erro sem escrita; teste não grava seleção
#  C1  clique: destinatário grava (1ª vez) e marca mostrada dos itens do e-mail; master no link da farmer não grava;
#      founder na cópia grava sem marcar mostrada; customer → 42501; token desconhecido → NULL
#  A1  abertura: 1ª vez true, depois false; authenticated não executa
#  P1  painel: entregues/clicadas/tentativas/ofertadas, contato ANTES do envio não conta, contato atribuído a UMA
#      oportunidade, acesso validado, status, efeito por braço (coorte madura), A/A
#  V1  venda_painel: sem controle, JSON byte a byte o do predecessor; com controle, na_lista o exclui
#  M1  re-apply idempotente; PRE recusa corpo alheio; ACL (PUBLIC/anon fechados)
#
#   bash db/test-venda-resumo-email.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-resumo-email.sh   # mesma prova no outro locale (marcas ASCII)
#   bash db/test-venda-resumo-email.sh --falsificar               # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261113110100_venda_resumo_email_controle.sql"
MIG_JSON="$REPO_ROOT/supabase/migrations/20261108000000_cliente_sucessao_consumidores.sql"
MIG_MOSTRADA="$REPO_ROOT/supabase/migrations/20261020174221_venda_cliente_espinha.sql"
MIG_PAINEL="$REPO_ROOT/supabase/migrations/20261108010000_venda_painel_heranca.sql"
MIG_LISTA="$REPO_ROOT/supabase/migrations/20261028220003_venda_lista_acesso.sql"
for f in "$MIG" "$MIG_JSON" "$MIG_MOSTRADA" "$MIG_PAINEL" "$MIG_LISTA"; do [ -f "$f" ] || { echo "ausente: $f"; exit 1; }; done

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca exata.
  SABOTAGENS="hash_int:S1a lista_ve_controle:L1a mostrada_controle:L1b policy_aberta:POST!P8_FALHOU selecao_so_tratamento:R1b email_com_controle:R1c braco_livre:B1d preparar_aberto:POST!P6_FALHOU clique_qualquer:C1c mostrada_por_outro:C1e oferta_nao_atendeu:P1d contato_antes:P1c painel_com_controle:V1b inicio_hoje:S2b nome_sem_coalesce:R1c sem_gate_edge:R1m"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-resumo.XXXXXX")"
  echo "== CONTROLE =="
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "controle VERMELHO - falsificacao abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK venda-resumo-email" "$LOGDIR/controle.log" || { echo "controle sem marcador de fim"; exit 1; }
  echo "OK controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "X $s: suite ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "X $s: sabotagem NAO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      *!*) marca="${a#*!}"; marca="${marca//_/ }" ;;
      *)   marca="FAIL $a " ;;
    esac
    if grep -qF -- "$marca" "$LOGDIR/$s.log"; then
      echo "OK $s: vermelha em [$marca]"
    else
      echo "X $s: vermelha, mas NAO no assert esperado [$marca] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5671}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-resumo.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
PRED_SQL="$WORK/pred.sql"
# Saída SÓ é verde se a suíte chegou ao fim: um `set -u` (unbound variable) aborta com `$?` = 0 dentro do trap EXIT
# (medido no bash local, 12/11/2026 — a sabotagem hash_int saía "VERDE" com a suíte morta no meio). Por isso o
# trap não confia no `$?`: sem o marcador TERMINOU, sai 99.
TERMINOU=0
cleanup() {
  local rc=$?
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"
  if [ "$TERMINOU" != 1 ] && [ "$rc" -eq 0 ]; then echo "ABORTOU antes do fim (rc mascarado)"; rc=99; fi
  exit "$rc"
}
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
# Os predecessores: o CREATE de cada função recortado da migration que o pôs em prod (o T0 confere o md5).
python3 -I - "$PRED_SQL" "$MIG_JSON" "$MIG_MOSTRADA" "$MIG_PAINEL" "$MIG_LISTA" <<'PY'
import re, sys
dst, mj, mm, mp, ml = sys.argv[1:]
def recorta(arq, cabeca):
    s = open(arq, encoding="utf-8").read()
    i = s.index(cabeca)
    m = re.search(r"\nAS (\$[A-Za-z_]*\$)", s[i:])
    tag = m.group(1)
    j = i + m.end()
    k = s.index(tag, j) + len(tag)
    return s[i:k] + ";\n"
out = [recorta(mj, "CREATE OR REPLACE FUNCTION private._venda_sugestoes_json"),
       recorta(mm, "CREATE OR REPLACE FUNCTION public.venda_marcar_mostrada"),
       recorta(mp, "CREATE OR REPLACE FUNCTION public.venda_painel"),
       recorta(mp, "CREATE OR REPLACE FUNCTION public.venda_painel").replace("public.venda_painel(", "public.venda_painel_v0(", 1),
       recorta(ml, "CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes")]
open(dst, "w", encoding="utf-8").write("\n".join(out))
PY

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
  hash_int)             sabotar "::bit(32)::bigint)::numeric / 4294967296" "::bit(32)::int)::numeric / 4294967296" ;;
  lista_ve_controle)    sabotar "       AND s.braco IS DISTINCT FROM 'controle'
       AND s.farmer_user_id = p_farmer" "       AND s.farmer_user_id = p_farmer" ;;
  mostrada_controle)    sabotar "     AND mostrada_em IS NULL
     AND braco IS DISTINCT FROM 'controle';" "     AND mostrada_em IS NULL;" ;;
  policy_aberta)        sabotar "USING ((farmer_user_id = auth.uid() AND fase = 'ativa' AND braco IS DISTINCT FROM 'controle')" \
                                "USING ((farmer_user_id = auth.uid() AND fase = 'ativa')" ;;
  selecao_so_tratamento) sabotar "     WHERE s.fase = 'ativa' AND s.tipo = 'recompra'
       AND s.farmer_user_id = p_farmer AND s.dia_referencia = p_dia
     GROUP BY s.comprador_id" "     WHERE s.fase = 'ativa' AND s.tipo = 'recompra' AND s.braco IS DISTINCT FROM 'controle'
       AND s.farmer_user_id = p_farmer AND s.dia_referencia = p_dia
     GROUP BY s.comprador_id" ;;
  email_com_controle)   sabotar "x.farmer_user_id = r.farmer_user_id AND x.braco = 'tratamento'" "x.farmer_user_id = r.farmer_user_id" ;;
  braco_livre)          sabotar "  NEW.braco := v_esperado;
  RETURN NEW;" "  NEW.braco := COALESCE(NEW.braco, v_esperado);
  RETURN NEW;"
                        sabotar "  IF NEW.braco IS NOT NULL AND NEW.braco IS DISTINCT FROM v_esperado" "  IF false AND NEW.braco IS NOT NULL AND NEW.braco IS DISTINCT FROM v_esperado" ;;
  preparar_aberto)      sabotar "REVOKE ALL ON FUNCTION public.venda_resumo_preparar(date, uuid) FROM PUBLIC, anon, authenticated;" \
                                "GRANT EXECUTE ON FUNCTION public.venda_resumo_preparar(date, uuid) TO anon;" ;;
  clique_qualquer)      sabotar "  v_dest := l.destinatario_user_id = v_uid;" "  v_dest := true;" ;;
  # Duas camadas guardam a cópia (tipo farmer E s.farmer_user_id = quem clicou): sabotar só uma fica VERDE (medido).
  mostrada_por_outro)   sabotar "  IF v_dest AND l.tipo = 'farmer' AND l.selecao_id IS NOT NULL THEN" "  IF v_dest AND l.selecao_id IS NOT NULL THEN"
                        sabotar "       AND s.farmer_user_id = v_uid AND s.fase = 'ativa' AND s.braco IS DISTINCT FROM 'controle'" "       AND s.fase = 'ativa' AND s.braco IS DISTINCT FROM 'controle'" ;;
  oferta_nao_atendeu)   sabotar "o.resultado IN ('vendeu', 'vai_pedir', 'sem_interesse')" "o.resultado IS NOT NULL" ;;
  contato_antes)        sabotar "         AND vc.atualizado_em >= COALESCE(o.enviado_em, 'infinity'::timestamptz)
" "" ;;
  painel_com_controle)  sabotar "     WHERE s.fase = 'ativa' AND s.braco IS DISTINCT FROM 'controle'
       AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim" "     WHERE s.fase = 'ativa' AND true
       AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim" ;;
  inicio_hoje)          sabotar "  v_inicio := v_hoje + CASE extract(isodow FROM v_hoje)::int WHEN 5 THEN 3 WHEN 6 THEN 2 ELSE 1 END;" \
                                "  v_inicio := v_hoje;" ;;
  sem_gate_edge)        sabotar "  IF v_edge IS NULL OR v_edge IN ('v1.0-sensor-inicial', 'v1.1-resumo-param-so-no-app', 'v1.2-radar-leads-vendedor') THEN" "  IF false THEN" ;;
  nome_sem_coalesce)    sabotar "  v_nome := COALESCE(v_nome, 'Cliente sem nome no cadastro');" "" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
# Corpo sabotado das funções recriadas = corpo NOVO: reassina o md5 "este" do PRE/PÓS (como faria quem mudasse a
# função e o arquivo juntos). Sem isso a P7 aborta o apply e o vermelho não chega ao assert de comportamento.
reassinar() {
  python3 -I - "$MIG_USADA" <<'PY2'
import hashlib, re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
for cab, velho in (("CREATE OR REPLACE FUNCTION private._venda_sugestoes_json", "ccc8189a3d2962e073a3d360581efb61"),
                   ("CREATE OR REPLACE FUNCTION public.venda_marcar_mostrada", "3e286aaea8d6f4c7b1bce316824d5be7"),
                   ("CREATE OR REPLACE FUNCTION public.venda_painel", "76d2d0f050e9240392cd1362ef2d82bd")):
    i = s.index(cab); j = s.index("AS $function$", i) + len("AS $function$"); k = s.index("$function$", j)
    s = s.replace(velho, hashlib.md5(s[j:k].encode()).hexdigest())
open(p, "w", encoding="utf-8").write(s)
PY2
}
if [ -n "${SABOTAGEM:-}" ]; then reassinar; echo "SABOTAGEM ATIVA: $SABOTAGEM"; fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
estado() { # SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | sed -n 1p | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
como() { printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"; }
PASS=0; FAIL=0; FAIL_APPLY=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

F1=00000000-0000-0000-0000-0000000000f1; F2=00000000-0000-0000-0000-0000000000f2
M=00000000-0000-0000-0000-0000000000ee; CUST=00000000-0000-0000-0000-0000000000cc

# ── Esquema mínimo com as colunas/constraints de prod (psql-ro, 12/11/2026) ─────────────────────────────────────
P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE SCHEMA private; GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_nome text, p_sched text, p_cmd text) RETURNS bigint LANGUAGE sql AS \$\$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_nome, p_sched, p_cmd)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid \$\$;

CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$\$;
CREATE TYPE public.commercial_role AS ENUM ('farmer', 'hunter', 'master');
CREATE TABLE public.commercial_roles (id uuid DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL);
CREATE TABLE public.profiles (id uuid DEFAULT gen_random_uuid(), user_id uuid, name text, razao_social text, phone text,
  email text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.company_config (key text PRIMARY KEY, value text);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, descricao text);
CREATE TABLE public.cliente_sucessoes (id uuid DEFAULT gen_random_uuid(), evento_id uuid, antigo_documento text,
  declarado_em timestamptz DEFAULT now());
CREATE FUNCTION private.cliente_resolver_documento(p text) RETURNS TABLE (nome text) LANGUAGE sql STABLE
  AS \$\$ SELECT NULL::text WHERE false \$\$;
CREATE TABLE public.venda_recompra (comprador_id uuid, empresa text, omie_codigo_produto bigint, cadencia_dias numeric,
  ultima_compra date, ultimo_preco numeric, due_ratio numeric);
CREATE TABLE public.fornecedor_alerta (id bigserial PRIMARY KEY, empresa text, tipo text, severidade text, titulo text,
  mensagem text, status text, metadata jsonb, email_enviado_em timestamptz, criado_em timestamptz DEFAULT now(),
  CHECK (status IN ('pendente_notificacao','notificado','falha_notificacao','ignorado')));
CREATE TABLE public.acoes_execucoes (id uuid DEFAULT gen_random_uuid(), acao text, origem text, iniciado_em timestamptz,
  finalizado_em timestamptz, status text, detalhes jsonb, CHECK (status IN ('executando','sucesso','erro')),
  CHECK (origem IN ('manual','automatica')));
CREATE TABLE public.venda_config (chave text PRIMARY KEY, valor jsonb NOT NULL, atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.venda_onda_log (onda text PRIMARY KEY, ligada_em timestamptz NOT NULL DEFAULT now(), condicao jsonb NOT NULL);
CREATE TABLE public.venda_gerador_execucao (dia_referencia date NOT NULL, fase text NOT NULL,
  primeira_em timestamptz NOT NULL DEFAULT now(), ultima_em timestamptz NOT NULL DEFAULT now(), linhas int NOT NULL DEFAULT 0,
  PRIMARY KEY (dia_referencia, fase));
CREATE TABLE public.venda_contato (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_user_id uuid NOT NULL,
  comprador_id uuid NOT NULL, dia date NOT NULL, resultado text NOT NULL, motivo text,
  criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farmer_user_id, comprador_id, dia));
CREATE TABLE public.venda_lista_acesso (farmer_user_id uuid NOT NULL, dia date NOT NULL,
  primeira_em timestamptz NOT NULL DEFAULT now(), ultima_em timestamptz NOT NULL DEFAULT now(),
  n_leituras integer NOT NULL DEFAULT 1, n_compradores integer NOT NULL, PRIMARY KEY (farmer_user_id, dia));
CREATE TABLE public.venda_sugestao (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('recompra','complemento','preco')),
  fase text NOT NULL CHECK (fase IN ('historico','sombra','ativa')),
  dia_referencia date NOT NULL, gerada_em timestamptz NOT NULL DEFAULT now(),
  farmer_user_id uuid NOT NULL, comprador_id uuid NOT NULL, empresa text NOT NULL,
  omie_codigo_produto bigint, familia text, qtd_ref numeric, valor_ref numeric, preco_alvo numeric,
  motivo_entrada text NOT NULL DEFAULT 'teste', mostrada_em timestamptz,
  desfecho text CHECK (desfecho IN ('virou_pedido','nao_virou','nao_medivel')), desfecho_motivo text,
  sales_order_id uuid, valor_realizado numeric, avaliado_em timestamptz, preco_anterior numeric,
  sucessao_origem jsonb, valor_ref_referencia_origem boolean NOT NULL DEFAULT false);
ALTER TABLE public.venda_sugestao ENABLE ROW LEVEL SECURITY;
CREATE POLICY "venda_sugestao_select" ON public.venda_sugestao FOR SELECT TO authenticated
  USING (((farmer_user_id = auth.uid()) AND (fase = 'ativa'::text)) OR (SELECT has_role(auth.uid(), 'master'::app_role)));
GRANT SELECT ON public.venda_sugestao TO authenticated;

INSERT INTO public.venda_config VALUES
  ('onda_recompra','true'), ('onda_complemento','true'), ('onda_preco','false'),
  ('teto_maiores_atrasos','10'), ('janela_dias','{"recompra":14,"complemento":30,"preco":30}');
INSERT INTO public.user_roles VALUES ('$M','master'), ('$F1','employee'), ('$F2','employee'), ('$CUST','customer');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES ('$F1','farmer'), ('$F2','farmer'), ('$M','master');
INSERT INTO public.profiles (user_id, name, email) VALUES ('$F1','REGINA SILVA','regina@exemplo.test'),
  ('$F2','Tatyana','tatyana@exemplo.test'), ('$M','Lucas','founder@exemplo.test');
CREATE TABLE public.deploy_atestacoes (request_id bigint, observado_em timestamptz, edge text, versao text, fonte text, via text);
CREATE FUNCTION public.deploy_atestacoes_janela_viva() RETURNS TABLE (request_id bigint, observado_em timestamptz, edge text,
  versao text, fonte text, via text) LANGUAGE sql STABLE AS \$\$ SELECT NULL::bigint, NULL::timestamptz, NULL::text, NULL::text,
  NULL::text, NULL::text WHERE false \$\$;
INSERT INTO public.deploy_atestacoes VALUES (1, now() - interval '1 day', 'dispatch-notifications', 'v1.2-radar-leads-vendedor', 'x', 'sonda');
CREATE TABLE public.prova_antes (j jsonb);
GRANT ALL ON public.prova_antes TO authenticated;
SQL

# ── T0: predecessores = prod ────────────────────────────────────────────────────────────────────────────────────
P -q -f "$PRED_SQL" > /dev/null
md5f() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')"; }
eq "T0a _venda_sugestoes_json = prod" "$(md5f 'private._venda_sugestoes_json(uuid,date)')" "6e26a8360dbfc2e0af9559d6a75da893"
eq "T0b venda_marcar_mostrada = prod" "$(md5f 'public.venda_marcar_mostrada(uuid[])')" "6caf2c9644ff0380fc31617adcf471e7"
eq "T0c venda_painel = prod" "$(md5f 'public.venda_painel(date,date)')" "2b3f2c1b9af99c6dcc34f413f9534c54"
eq "T0d venda_minhas_sugestoes = prod" "$(md5f 'public.venda_minhas_sugestoes(date)')" "ca1ece0e8e887d2b3e66d9fc757f1b3f"

# Universo do sorteio: 600 compradores determinísticos com linhas historico ANTES da migration (A/A + fração).
P -q -c "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, desfecho, desfecho_motivo, avaliado_em, sales_order_id)
  SELECT 'recompra', 'historico', DATE '2026-01-05', '$F1', md5('c' || g)::uuid, 'oben', 1,
         CASE WHEN g % 10 = 0 THEN 'virou_pedido' ELSE 'nao_virou' END, NULL, now(),
         CASE WHEN g % 10 = 0 THEN gen_random_uuid() END
    FROM generate_series(1, 600) g"


# ── a migration ─────────────────────────────────────────────────────────────────────────────────────────────────
if ! P -q -f "$MIG_USADA" > "$WORK/apply.log" 2>&1; then echo "FAIL apply"; FAIL_APPLY=1; sed -n 1,20p "$WORK/apply.log"; fi
grep -q 'venda-resumo-email OK' "$WORK/apply.log" 2>/dev/null || grep -E 'FALHOU|ERRO|ERROR' "$WORK/apply.log" | sed -n 1,3p

INICIO="$(Pq -c "SELECT inicio FROM public.venda_braco_sorteio")"
HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
echo "inicio=$INICIO hoje=$HOJE"

# ── S1: régua do hash ───────────────────────────────────────────────────────────────────────────────────────────
eq "S1a u em [0,1) em 4000 uuids" "$(Pq -c "SELECT count(*) FILTER (WHERE u < 0 OR u >= 1) FROM (SELECT private.venda_braco_u('semente-x', md5('z' || g)::uuid) u FROM generate_series(1,4000) g) x")" "0"
eq "S1b fracao controle 4000 uuids entre 12% e 18%" "$(Pq -c "SELECT (avg((private.venda_braco_u('venda-r2-controle-2026-11-12', md5('z' || g)::uuid) < 0.15)::int) BETWEEN 0.12 AND 0.18) FROM generate_series(1,4000) g")" "t"
U_PY="$(python3 -I -c "import hashlib; h=hashlib.md5(b'venda-r2-controle-2026-11-12:00000000-0000-0000-0000-0000000000c1').hexdigest(); print(repr(int(h[:8],16)/2**32)[:12])")"
U_PG="$(Pq -c "SELECT left(private.venda_braco_u('venda-r2-controle-2026-11-12', '00000000-0000-0000-0000-0000000000c1')::text, 12)")"
eq "S1c u de caso fixo = md5 calculado fora do banco" "$U_PG" "$U_PY"

# ── S2: sorteio inicial ─────────────────────────────────────────────────────────────────────────────────────────
eq "S2a universo inicial = compradores pre-existentes" "$(Pq -c "SELECT n_inicial || ' ' || (SELECT count(*) FROM public.venda_braco_comprador WHERE origem = 'sorteio_inicial') FROM public.venda_braco_sorteio")" "600 600"
eq "S2b inicio = proximo dia util" "$INICIO" "$(Pq -c "SELECT private.venda_prox_dia_util('$HOJE')")"
eq "S2c prox_dia_util seg/sex/sab/dom" "$(Pq -c "SELECT string_agg(private.venda_prox_dia_util(d)::text, ' ' ORDER BY d) FROM unnest(ARRAY[DATE '2026-11-09', DATE '2026-11-13', DATE '2026-11-14', DATE '2026-11-15']) d")" "2026-11-10 2026-11-16 2026-11-16 2026-11-16"

# ── S3: imutabilidade ───────────────────────────────────────────────────────────────────────────────────────────
eq "S3a UPDATE braco → 55000" "$(estado "UPDATE public.venda_braco_comprador SET braco = 'tratamento' WHERE braco = 'controle'")" "55000"
eq "S3b DELETE braco → 55000" "$(estado "DELETE FROM public.venda_braco_comprador WHERE true")" "55000"
eq "S3c TRUNCATE braco → 55000" "$(estado "TRUNCATE public.venda_braco_comprador")" "55000"
eq "S3d UPDATE sorteio → 55000" "$(estado "UPDATE public.venda_braco_sorteio SET fracao_controle = 0.2 WHERE id = 1")" "55000"

# Compradores de teste por braço (a régua decide; escolhidos pela régua, não forçados)
CTRL=($(Pq -c "SELECT comprador_id FROM public.venda_braco_comprador WHERE braco = 'controle' ORDER BY comprador_id LIMIT 3"))
TRAT=($(Pq -c "SELECT comprador_id FROM public.venda_braco_comprador WHERE braco = 'tratamento' ORDER BY comprador_id LIMIT 8"))
NOVO="$(Pq -c "SELECT md5('novo' || g)::uuid FROM generate_series(1,500) g WHERE private.venda_braco_u('venda-r2-controle-2026-11-12', md5('novo' || g)::uuid) < 0.15 LIMIT 1")"

# ── B1: trigger do braço ────────────────────────────────────────────────────────────────────────────────────────
ins() { # $1 fase $2 dia $3 comprador [$4 braco]
  Pq -c "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto${4:+, braco})
         VALUES ('recompra', '$1', '$2', '$F2', '$3', 'colacor', 99${4:+, '$4'}) RETURNING coalesce(braco, 'NULL')"; }
eq "B1a ativa >= inicio, comprador controle" "$(ins ativa "$INICIO" "${CTRL[0]}")" "controle"
eq "B1b ativa >= inicio, comprador tratamento" "$(ins ativa "$INICIO" "${TRAT[0]}")" "tratamento"
eq "B1c comprador NOVO recebe pela mesma regua" "$(ins ativa "$INICIO" "$NOVO") $(Pq -c "SELECT origem FROM public.venda_braco_comprador WHERE comprador_id = '$NOVO'")" "controle primeira_aparicao"
eq "B1d braco informado errado → 55000" "$(estado "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, braco) VALUES ('recompra', 'ativa', '$INICIO', '$F2', '${CTRL[1]}', 'colacor', 98, 'tratamento')")" "55000"
eq "B1e ativa antes do inicio → NULL" "$(ins ativa "$HOJE" "${CTRL[0]}")" "NULL"
eq "B1f sombra >= inicio → NULL" "$(ins sombra "$INICIO" "${CTRL[0]}")" "NULL"
eq "B1g UPDATE de braco gravado → 55000" "$(estado "UPDATE public.venda_sugestao SET braco = 'tratamento' WHERE braco = 'controle'")" "55000"
eq "B1h UPDATE de desfecho preserva o braco" "$(Pq -c "UPDATE public.venda_sugestao SET desfecho = 'nao_virou', avaliado_em = now() WHERE fase = 'ativa' AND comprador_id = '${CTRL[0]}' AND dia_referencia = '$INICIO' RETURNING braco")" "controle"
eq "B1i transicao sombra→ativa recebe braco" "$(Pq -c "UPDATE public.venda_sugestao SET fase = 'ativa' WHERE fase = 'sombra' AND comprador_id = '${CTRL[0]}' RETURNING braco")" "controle"
P -q -c "DELETE FROM public.venda_sugestao WHERE farmer_user_id = '$F2'"

# ── Cenário do dia D = início: farmer F1 com 6 compradores de cidade (2 controle) e 5 de atraso (1 controle) ────
D="$INICIO"
CID=("${TRAT[0]}" "${TRAT[1]}" "${CTRL[0]}" "${TRAT[2]}" "${CTRL[1]}" "${TRAT[3]}")
ATR=("${TRAT[4]}" "${CTRL[2]}" "${TRAT[5]}" "${TRAT[6]}" "${TRAT[7]}")
i=0
for c in "${CID[@]}"; do i=$((i+1)); v=$((10000 - i * 1000))
  P -q -c "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, qtd_ref, valor_ref, motivo_entrada)
           SELECT 'recompra', 'ativa', '$D', '$F1', '$c', 'oben', 100 + k, 2.5, $v / 4.0, 'entrega amanhã em Divinopolis' FROM generate_series(1,4) k"
done
i=0
for c in "${ATR[@]}"; do i=$((i+1)); v=$((5000 - i * 500))
  P -q -c "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, qtd_ref, valor_ref, motivo_entrada)
           VALUES ('recompra', 'ativa', '$D', '$F1', '$c', 'oben', 200, 12, $v, 'maior atraso da carteira')"
done
P -q <<SQL
INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, familia, motivo_entrada)
VALUES ('complemento', 'ativa', '$D', '$F1', '${TRAT[0]}', 'oben', 'Seladoras', 'clientes parecidos compram');
INSERT INTO public.omie_products VALUES (101, 'oben', 'VERNIZ PU BRILHANTE 3,6L');
INSERT INTO public.venda_recompra (comprador_id, empresa, omie_codigo_produto, cadencia_dias, ultima_compra, ultimo_preco)
VALUES ('${TRAT[0]}', 'oben', 101, 30.4, DATE '$D' - 45, 1234.5);
INSERT INTO public.profiles (user_id, name, phone) VALUES ('${TRAT[0]}', 'Moveis Alfa', '(37) 99999-0001'),
  ('${CTRL[0]}', 'Controle Beta', '(37) 99999-0002');
INSERT INTO public.venda_gerador_execucao (dia_referencia, fase, linhas) VALUES ('$D', 'ativa', 30);
SQL
# uma linha de F1 ANTES do início (pré-experimento): continua visível
P -q -c "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, motivo_entrada)
         VALUES ('recompra', 'ativa', '$HOJE', '$F1', '${CTRL[1]}', 'oben', 300, 'maior atraso da carteira')"

# ── L1: a farmer não vê o controle ──────────────────────────────────────────────────────────────────────────────
LISTA="$(Pq -c "$(como "$F1" "SELECT public.venda_minhas_sugestoes('$D')::text")")"
eq "L1a lista do Meu Dia sem o controle" "$(printf '%s' "$LISTA" | python3 -I -c "import json,sys; j=json.load(sys.stdin); print(len(j['compradores']))")" "8"
CTRL_IDS="$(Pq -c "SELECT array_agg(id)::text FROM public.venda_sugestao WHERE braco = 'controle' AND farmer_user_id = '$F1'")"
eq "L1b marcar_mostrada ignora o controle" "$(Pq -c "$(como "$F1" "SELECT public.venda_marcar_mostrada('$CTRL_IDS'::uuid[])")")" "0"
eq "L1c policy: farmer nao le linha do controle" "$(Pq -c "$(como "$F1" "SELECT count(*) FROM public.venda_sugestao WHERE braco = 'controle'")")" "0"
eq "L1d master le o controle" "$(Pq -c "$(como "$M" "SELECT count(*) > 0 FROM public.venda_sugestao WHERE braco = 'controle'")")" "t"
eq "L1e linha anterior ao inicio segue na lista" "$(Pq -c "$(como "$F1" "SELECT jsonb_array_length(public.venda_minhas_sugestoes('$HOJE') -> 'compradores')")")" "1"

# ── R1: o preparo ───────────────────────────────────────────────────────────────────────────────────────────────
eq "R1m edge atestada antiga (v1.2) → erro sem escrita" "$(Pq -c "SELECT public.venda_resumo_preparar('$D') ->> 'erro'")|$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta")|$(Pq -c "SELECT count(*) FROM public.venda_resumo_selecao")" "edge_desatualizada|0|0"
P -q -c "INSERT INTO public.deploy_atestacoes VALUES (2, now(), 'dispatch-notifications', 'v1.3-resumo-venda-pixel', 'x', 'sonda')"
eq "R1a antes do inicio → erro sem escrita" "$(Pq -c "SELECT public.venda_resumo_preparar('$HOJE') ->> 'erro'")|$(Pq -c "SELECT count(*) FROM public.venda_resumo_envio")" "antes_do_inicio|0"
eq "R1a2 sem lista do dia → erro" "$(Pq -c "SELECT public.venda_resumo_preparar(DATE '$D' + 1) ->> 'erro'")" "lista_do_dia_ausente"
OUT="$(Pq -c "SELECT public.venda_resumo_preparar('$D')::text")"
eq "R1b selecao: 8, os dois bracos (3 controle), 5 cidade + 3 atraso" "$(Pq -c "SELECT count(*) || ' ' || count(*) FILTER (WHERE braco = 'controle') || ' ' || count(*) FILTER (WHERE grupo = 'cidade_amanha') FROM public.venda_resumo_selecao WHERE farmer_user_id = '$F1' AND dia = '$D'")" "8 3 5"
eq "R1c e-mail da farmer leva so o tratamento" "$(Pq -c "SELECT e.n_oportunidades || ' ' || (SELECT count(*) FROM public.venda_resumo_link l JOIN public.venda_resumo_selecao x ON x.id = l.selecao_id WHERE l.envio_id = e.id AND x.braco = 'controle') FROM public.venda_resumo_envio e WHERE e.tipo = 'farmer' AND e.farmer_user_id = '$F1'")" "5 0"
MSG="$(Pq -c "SELECT fa.mensagem FROM public.fornecedor_alerta fa JOIN public.venda_resumo_envio e ON e.alerta_id = fa.id WHERE e.tipo = 'farmer' AND e.farmer_user_id = '$F1'")"
tem() { if [[ "$MSG" == *"$1"* ]]; then echo sim; else echo nao; fi; }   # sem pipe: grep -q + pipefail = SIGPIPE
eq "R1d texto: nome, telefone, SKU, ultimo preco BRL, cadencia, familia, link" "$(tem 'Moveis Alfa') $(tem '(37) 99999-0001') $(tem 'VERNIZ PU BRILHANTE 3,6L') $(tem 'último preço R$ 1.234,50') $(tem 'comprava a cada 30 dias, última há 45 dias') $(tem 'Ofereça também: Seladoras') $(tem 'https://steu.lovable.app/meu-dia/abrir/')" "sim sim sim sim sim sim sim"
eq "R1e texto: controle ausente, sem custo, + itens na ficha, Bom dia Regina, sem cadastro nao zera" "$(tem 'Controle Beta') $(tem 'custo') $(tem '+ 1 outro item na ficha') $(tem 'Bom dia, Regina!') $(tem 'Cliente sem nome no cadastro')" "nao nao sim sim sim"
eq "R1f copia ao master, tokens proprios" "$(Pq -c "SELECT count(*) || ' ' || count(DISTINCT destinatario_user_id) FROM public.venda_resumo_envio WHERE farmer_user_id = '$F1'") $(Pq -c "SELECT count(*) FROM public.venda_resumo_link a JOIN public.venda_resumo_link b ON a.token = b.token AND a.envio_id <> b.envio_id")" "2 2 0"
eq "R1g itens gravados nos dois bracos (o que o e-mail mostra)" "$(Pq -c "SELECT count(DISTINCT x.id) FROM public.venda_resumo_item i JOIN public.venda_resumo_selecao x ON x.id = i.selecao_id WHERE x.farmer_user_id = '$F1'") $(Pq -c "SELECT count(*) FROM public.venda_resumo_item i JOIN public.venda_resumo_selecao x ON x.id = i.selecao_id WHERE x.comprador_id = '${TRAT[0]}'")" "8 4"
eq "R1h F2 sem lista → pulada sem_oportunidades" "$(printf '%s' "$OUT" | python3 -I -c "import json,sys; j=json.load(sys.stdin); print(sorted({p['motivo'] for p in j['pulados']}))")" "['sem_oportunidades']"
OUT2="$(Pq -c "SELECT public.venda_resumo_preparar('$D')::text")"
eq "R1i idempotente: 2a rodada nao envia nem re-seleciona" "$(printf '%s' "$OUT2" | python3 -I -c "import json,sys; j=json.load(sys.stdin); print(len(j['enviados']))") $(Pq -c "SELECT count(*) FROM public.venda_resumo_selecao") $(Pq -c "SELECT count(*) FROM public.fornecedor_alerta")" "0 8 2"
P -q -c "UPDATE public.fornecedor_alerta SET status = 'falha_notificacao' WHERE id = (SELECT alerta_id FROM public.venda_resumo_envio WHERE tipo = 'farmer' AND farmer_user_id = '$F1')"
P -q -c "SELECT public.venda_resumo_preparar('$D')" > /dev/null
eq "R1j falha → tentativa 2 so da farmer" "$(Pq -c "SELECT string_agg(tipo || tentativa, ' ' ORDER BY tipo, tentativa) FROM public.venda_resumo_envio")" "copia1 farmer1 farmer2"
P -q -c "INSERT INTO public.venda_gerador_execucao (dia_referencia, fase, linhas) VALUES ('$HOJE', 'ativa', 1)"
P -q -c "SELECT public.venda_resumo_preparar('$HOJE', '$M')" > /dev/null
eq "R1k teste: antes do inicio, sem selecao nova, tipo teste" "$(Pq -c "SELECT count(*) FROM public.venda_resumo_envio WHERE tipo = 'teste' AND dia = '$HOJE'") $(Pq -c "SELECT count(*) FROM public.venda_resumo_selecao")" "1 8"
eq "R1l acoes_execucoes registra cada rodada" "$(Pq -c "SELECT count(*) FILTER (WHERE status = 'sucesso') || ' ' || count(*) FILTER (WHERE status = 'erro') FROM public.acoes_execucoes WHERE acao = 'venda.resumo_email'")" "4 3"

# ── C1: clique ──────────────────────────────────────────────────────────────────────────────────────────────────
ENV_F="$(Pq -c "SELECT id FROM public.venda_resumo_envio WHERE tipo = 'farmer' AND tentativa = 2")"
ENV_C="$(Pq -c "SELECT id FROM public.venda_resumo_envio WHERE tipo = 'copia'")"
TOK_F="$(Pq -c "SELECT token FROM public.venda_resumo_link WHERE envio_id = '$ENV_F' AND comprador_id = '${TRAT[0]}'")"
TOK_F2="$(Pq -c "SELECT token FROM public.venda_resumo_link WHERE envio_id = '$ENV_F' AND comprador_id = '${TRAT[1]}'")"
TOK_C="$(Pq -c "SELECT token FROM public.venda_resumo_link WHERE envio_id = '$ENV_C' AND comprador_id = '${TRAT[1]}'")"
abrir() { Pq -c "$(como "$1" "SELECT (r->>'comprador_id') || ' ' || (r->>'do_destinatario') || ' ' || (r->>'registrado') || ' ' || (r->>'mostradas') FROM public.venda_resumo_abrir('$2') r")"; }
eq "C1a farmer abre o seu link: grava e marca os 4 itens mostrados" "$(abrir "$F1" "$TOK_F")" "${TRAT[0]} true true 4"
eq "C1b 2o clique nao regrava" "$(abrir "$F1" "$TOK_F")" "${TRAT[0]} true false 0"
eq "C1c master no link da farmer: nao grava" "$(abrir "$M" "$TOK_F2") $(Pq -c "SELECT clicado_em IS NULL FROM public.venda_resumo_link WHERE token = '$TOK_F2'")" "${TRAT[1]} false false 0 t"
eq "C1d mostrada so nos itens do e-mail" "$(Pq -c "SELECT count(*) FROM public.venda_sugestao WHERE mostrada_em IS NOT NULL")" "4"
eq "C1e founder na copia grava sem marcar mostrada" "$(abrir "$M" "$TOK_C") $(Pq -c "SELECT count(*) FROM public.venda_sugestao WHERE mostrada_em IS NOT NULL")" "${TRAT[1]} true true 0 4"
eq "C1f customer → 42501" "$(estado "$(como "$CUST" "SELECT public.venda_resumo_abrir('$TOK_F')")")" "42501"
eq "C1g token desconhecido → NULL" "$(Pq -c "$(como "$F1" "SELECT coalesce(public.venda_resumo_abrir(gen_random_uuid())::text, 'NULL')")")" "NULL"

# ── A1: abertura (pixel) ────────────────────────────────────────────────────────────────────────────────────────
TOKA="$(Pq -c "SELECT token_abertura FROM public.venda_resumo_envio WHERE id = '$ENV_F'")"
eq "A1a 1a abertura true, 2a false" "$(Pq -c "SELECT public.venda_resumo_registrar_abertura('$TOKA')") $(Pq -c "SELECT public.venda_resumo_registrar_abertura('$TOKA')")" "t f"
eq "A1b authenticated nao executa a abertura" "$(estado "$(como "$F1" "SELECT public.venda_resumo_registrar_abertura('$TOKA')")")" "42501"
eq "A1c anon nao executa o preparo" "$(estado "SET ROLE anon; SELECT public.venda_resumo_preparar('$D')")" "42501"

# ── P1: painel do sensor ────────────────────────────────────────────────────────────────────────────────────────
P -q <<SQL
UPDATE public.fornecedor_alerta SET status = 'notificado', email_enviado_em = now() - interval '1 hour'
 WHERE id = (SELECT alerta_id FROM public.venda_resumo_envio WHERE id = '$ENV_F');
-- vai_pedir DEPOIS do envio (oferta); nao_atendeu depois (tentativa); sem_interesse ANTES do envio (não conta)
INSERT INTO public.venda_contato (farmer_user_id, comprador_id, dia, resultado, criado_em, atualizado_em) VALUES
  ('$F1', '${TRAT[0]}', '$D', 'vai_pedir', now(), now()),
  ('$F1', '${TRAT[1]}', '$D', 'nao_atendeu', now(), now()),
  ('$F1', '${TRAT[2]}', '$D', 'sem_interesse', now() - interval '3 hours', now() - interval '3 hours');
SQL
PAINEL="$(Pq -c "$(como "$M" "SELECT public.venda_resumo_painel('$D', '$D')::text")")"
pj() { printf '%s' "$PAINEL" | python3 -I -c "import json,sys; j=json.load(sys.stdin); print($1)"; }
eq "P1a dia: entregues/clicadas" "$(pj "j['dias'][0]['entregues'], j['dias'][0]['clicadas']")" "5 1"
eq "P1b dia: acesso validado pelo clique" "$(pj "j['dias'][0]['acesso_validado']")" "True"
eq "P1c contato ANTES do envio nao conta (tentativas)" "$(pj "j['dias'][0]['tentativas']")" "2"
eq "P1d nao_atendeu e tentativa, nao oferta" "$(pj "j['dias'][0]['ofertadas']")" "1"
eq "P1e farmer: medindo (< 10 dias), taxa 1/5" "$(pj "[(f['status'], f['taxa_ofertada']) for f in j['farmers'] if f['farmer_user_id']=='$F1'][0]")" "('medindo', 0.2)"
eq "P1f master-only" "$(estado "$(como "$F1" "SELECT public.venda_resumo_painel('$D', '$D')")")" "42501"
# efeito: fecha os desfechos do dia — 1 tratamento virou, controle nenhum; um controle nao_medivel
P -q <<SQL
UPDATE public.venda_sugestao SET desfecho = 'nao_virou', avaliado_em = now() WHERE dia_referencia = '$D' AND tipo = 'recompra';
UPDATE public.venda_sugestao SET desfecho = 'virou_pedido', sales_order_id = gen_random_uuid()
 WHERE dia_referencia = '$D' AND comprador_id = '${TRAT[0]}' AND omie_codigo_produto = 101;
UPDATE public.venda_sugestao SET desfecho = 'nao_medivel', desfecho_motivo = 'sync_atrasado'
 WHERE dia_referencia = '$D' AND comprador_id = '${CTRL[0]}' AND omie_codigo_produto = 101;
SQL
PAINEL="$(Pq -c "$(como "$M" "SELECT public.venda_resumo_painel('$D', '$D')::text")")"
eq "P1g efeito tratamento: 5 maduros, 1 converteu" "$(pj "j['efeito']['tratamento']['maduros'], j['efeito']['tratamento']['converteram'], j['efeito']['tratamento']['taxa']")" "5 1 0.2"
eq "P1h efeito controle: nao_medivel fora da taxa" "$(pj "j['efeito']['controle']['maduros'], j['efeito']['controle']['nao_medivel'], j['efeito']['controle']['taxa']")" "3 1 0.0"
eq "P1i A/A historico por braco tem os dois" "$(pj "sorted(j['aa_historico'].keys())")" "['controle', 'tratamento']"
# contato atribuído a UMA oportunidade: TRAT[4] entregue em D (sem contato em D) e em D+1 (útil); o contato de D+1
# cai na janela das duas — conta só na de D+1 (sem a régua, D contaria 2)
D1="$(Pq -c "SELECT private.venda_prox_dia_util('$D')")"
P -q <<SQL
INSERT INTO public.venda_gerador_execucao (dia_referencia, fase, linhas) VALUES ('$D1', 'ativa', 1);
INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, valor_ref, motivo_entrada)
VALUES ('recompra', 'ativa', '$D1', '$F1', '${TRAT[4]}', 'oben', 400, 100, 'maior atraso da carteira');
SQL
P -q -c "SELECT public.venda_resumo_preparar('$D1')" > /dev/null
P -q <<SQL
UPDATE public.fornecedor_alerta SET status = 'notificado', email_enviado_em = now() - interval '1 hour'
 WHERE id = (SELECT alerta_id FROM public.venda_resumo_envio WHERE tipo = 'farmer' AND dia = '$D1');
INSERT INTO public.venda_contato (farmer_user_id, comprador_id, dia, resultado) VALUES ('$F1', '${TRAT[4]}', '$D1', 'vendeu');
SQL
PAINEL="$(Pq -c "$(como "$M" "SELECT public.venda_resumo_painel('$D', '$D1')::text")")"
eq "P1j contato em D+1 conta so na oportunidade de D+1" "$(pj "sorted((d['dia'], d['ofertadas']) for d in j['dias'])")" "[('$D', 1), ('$D1', 1)]"

# ── V1: venda_painel ────────────────────────────────────────────────────────────────────────────────────────────
# Oráculo: o corpo de prod renomeado (venda_painel_v0), nos MESMOS dados. Sem controle no período = byte a byte.
eq "V1a sem controle no periodo: JSON identico ao predecessor" "$(Pq -c "$(como "$M" "SELECT public.venda_painel(DATE '2026-01-05', DATE '2026-01-11')::text = public.venda_painel_v0(DATE '2026-01-05', DATE '2026-01-11')::text")")" "t"
NA_LISTA="$(Pq -c "$(como "$M" "SELECT public.venda_painel('$D', '$D')::text")" | python3 -I -c "import json,sys; j=json.load(sys.stdin); print(sum(l.get('na_lista') or 0 for l in j['linhas'] if l['farmer_user_id']=='$F1'))")"
ESPERADO_V1B="$(Pq -c "SELECT count(DISTINCT comprador_id) FROM public.venda_sugestao WHERE fase = 'ativa' AND farmer_user_id = '$F1' AND braco IS DISTINCT FROM 'controle' AND dia_referencia >= date_trunc('week', DATE '$D') AND dia_referencia < date_trunc('week', DATE '$D') + interval '7 days'")"
COM_CONTROLE="$(Pq -c "SELECT count(DISTINCT comprador_id) FROM public.venda_sugestao WHERE fase = 'ativa' AND farmer_user_id = '$F1' AND dia_referencia >= date_trunc('week', DATE '$D') AND dia_referencia < date_trunc('week', DATE '$D') + interval '7 days'")"
eq "V1b na_lista exclui o controle" "$NA_LISTA $([ "$COM_CONTROLE" -gt "$ESPERADO_V1B" ] && echo menor)" "$ESPERADO_V1B menor"

# ── M1: re-apply, PRE, ACL ──────────────────────────────────────────────────────────────────────────────────────
eq "M1a re-apply idempotente" "$(estado "$(cat "$MIG_USADA")")" "verde"
eq "M1b re-apply nao re-sorteia" "$(Pq -c "SELECT count(*) FROM public.venda_braco_sorteio") $(Pq -c "SELECT count(*) FROM public.venda_braco_comprador WHERE origem = 'sorteio_inicial'")" "1 600"
P -q -c "CREATE OR REPLACE FUNCTION public.venda_painel(p_de date, p_ate date) RETURNS jsonb LANGUAGE sql STABLE AS \$\$ SELECT '{}'::jsonb \$\$"
SAIDA_M1C="$(P -q -f "$MIG_USADA" 2>&1 || true)"
eq "M1c PRE recusa corpo alheio" "$(printf '%s' "$SAIDA_M1C" | grep -c 'PRE FALHOU: public.venda_painel')" "1"
eq "M1d anon nao le as tabelas novas" "$(estado "SET ROLE anon; SELECT 1 FROM public.venda_resumo_envio LIMIT 1")" "42501"
eq "M1e farmer nao le a tabela de bracos (RLS)" "$(Pq -c "$(como "$F1" "SELECT count(*) FROM public.venda_braco_comprador")")" "0"

FAIL=$((FAIL + FAIL_APPLY))
TERMINOU=1
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-resumo-email"
