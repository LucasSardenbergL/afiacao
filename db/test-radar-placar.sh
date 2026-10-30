#!/usr/bin/env bash
# Prova PG17 da frente 3 do Radar (score e placar): migrations 20261029150000 (versão da fórmula gravada com o
# score) e 20261029150100 (ledger radar_eventos, nota no registro do contato, coortes de controle e placar).
# Aplica v1 → v2 → v3 do score como em prod, depois as duas; executa os escritores REAIS de radar_contatos
# (registrar_contato_radar e desfazer_contato_radar, corpos do repo = prod) sob SET ROLE authenticated + GUC de JWT,
# o finalize do lote como INSERT em massa de sessão limpa (UUID de sistema), o cadastro como o UPDATE + INSERT da
# RPC, e a abertura como o INSERT do outbox. Os default privileges de public imitam prod (anon/authenticated com
# tudo), para os REVOKE terem o que revogar.
#
#   bash db/test-radar-placar.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-placar.sh   # tem de ficar VERMELHA
#   bash db/test-radar-placar.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGS="$REPO_ROOT/supabase/migrations"
MIG_S1="$MIGS/20261019180000_radar_score_lead.sql"
MIG_S2="$MIGS/20261020120000_radar_score_lead_v2.sql"
MIG_S3="$MIGS/20261021120000_radar_score_lead_v3_cnae_secundario.sql"
MIG_VER="$MIGS/20261029150000_radar_score_versao.sql"
MIG_EVT="$MIGS/20261029150100_radar_eventos_placar.sql"
MIG_RPC="$MIGS/20261019225545_radar_rpcs_cnpj_alfanumerico.sql"   # corpo de registrar_contato_radar (= prod)
MIG_DESF="$MIGS/20260612130000_radar_rpcs_contato.sql"            # corpo de desfazer_contato_radar (= prod)

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:A3` = a POSTCONDIÇÃO da migration aborta o apply.
  SABOTAGENS="versao_fora_do_update:A1 versao_fora_do_resumo:A2 automatico_grava_nota:A6 confirmacao_mais_recente:A10 conversao_sem_cliente:A5b coorte_sem_cliente_novo:A18b cadastro_fora_da_reconciliacao:A12b backfill_origem_da_sessao:A7 nota_relida_na_conversao:A5 apagado_conta_como_toque:A9 cadastro_vira_toque:A10 outbox_sem_filtro_de_rota:A11 trigger_fail_closed:A12 sorteio_congela_sem_versao:A15 sorteio_nao_deterministico:A16 sorteio_sem_trava:A17 coorte_denominador_por_contato:A18 anon_le_eventos:post:A3 anon_executa_placar:post:A4"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-placar.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde ($(grep -c '^PASS ' "$LOGDIR/controle.log") asserts)"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      post:*) padrao="${a#post:} FALHOU" ;;
      *)      padrao="^FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5497}"
DATA="$(mktemp -d "/tmp/pgtest-radar-placar.XXXXXX")/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
VER_USADA="$(dirname "$DATA")/mig-versao.sql"
EVT_USADA="$(dirname "$DATA")/mig-eventos.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG_VER" "$VER_USADA"
cp "$MIG_EVT" "$EVT_USADA"
sabotar() { # $1 = arquivo, $2 = de, $3 = para (literal)
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para, 1))
PY
}
# Sabotagem no corpo muda o md5: cega a postcondição E a PRE (a 2ª aplicação, de idempotência, cairia nela).
cegar_md5() {
  sabotar "$VER_USADA" "  IF v_md5 IS DISTINCT FROM '" "  IF false AND v_md5 IS DISTINCT FROM '"
  sabotar "$VER_USADA" "  IF v_vivo IS NULL OR v_vivo NOT IN (" "  IF false AND v_vivo NOT IN ("
}
case "${SABOTAGEM:-}" in
  "") ;;
  versao_fora_do_update)
    cegar_md5
    sabotar "$VER_USADA" "       AND (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual)
       -- Guarda" "       AND (c.score_novo, c.motivos_novos) IS DISTINCT FROM (c.score_atual, c.motivos_atuais)
       -- Guarda" ;;
  versao_fora_do_resumo)
    cegar_md5
    sabotar "$VER_USADA" "           'a_alterar', count(*) FILTER (WHERE (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual))," "           'a_alterar', count(*) FILTER (WHERE (c.score_novo, c.motivos_novos) IS DISTINCT FROM (c.score_atual, c.motivos_atuais))," ;;
  automatico_grava_nota)     sabotar "$EVT_USADA" "        INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, fonte_id)
        VALUES ('contato', 'automatica', NEW.created_at, NEW.criado_por, NEW.cnpj, NEW.id, NEW.acao, 'contato:' || NEW.id)" "        INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, nota_capturada, score, fonte_id)
        SELECT 'contato', 'automatica', NEW.created_at, NEW.criado_por, NEW.cnpj, NEW.id, NEW.acao, true, e.score, 'contato:' || NEW.id
          FROM public.radar_empresas e WHERE e.cnpj = NEW.cnpj" ;;
  confirmacao_mais_recente)  sabotar "$EVT_USADA" "(SELECT CASE WHEN bool_or(c.origem = 'incluir') THEN 'incluir' WHEN count(*) > 0 THEN 'lookup' END
              FROM public.omie_cliente_confirmacoes c
             WHERE c.documento = NEW.cnpj AND c.codigo_cliente = NEW.omie_codigo_cliente)" "(SELECT c.origem FROM public.omie_cliente_confirmacoes c WHERE c.documento = NEW.cnpj AND c.codigo_cliente = NEW.omie_codigo_cliente ORDER BY c.confirmado_em DESC, c.id DESC LIMIT 1)" ;;
  conversao_sem_cliente)     sabotar "$EVT_USADA" "         (count(*) FILTER (WHERE l.virou))::integer," "         0::integer," ;;
  coorte_sem_cliente_novo)   sabotar "$EVT_USADA" "         (count(*) FILTER (WHERE p.novo))::integer," "         0::integer," ;;
  cadastro_fora_da_reconciliacao) sabotar "$EVT_USADA" "     AND NOT EXISTS (SELECT 1 FROM public.radar_eventos e WHERE e.fonte_id = 'cadastro:' || re.cnpj);" "     AND false;" ;;
  backfill_origem_da_sessao) sabotar "$EVT_USADA" "SELECT 'contato',
       CASE WHEN c.criado_por = '00000000-0000-0000-0000-00000000ad0f'::uuid THEN 'automatica' ELSE 'humano' END," "SELECT 'contato',
       CASE WHEN auth.uid() IS NULL THEN 'automatica' ELSE 'humano' END," ;;
  nota_relida_na_conversao)  sabotar "$EVT_USADA" "    SELECT DISTINCT ON (v.cnpj) v.cnpj, v.score, v.ocorrido_em" "    SELECT DISTINCT ON (v.cnpj) v.cnpj, (SELECT re.score FROM public.radar_empresas re WHERE re.cnpj = v.cnpj) AS score, v.ocorrido_em" ;;
  apagado_conta_como_toque)  sabotar "$EVT_USADA" "                (e.evento = 'contato' AND EXISTS (SELECT 1 FROM public.radar_contatos c WHERE c.id = e.contato_id)) AS valido" "                (e.evento = 'contato') AS valido" ;;
  cadastro_vira_toque)       sabotar "$EVT_USADA" "         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao IN ('contatado_sem_resposta', 'em_conversa')))::integer," "         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao IN ('contatado_sem_resposta', 'em_conversa', 'virou_cliente')))::integer," ;;
  outbox_sem_filtro_de_rota) sabotar "$EVT_USADA" "  FOR EACH ROW WHEN (NEW.evento = 'navegacao.rota_servida' AND NEW.props ->> 'rota' = '/radar')" "  FOR EACH ROW WHEN (NEW.evento = 'navegacao.rota_servida')" ;;
  trigger_fail_closed)       sabotar "$EVT_USADA" "    RAISE WARNING 'radar_eventos: contato % não registrado" "    RAISE EXCEPTION 'radar_eventos: contato % não registrado" ;;
  sorteio_congela_sem_versao) sabotar "$EVT_USADA" "  IF v_sem_ver > 0 THEN" "  IF false THEN" ;;
  sorteio_nao_deterministico) sabotar "$EVT_USADA" "           ORDER BY md5(v_sorteio || ':' || u.cnpj), u.cnpj" "           ORDER BY md5(clock_timestamp()::text || u.cnpj), u.cnpj" ;;
  sorteio_sem_trava)         sabotar "$EVT_USADA" "  PERFORM pg_advisory_xact_lock(hashtextextended('radar_coorte:' || v_sorteio, 0));" "  PERFORM pg_sleep(0);" ;;
  coorte_denominador_por_contato) sabotar "$EVT_USADA" "  SELECT p.sorteio, p.grupo, count(*)::integer," "  SELECT p.sorteio, p.grupo, (count(*) FILTER (WHERE p.tocado))::integer," ;;
  anon_le_eventos)           sabotar "$EVT_USADA" "REVOKE ALL ON TABLE public.radar_eventos FROM PUBLIC, anon, authenticated, service_role;" "REVOKE ALL ON TABLE public.radar_eventos FROM PUBLIC, service_role;" ;;
  anon_executa_placar)       sabotar "$EVT_USADA" "REVOKE ALL ON FUNCTION public.radar_placar_uso() FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION public.radar_placar_uso() FROM PUBLIC;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privileges de prod (pg_default_acl, psql-ro 2026-10-29): toda tabela/função nova nasce aberta.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE SCHEMA private;
-- Gate de prod hoje em registrar_contato_radar: só o gestor 'aaaa…' passa.
CREATE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT p = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$;
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  cnae_principal text NOT NULL DEFAULT '3101200',
  cnaes_secundarios text[] NOT NULL DEFAULT '{}',
  data_abertura date DEFAULT '2019-03-01',
  porte text DEFAULT '01',
  capital_social numeric DEFAULT 5000,
  municipio_codigo text DEFAULT 'M1',
  uf text DEFAULT 'MG',
  telefone1 text DEFAULT '3733330000', telefone2 text, email text,
  primeira_vista_em timestamptz NOT NULL DEFAULT '2026-06-12 00:00+00',
  ultimo_lote text NOT NULL DEFAULT '2026-10',
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  prospeccao_atualizado_em timestamptz,
  descarte_motivo text,
  omie_codigo_cliente text,
  omie_cadastrado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT '2026-06-15 00:00+00');
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY, status text NOT NULL DEFAULT 'running',
  iniciado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.acoes_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acao text NOT NULL,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','automatica')),
  executado_por uuid, executado_por_nome text,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  status text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando','sucesso','erro')),
  detalhes jsonb);
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL, acao text NOT NULL, nota text,
  criado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status_anterior text);
ALTER TABLE public.radar_contatos ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.analytics_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  evento text NOT NULL, distinct_id text, user_id uuid, props jsonb NOT NULL DEFAULT '{}',
  chave_dedup text UNIQUE, ocorrido_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.omie_cliente_confirmacoes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account text NOT NULL DEFAULT 'oben', documento text NOT NULL, codigo_cliente text NOT NULL,
  origem text NOT NULL CHECK (origem IN ('incluir', 'lookup')),
  confirmado_por uuid, confirmado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v FROM cron.job;
    INSERT INTO cron.job VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
SQL

# Escritores REAIS (corpos do repo, iguais aos de prod): extraídos das migrations, sem a TRAVA/PRE delas.
extrair() { # $1 = arquivo, $2 = início literal, $3 = fim literal
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
p, ini, fim = sys.argv[1:]
s = open(p, encoding="utf-8").read()
a = s.index(ini); b = s.index(fim, a) + len(fim)
print(s[a:b])
PY
}
{
  extrair "$MIG_RPC" "CREATE OR REPLACE FUNCTION public.registrar_contato_radar" "END \$function\$;"
  extrair "$MIG_DESF" "CREATE OR REPLACE FUNCTION public.desfazer_contato_radar" "END \$\$;"
  echo "REVOKE ALL ON FUNCTION public.registrar_contato_radar(text, text, text), public.desfazer_contato_radar(uuid) FROM PUBLIC, anon;"
} > "$(dirname "$DATA")/escritores.sql"
P -q -f "$(dirname "$DATA")/escritores.sql" >/dev/null

# Lotes: 2026-10 vigente. Município M1 com 31 já-clientes (proximidade 20); M9 sem cliente.
Pq -c "INSERT INTO public.radar_ingest_state VALUES ('2026-09','complete','2026-10-21 16:09+00'), ('2026-10','complete','2026-10-27 16:20+00');
INSERT INTO public.radar_empresas (cnpj, ja_cliente) SELECT 'JC' || lpad(g::text, 10, '0') || '01', true FROM generate_series(1, 31) g;
-- Topo: capital alto → >= 70. Faixa 40–69: 60 leads M1 de capital baixo. Fora do universo: sem telefone, M9, descartado.
INSERT INTO public.radar_empresas (cnpj, capital_social, porte) SELECT 'TP' || lpad(g::text, 10, '0') || '01', 2000000, '05' FROM generate_series(1, 5) g;
INSERT INTO public.radar_empresas (cnpj) SELECT 'MD' || lpad(g::text, 10, '0') || '01' FROM generate_series(1, 60) g;
INSERT INTO public.radar_empresas (cnpj, telefone1) VALUES ('SEMTEL00000101', NULL);
INSERT INTO public.radar_empresas (cnpj, municipio_codigo) VALUES ('LONGE000000101', 'M9');
INSERT INTO public.radar_empresas (cnpj, prospeccao_status) VALUES ('DESC0000000101', 'descartado');
-- O lead do contato: capital 10 mil → 68 (abaixo de 70); depois sobe para 1 mi e porte demais → 87.
INSERT INTO public.radar_empresas (cnpj, capital_social) VALUES ('BORDA000000101', 10000);" >/dev/null

# Contatos ANTERIORES ao ledger (o backfill os classifica): um humano de junho e dois descartes de sistema.
Pq -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por, created_at) VALUES
  ('MD000000000101', 'em_conversa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-06-15 12:00+00'),
  ('MD000000000201', 'descartado', '00000000-0000-0000-0000-00000000ad0f', '2026-10-21 17:00+00'),
  ('MD000000000301', 'descartado', '00000000-0000-0000-0000-00000000ad0f', '2026-10-21 17:00+00');" >/dev/null

P -q -f "$MIG_S1" >/dev/null
P -q -f "$MIG_S2" >/dev/null
P -q -f "$MIG_S3" >/dev/null
Pq -c "SELECT public.radar_score_recalcular();" >/dev/null    # rodada da v3 (sem versão) — o estado de prod hoje
P -q -f "$VER_USADA" >/dev/null
P -q -f "$VER_USADA" >/dev/null   # idempotente (PRE aceita a própria)
P -q -f "$EVT_USADA" >/dev/null
P -q -f "$EVT_USADA" >/dev/null   # idempotente

# O que radar_registrar_cadastro_omie faz no Radar, na MESMA transação: vínculo + 'virou_cliente' (SECDEF como ela).
P -q <<'SQL'
CREATE FUNCTION public._teste_cadastro(p_cnpj text, p_cod text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE public.radar_empresas SET omie_codigo_cliente = p_cod, omie_cadastrado_em = now(),
         prospeccao_status = 'virou_cliente', ja_cliente = true, updated_at = now()
   WHERE cnpj = p_cnpj;
  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por)
  VALUES (p_cnpj, 'virou_cliente', 'Cadastrado no Omie/Oben (cód. ' || p_cod || ')', auth.uid());
END $$;
SQL

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
GESTOR='{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}'
como() { # $1 = claims, $2 = SQL — roda como o PostgREST (SET ROLE authenticated + GUC)
  P -qAt <<SQL 2>&1 || true
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '$1', false) \\g /dev/null
$2
SQL
}
placar() { Pq -c "SELECT $1 FROM public.radar_placar_uso() WHERE janela = '${2:-total}';"; }

# shellcheck disable=SC2016  # '$function$' é literal do SQL, lido pelo Python
eq "A0 corpo vivo do recálculo = o do arquivo aplicado" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.radar_score_recalcular()');")" \
   "$(python3 -I -c 'import sys,hashlib;s=open(sys.argv[1],encoding="utf-8").read();a=s.index("AS $function$")+13;print(hashlib.md5(s[a:s.index("$function$;",a)].encode()).hexdigest())' "$VER_USADA")"

# ── Coorte ANTES da rodada com versão: recusa (não congela a ausência) ──
SAIDA15="$(Pq -c "SELECT public.radar_coorte_sortear(5);" 2>&1 || true)"
case "$SAIDA15" in *"score sem versão"*) M15="recusou";; *) M15="aceitou";; esac
eq "A15 sorteio recusa enquanto a nota elegível não tem versão (55000)" \
   "$M15 $(Pq -c "SELECT count(*) FROM public.radar_coorte_controle;")" "recusou 0"

R1="$(Pq -c "SELECT public.radar_score_recalcular();")"
eq "A1 a 1ª rodada com versão grava 'v3' em toda linha com score e NULL onde não há score" \
   "$(Pq -c "SELECT count(*) FILTER (WHERE score IS NOT NULL AND score_versao IS DISTINCT FROM 'v3')::text || '/' || count(*) FILTER (WHERE score IS NULL AND score_versao IS NOT NULL)::text || '/' || count(*) FILTER (WHERE score_versao = 'v3')::text FROM public.radar_empresas;")" \
   "0/0/69"
eq "A2 resumo coerente: a_alterar = alterados, pulados 0, versao_formula v3; 2ª rodada 0 alterados" \
   "$(Pq -c "SELECT (\$j\$$R1\$j\$::jsonb ->> 'a_alterar') || '=' || (\$j\$$R1\$j\$::jsonb ->> 'alterados') || ' p' || (\$j\$$R1\$j\$::jsonb ->> 'pulados') || ' ' || (\$j\$$R1\$j\$::jsonb ->> 'versao_formula');") $(Pq -c "SELECT public.radar_score_recalcular() ->> 'alterados';")" \
   "69=69 p0 v3 0"

# ── Contato humano pela RPC real ──
SCORE_ANTES="$(Pq -c "SELECT score FROM public.radar_empresas WHERE cnpj='BORDA000000101';")"
como "$GESTOR" "SELECT public.registrar_contato_radar('BORDA000000101', 'contatado_sem_resposta');" >/dev/null
eq "A4 contato humano: origem humano, titular, nota e versão da linha capturadas" \
   "$(Pq -c "SELECT origem||' '||user_id||' '||nota_capturada||' '||score||' '||score_versao||' '||(score_em IS NOT NULL) FROM public.radar_eventos WHERE evento='contato' AND cnpj='BORDA000000101';")" \
   "humano aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa true $SCORE_ANTES v3 true"

# A nota do lead SOBE depois (capital 1 mi) e o cron recalcula: o evento guarda a do registro.
Pq -c "UPDATE public.radar_empresas SET capital_social = 1000000, porte = '05' WHERE cnpj='BORDA000000101';" >/dev/null
Pq -c "SELECT public.radar_score_recalcular();" >/dev/null
como "$GESTOR" "SELECT public.registrar_contato_radar('BORDA000000101', 'em_conversa');" >/dev/null
eq "A5 nota congelada no 1º toque: linha foi de <70 a >=70, a conversão fica na faixa do toque" \
   "$(Pq -c "SELECT (score < 70)::text FROM public.radar_eventos WHERE fonte_id = (SELECT 'contato:'||id FROM public.radar_contatos WHERE cnpj='BORDA000000101' AND acao='contatado_sem_resposta');")/$(Pq -c "SELECT (score >= 70)::text FROM public.radar_empresas WHERE cnpj='BORDA000000101';")/$(Pq -c "SELECT faixa||':'||leads_tocados||':'||em_conversa FROM public.radar_conversao_por_faixa() WHERE leads_tocados > 0;")" \
   "true/true/40-69:1:1"

# ── Finalize do lote: INSERT em massa de sessão limpa, UUID de sistema ──
Pq -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por) SELECT 'MD' || lpad(g::text, 10, '0') || '01', 'descartado', '00000000-0000-0000-0000-00000000ad0f' FROM generate_series(40, 49) g;" >/dev/null
eq "A6 contato automático: origem automatica, SEM leitura de nota (caminho barato)" \
   "$(Pq -c "SELECT count(*) FILTER (WHERE origem='automatica' AND NOT nota_capturada AND score IS NULL AND NOT retroativo) FROM public.radar_eventos WHERE evento='contato' AND origem='automatica' AND NOT retroativo;")" "10"

eq "A7 backfill: origem pela linha histórica (humano de junho continua humano), retroativo, sem nota" \
   "$(Pq -c "SELECT string_agg(acao||':'||origem||':'||retroativo||':'||nota_capturada, ' ' ORDER BY acao, origem) FROM public.radar_eventos WHERE retroativo;")" \
   "descartado:automatica:true:false descartado:automatica:true:false em_conversa:humano:true:false"

# ── Desfazer pela RPC real ──
ID8="$(como "$GESTOR" "SELECT public.registrar_contato_radar('MD000000000501', 'em_conversa') ->> 'id';" | tail -1)"
como "$GESTOR" "SELECT public.desfazer_contato_radar('$ID8');" >/dev/null
eq "A8 desfazer gera contato_desfeito humano depois do contato, e o desfeito não conta como toque (3 = 2 de BORDA + o retroativo de junho)" \
   "$(Pq -c "SELECT d.origem||' '||(d.ocorrido_em >= c.ocorrido_em) FROM public.radar_eventos d JOIN public.radar_eventos c ON c.contato_id = d.contato_id AND c.evento='contato' WHERE d.evento='contato_desfeito' AND d.contato_id='$ID8';") $(placar toques)/$(placar desfeitos)" \
   "humano true 3/1"

# DELETE que o ledger NÃO capturou (trigger desligado): o contato apagado não pode seguir contando.
ID9="$(como "$GESTOR" "SELECT public.registrar_contato_radar('MD000000000601', 'contatado_sem_resposta') ->> 'id';" | tail -1)"
Pq -c "ALTER TABLE public.radar_contatos DISABLE TRIGGER trg_radar_evento_contato_del; DELETE FROM public.radar_contatos WHERE id = '$ID9'; ALTER TABLE public.radar_contatos ENABLE TRIGGER trg_radar_evento_contato_del;" >/dev/null
eq "A9 contato apagado sem evento de desfazer: fora dos toques e exposto na reconciliação" \
   "$(placar toques)/$(placar apagados_sem_desfeito)" "3/1"

# ── Cadastro no Omie: o UPDATE + INSERT da RPC, um cliente novo e um que já existia ──
# 701: IncluirCliente e depois a retentativa que só achou o cliente ('lookup') — continua cliente NOVO (bool_or da RPC).
Pq -c "INSERT INTO public.omie_cliente_confirmacoes (documento, codigo_cliente, origem) VALUES ('MD000000000701', '701', 'incluir'), ('MD000000000701', '701', 'lookup'), ('MD000000000801', '801', 'lookup');" >/dev/null
for c in 701 801; do
  como "$GESTOR" "SELECT public._teste_cadastro('MD000000000${c}', '$c');" >/dev/null
done
eq "A10 cadastro: humano, novo × vínculo distinguidos (incluir→lookup segue novo), e o 'virou_cliente' do cadastro não vira toque" \
   "$(placar cadastraram)/$(placar cadastros_novos)/$(placar vinculos_existentes)/$(placar toques)" "1/1/1/3"

# O lead tocado em A4/A5 vira cliente NOVO depois do toque: a conversão conta na faixa da nota do toque.
Pq -c "INSERT INTO public.omie_cliente_confirmacoes (documento, codigo_cliente, origem) VALUES ('BORDA000000101', '1011', 'incluir');" >/dev/null
como "$GESTOR" "SELECT public._teste_cadastro('BORDA000000101', '1011');" >/dev/null
eq "A5b conversão por faixa conta o cliente novo depois do toque (faixa:tocados:conversa:cliente:novo)" \
   "$(Pq -c "SELECT string_agg(faixa||':'||leads_tocados||':'||em_conversa||':'||virou_cliente||':'||cadastros_novos, ' ') FROM public.radar_conversao_por_faixa() WHERE leads_tocados > 0;")" \
   "40-69:1:1:1:1"

# ── Abertura: outbox ──
Pq -c "INSERT INTO public.analytics_outbox (evento, user_id, props, chave_dedup) VALUES
  ('navegacao.rota_servida', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{\"rota\":\"/radar\"}', 'a1'),
  ('navegacao.rota_servida', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '{\"rota\":\"/radar\"}', 'a2'),
  ('navegacao.rota_servida', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{\"rota\":\"/\"}', 'a3'),
  ('dashboard.crescimento_comparavel_servido', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{\"rota\":\"/radar\"}', 'a4');" >/dev/null
eq "A11 só a rota /radar servida vira 'abriu'; 2 titulares, 2 aberturas, reconciliação zerada; janela de 7d PARCIAL (ledger acabou de nascer)" \
   "$(placar abriram 7d)/$(placar aberturas 7d)/$(placar aberturas_outbox_sem_evento)/$(placar aberturas_janela_completa 7d)/$(placar "(aberturas_cobertas_desde IS NOT NULL)")" "2/2/0/f/t"

# ── Fail-open: o ledger recusa e o contato passa mesmo assim ──
Pq -c "ALTER TABLE public.radar_eventos ADD CONSTRAINT trava_teste CHECK (evento <> 'contato') NOT VALID;" >/dev/null
S12="$(como "$GESTOR" "SELECT (public.registrar_contato_radar('MD000000000901', 'contatado_sem_resposta') ->> 'deduped');" | tail -1)"
Pq -c "ALTER TABLE public.radar_eventos DROP CONSTRAINT trava_teste;" >/dev/null
eq "A12 falha do ledger não derruba o contato, e a perda aparece em contatos_sem_evento" \
   "$S12/$(Pq -c "SELECT count(*) FROM public.radar_contatos WHERE cnpj='MD000000000901';")/$(placar contatos_sem_evento)" "false/1/1"

Pq -c "ALTER TABLE public.radar_eventos ADD CONSTRAINT trava_teste CHECK (evento <> 'cadastrou') NOT VALID;" >/dev/null
como "$GESTOR" "SELECT public._teste_cadastro('MD000000001101', '1101');" >/dev/null
Pq -c "ALTER TABLE public.radar_eventos DROP CONSTRAINT trava_teste;" >/dev/null
eq "A12b cadastro cujo evento falhou: o vínculo fica e a perda aparece em cadastros_sem_evento" \
   "$(Pq -c "SELECT (omie_cadastrado_em IS NOT NULL)::text FROM public.radar_empresas WHERE cnpj='MD000000001101';")/$(placar cadastros_sem_evento)" "true/1"

# ── Autorizados: capability da frente 2 resolvida tarde ──
eq "A13a sem a capability: autorizados NULL com motivo (nunca 0)" \
   "$(Pq -c "SELECT coalesce(autorizados_agora::text,'(null)')||' '||autorizados_motivo FROM public.radar_placar_uso() WHERE janela='total';")" \
   "(null) private.cap_radar_prospectar(uuid) ausente"
Pq -c "INSERT INTO public.user_roles VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','master'), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','employee'), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','customer'), ('dddddddd-dddd-dddd-dddd-dddddddddddd','customer');
CREATE FUNCTION private.cap_radar_prospectar(p uuid) RETURNS boolean LANGUAGE sql STABLE AS \$\$ SELECT p IN ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') \$\$;" >/dev/null
eq "A13b com a capability: autorizados = usuários distintos que passam" \
   "$(Pq -c "SELECT autorizados_agora::text||' '||coalesce(autorizados_motivo,'-') FROM public.radar_placar_uso() WHERE janela='total';")" "2 -"

eq "A14 placar separa humano de automático: 1 titular tocou; 12 eventos automáticos (2 retroativos + 10 do finalize)" \
   "$(placar tocaram)/$(placar eventos_automaticos)" "1/12"

# ── Coortes ──
COORTE="$(Pq -c "SELECT public.radar_coorte_sortear(5);")"
ESPERADA="$(Pq -c "WITH u AS (SELECT e.cnpj FROM public.radar_empresas e WHERE e.ultimo_lote='2026-10' AND NOT e.ja_cliente AND e.prospeccao_status='a_contatar' AND e.score BETWEEN 40 AND 69 AND (e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL) AND e.municipio_codigo IN (SELECT municipio_codigo FROM public.radar_empresas WHERE ja_cliente)) SELECT string_agg(cnpj, ',' ORDER BY md5('coorte-2026-10:'||cnpj), cnpj) FROM (SELECT cnpj FROM u ORDER BY md5('coorte-2026-10:'||cnpj), cnpj LIMIT 5) s;")"
eq "A16 amostra = os 5 primeiros por md5(sorteio:cnpj), calculados por fora; topo = todos os >= 70 do universo" \
   "$(Pq -c "SELECT string_agg(cnpj, ',' ORDER BY posicao) FROM public.radar_coorte_controle WHERE grupo='amostra';")|$(Pq -c "SELECT count(*) FROM public.radar_coorte_controle WHERE grupo='topo';")" \
   "$ESPERADA|$(Pq -c "SELECT count(*) FROM public.radar_empresas e WHERE NOT e.ja_cliente AND e.prospeccao_status='a_contatar' AND e.score >= 70 AND e.telefone1 IS NOT NULL AND e.municipio_codigo='M1';")"
eq "A16b re-chamar não re-sorteia" \
   "$(Pq -c "SELECT (\$j\$$COORTE\$j\$::jsonb ->> 'novo') || ' ' || (public.radar_coorte_sortear(5) ->> 'novo');")" "true false"

# Duas PRIMEIRAS chamadas simultâneas (outro lote): uma espera a outra e encontra o registro.
Pq -c "INSERT INTO public.radar_ingest_state VALUES ('2026-11','complete','2026-11-20 16:00+00'); UPDATE public.radar_empresas SET ultimo_lote = '2026-11';" >/dev/null
Pq -c "SELECT public.radar_score_recalcular();" >/dev/null
( P -qAt -c "BEGIN; SELECT public.radar_coorte_sortear(5); SELECT pg_sleep(1.5); COMMIT;" > "$(dirname "$DATA")/s1.out" 2>&1 ) &
sleep 0.4
S17="$(Pq -c "SELECT public.radar_coorte_sortear(5) ->> 'novo';" 2>&1 || true)"
wait
eq "A17 sorteio concorrente: a 2ª chamada vê o 1º registro (novo=false), um só conjunto" \
   "$S17/$(Pq -c "SELECT count(*) FROM public.radar_coorte_controle WHERE sorteio='coorte-2026-11' AND grupo='amostra';")" "false/5"

# Toque DEPOIS do sorteio num lead da amostra; os outros 4 seguem no denominador com zero contato.
ALVO="$(Pq -c "SELECT cnpj FROM public.radar_coorte_controle WHERE sorteio='coorte-2026-10' AND grupo='amostra' AND posicao = 1;")"
como "$GESTOR" "SELECT public.registrar_contato_radar('$ALVO', 'em_conversa');" >/dev/null
eq "A18 resultado da coorte começa pelo registro: 5 sorteados, 1 tocado, 1 em conversa" \
   "$(Pq -c "SELECT sorteados||'/'||tocados||'/'||em_conversa FROM public.radar_coorte_resultado() WHERE sorteio='coorte-2026-10' AND grupo='amostra';")" "5/1/1"

Pq -c "INSERT INTO public.omie_cliente_confirmacoes (documento, codigo_cliente, origem) VALUES ('$ALVO', '2001', 'incluir');" >/dev/null
como "$GESTOR" "SELECT public._teste_cadastro('$ALVO', '2001');" >/dev/null
eq "A18b a coorte conta o cliente novo depois do sorteio (sorteados/tocados/conversa/cliente/novo)" \
   "$(Pq -c "SELECT sorteados||'/'||tocados||'/'||em_conversa||'/'||virou_cliente||'/'||cadastros_novos FROM public.radar_coorte_resultado() WHERE sorteio='coorte-2026-10' AND grupo='amostra';")" "5/1/1/1/1"

# ── ACL efetiva ──
eq "A19 nenhum papel de API escreve/trunca as tabelas novas; anon/authenticated não executam as funções" \
   "$(Pq -c "SELECT bool_or(has_table_privilege(r, t, 'INSERT,UPDATE,DELETE,TRUNCATE'))::text || ' ' || bool_or(has_table_privilege(r, t, 'SELECT') AND r <> 'service_role')::text FROM unnest(ARRAY['anon','authenticated','service_role']) r, unnest(ARRAY['public.radar_eventos','public.radar_coorte_controle']) t;") $(Pq -c "SELECT bool_or(has_function_privilege(r, f, 'EXECUTE'))::text FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['public.radar_placar_uso()','public.radar_coorte_resultado()','public.radar_conversao_por_faixa()','public.radar_coorte_sortear(integer)']) f;")" \
   "false false false"
S20="$(como "$GESTOR" "SELECT count(*) FROM public.radar_eventos;" | tail -1)"
case "$S20" in *"permission denied"*|*"42501"*|*"permissão negada"*) M20="negado";; *) M20="LEU:$S20";; esac
eq "A20 o PostgREST (authenticated) não lê o ledger direto" "$M20" "negado"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_PLACAR_PROVA_OK"
[ "$FAIL" -eq 0 ]
