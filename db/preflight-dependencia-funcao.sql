-- preflight-dependencia-funcao.sql — inventário EXAUSTIVO de dependência de uma FUNÇÃO no banco.
--
-- POR QUÊ: irmão do `preflight-dependencia-tabela.sql`, escrito depois do incidente do FU7
-- (#1421→#1423, 2026-07-18). Aquele PR moveu `carteira_visivel_para` de `public` p/ `private`,
-- atualizou as 8 POLICIES que a chamavam — e deixou 4 funções PL/pgSQL apontando p/ o schema
-- antigo. `ALTER FUNCTION … SET SCHEMA` e `CREATE OR REPLACE` NÃO validam o corpo de quem
-- referencia: PL/pgSQL é LATE-BOUND, então tudo PASSA e as 4 só quebraram ao EXECUTAR, com
-- `42883 undefined_function`, em produção (gerar plano tático, registrar resultado pós-call,
-- registrar ligação em rota, proteger master_cpf). O CI não vê; o harness do PR que move a
-- função também não (ele testa a função movida, não quem a chama).
--
-- ⚠️ `pg_depend` NÃO substitui isto. O catálogo registra dependência de trigger/default/
-- constraint/índice, mas NÃO de uma chamada dentro do corpo de outra função — é justamente
-- o que "late-bound" significa. A varredura TEXTUAL é a única que enxerga essa classe.
--
-- Rode ANTES de dropar, renomear, mover de schema ou trocar a assinatura de uma função, e
-- exija ZERO linhas acionáveis. Depois de aplicar, rode DE NOVO e confira o zero.
--
-- USO (read-only, rodo eu mesmo):
--   ~/.config/afiacao/psql-ro -v alvo=carteira_visivel_para -f db/preflight-dependencia-funcao.sql
--
-- ⚠️ WORD-BOUNDARY, nunca `ilike '%nome%'`: `has_role` é substring de `has_role_or_master`,
-- `criar_plano` de `criar_plano_tatico`. `\m`/`\M` casam borda de palavra e `_` conta como
-- caractere de palavra. Mesma lição que inflou 3→6 falsos "bloqueadores" no P0-B-bis.
--
-- ⚠️ `pg_get_functiondef` EXPLODE em agregado ("array_agg is an aggregate function") e aborta
-- a varredura inteira. Por isso todo bloco que o chama exclui `pg_aggregate`. Mordido 2× na
-- própria sessão que escreveu este arquivo.
--
-- COMO LER — a coluna `detalhe` traz o diagnóstico, não só o nome:
--   · `rotina`   → quem CHAMA a função. `detalhe` diz COM QUAL SCHEMA chama e qual o
--                  `search_path` da chamadora. É a classe que o FU7 deixou passar.
--   · `trigger`  → trigger que EXECUTA a função (`tgfoid`); um DROP/rename quebra a tabela inteira.
--   · `policy` / `view` / `constraint` / `default` / `indice` / `cron` → bloqueadores.
--   · `acl`      → quem tem EXECUTE hoje. Ao MOVER de schema, confira que esses roles têm
--                  USAGE no schema de destino — senão o caller acha a função e falha com
--                  `42501` em vez de `42883`: mesmo estrago, sintoma diferente.
--   · `overload` → outras assinaturas do mesmo nome. Mover/dropar UMA não é mover TODAS.

\set alvo_re '\\m' :alvo '\\M'
-- chamada QUALIFICADA por schema: captura qual schema o caller usa (`public.alvo`, `private.alvo`)
\set alvo_qual '([a-zA-Z_][a-zA-Z0-9_]*)[[:space:]]*\\.[[:space:]]*\\m' :alvo '\\M'
-- chamada NÃO-QUALIFICADA: o nome não precedido de ponto ⇒ resolve pelo `search_path` do caller
\set alvo_nu '(^|[^.a-zA-Z0-9_])\\m' :alvo '\\M[[:space:]]*\\('

-- ── 0. O ALVO: onde ele vive hoje, e com quais assinaturas ─────────────────────────────
select 'alvo' as classe,
       n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as objeto,
       'owner=' || pg_get_userbyid(p.proowner)
         || case when p.prosecdef then ' SECDEF' else ' INVOKER' end
         || ' ' || coalesce(array_to_string(p.proconfig, ','), 'search_path=(herda)') as detalhe
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname = :'alvo' and n.nspname not in ('pg_catalog','information_schema')

union all
-- ── 1. ROTINAS que chamam (a classe LATE-BOUND — invisível ao pg_depend e ao CI) ───────
--     `detalhe` diz COMO chama: qualificado por qual schema, ou não-qualificado (e aí o
--     `search_path` da chamadora decide). Mover a função quebra os DOIS casos quando o
--     schema novo não está no caminho — foi exatamente o FU7.
select 'rotina',
       n.nspname || '.' || p.proname,
       case
         when pg_get_functiondef(p.oid) ~ :'alvo_qual'
           then 'chama QUALIFICADO: ' || substring(pg_get_functiondef(p.oid) from :'alvo_qual') || '.' || :'alvo'
         else 'chama NÃO-QUALIFICADO (resolve pelo search_path)'
       end
       || ' | ' || coalesce(array_to_string(p.proconfig, ','), 'search_path=(herda)')
       || case p.prokind when 'p' then ' | procedure' else '' end
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog','information_schema')
  and p.prokind in ('f','p')
  and p.oid not in (select aggfnoid from pg_aggregate)     -- pg_get_functiondef explode em agregado
  and p.proname <> :'alvo'                                  -- não se auto-reportar
  and (pg_get_functiondef(p.oid) ~ :'alvo_qual' or pg_get_functiondef(p.oid) ~ :'alvo_nu')

union all
-- ── 2. TRIGGERS que executam a função (pg_trigger.tgfoid) ──────────────────────────────
select 'trigger', t.tgname || ' on ' || c.relname,
       case when t.tgenabled = 'O' then '[ativo]' else '[' || t.tgenabled::text || ']' end
         || ' — dropar/renomear a função quebra a escrita nesta tabela'
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = p.pronamespace
where not t.tgisinternal and p.proname = :'alvo'
  and n.nspname not in ('pg_catalog','information_schema')

union all
-- ── 3. RLS POLICIES que chamam (USING / WITH CHECK) ────────────────────────────────────
--     ⚠️ Ler USING **e** WITH CHECK: uma policy de INSERT tem `polqual` NULL e a chamada só
--     vive no `polwithcheck`. Olhar só o USING rotula "não-qualificado" uma policy que está
--     qualificada — falso rótulo que convida a consertar o que está são (mordido ao escrever
--     este arquivo: `vag_insert_own_carteira` apareceu como não-qualificada e não era).
select 'policy', pol.polname || ' on ' || c.relname,
       case
         when coalesce(pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ :'alvo_qual'
           then 'QUALIFICADO: ' || substring(coalesce(pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid)) from :'alvo_qual') || '.' || :'alvo'
         else 'não-qualificado'
       end || ' | cmd=' || pol.polcmd::text
         || case when pol.polqual is null then ' (só WITH CHECK)' else '' end
from pg_policy pol join pg_class c on c.oid = pol.polrelid
where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~ :'alvo_re'
   or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ :'alvo_re'

union all
-- ── 4. VIEWS / MATVIEWS que chamam ─────────────────────────────────────────────────────
select 'view', n.nspname || '.' || c.relname,
       case c.relkind when 'v' then 'view' when 'm' then 'matview' end
         || ' | ' || case when pg_get_viewdef(c.oid) ~ :'alvo_qual'
                          then 'QUALIFICADO: ' || substring(pg_get_viewdef(c.oid) from :'alvo_qual') || '.' || :'alvo'
                          else 'não-qualificado' end
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('v','m') and pg_get_viewdef(c.oid) ~ :'alvo_re'

union all
-- ── 5. CRON JOBS com SQL inline (não é pg_proc nem pg_views — classe própria) ──────────
select 'cron', j.jobname, j.schedule || case when j.active then ' [ativo]' else ' [inativo]' end
from cron.job j where j.command ~ :'alvo_re'

union all
-- ── 6. CONSTRAINTS (CHECK) que chamam ──────────────────────────────────────────────────
select 'constraint', con.conname || ' on ' || con.conrelid::regclass::text, pg_get_constraintdef(con.oid)
from pg_constraint con where pg_get_constraintdef(con.oid) ~ :'alvo_re'

union all
-- ── 7. DEFAULTS de coluna que chamam ───────────────────────────────────────────────────
select 'default', c.relname || '.' || a.attname, pg_get_expr(ad.adbin, ad.adrelid)
from pg_attrdef ad join pg_class c on c.oid = ad.adrelid
join pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
where pg_get_expr(ad.adbin, ad.adrelid) ~ :'alvo_re'

union all
-- ── 8. ÍNDICES com expressão que chama ─────────────────────────────────────────────────
select 'indice', i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
from pg_index i where pg_get_indexdef(i.indexrelid) ~ :'alvo_re'

union all
-- ── 9. AGREGADOS / OPERADORES / CASTS construídos sobre a função ───────────────────────
select 'agregado', a.aggfnoid::regproc::text, 'sfunc/finalfunc = ' || :'alvo'
from pg_aggregate a
join pg_proc p on p.oid in (a.aggtransfn, a.aggfinalfn)
where p.proname = :'alvo'
union all
select 'operador', o.oprname || ' (' || o.oprcode::text || ')', 'oprcode = ' || :'alvo'
from pg_operator o join pg_proc p on p.oid = o.oprcode where p.proname = :'alvo'
union all
select 'cast', format_type(c.castsource, null) || ' → ' || format_type(c.casttarget, null), 'castfunc = ' || :'alvo'
from pg_cast c join pg_proc p on p.oid = c.castfunc where p.proname = :'alvo'

union all
-- ── 10. ACL: quem executa hoje. Ao MOVER de schema, esses roles precisam de USAGE no
--        schema de DESTINO — senão o sintoma vira `42501` em vez de `42883`.
select 'acl', n.nspname || '.' || p.proname,
       'EXECUTE: ' || coalesce((
         select string_agg(r.rolname, ', ' order by r.rolname)
         from pg_roles r
         where r.rolname in ('anon','authenticated','service_role','postgres')
           and has_function_privilege(r.rolname, p.oid, 'EXECUTE')), '(ninguém)')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname = :'alvo' and n.nspname not in ('pg_catalog','information_schema')

union all
-- ── 11. OVERLOADS: outras assinaturas do MESMO nome. Mover/dropar UMA não é mover TODAS,
--        e um caller pode estar amarrado justamente à que ficou para trás.
select 'overload', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       'assinatura distinta — confira se o caller usa ESTA'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname = :'alvo' and n.nspname not in ('pg_catalog','information_schema')
  and (select count(*) from pg_proc p2 join pg_namespace n2 on n2.oid = p2.pronamespace
       where p2.proname = :'alvo' and n2.nspname not in ('pg_catalog','information_schema')) > 1

union all
-- ── 12. pg_depend: o que o CATÁLOGO sabe. Complementa, NÃO substitui os blocos textuais —
--        ele não registra chamada dentro de corpo de função (é o que late-bound significa).
select 'pg_depend', coalesce(cl.relname, pr.proname, d.objid::text),
       d.classid::regclass::text || ' deptype=' || d.deptype::text
from pg_depend d
left join pg_class cl on cl.oid = d.objid and d.classid = 'pg_class'::regclass
left join pg_proc pr on pr.oid = d.objid and d.classid = 'pg_proc'::regclass
where d.refobjid in (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where p.proname = :'alvo' and n.nspname not in ('pg_catalog','information_schema'))
  and d.deptype <> 'i'
  and coalesce(pr.proname, '') <> :'alvo'

order by 1, 2;
