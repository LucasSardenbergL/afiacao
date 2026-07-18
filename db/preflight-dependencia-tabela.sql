-- preflight-dependencia-tabela.sql — inventário EXAUSTIVO de dependência de uma tabela NO BANCO.
--
-- POR QUÊ: `grep` no repo NÃO vê função/view criada direto no SQL Editor do Lovable (docs/agent/database.md
-- §3: ~210 objetos existem em prod sem CREATE commitado) — é uma CLASSE INTEIRA fora do inventário. Pior:
-- PL/pgSQL e `LANGUAGE sql` não-ATOMIC são LATE-BOUND, então o `DROP TABLE` PASSA e o objeto só quebra ao
-- EXECUTAR, atrás de cron/try-catch → falha silenciosa por dias. Rode isto ANTES de dropar/renomear tabela
-- ou coluna e exija ZERO linhas acionáveis.
--
-- USO (read-only, rodo eu mesmo):
--   ~/.config/afiacao/psql-ro -v alvo=omie_clientes -f db/preflight-dependencia-tabela.sql
--
-- ⚠️ WORD-BOUNDARY, nunca `ilike '%nome%'`: `omie_clientes` é PREFIXO de `omie_clientes_nao_vinculados`
-- (outra tabela, sobrevivente do DROP). No P0-B-bis o ilike inflou o inventário de 3 para 6 "bloqueadores".
-- `\m`/`\M` casam borda de palavra e `_` conta como caractere de palavra → `\momie_clientes\M` NÃO casa
-- dentro de `omie_clientes_nao_vinculados`.
--
-- COMO LER: classe `rotina`/`view`/`policy`/`cron`/`fk_entrante`/`constraint`/`default`/`indice` = BLOQUEADOR
-- (migre ou aposente antes do DROP). `trigger_no_alvo` e `pg_depend` com objeto DA PRÓPRIA tabela = cai junto
-- no DROP, não bloqueia — mas confirme que o EFEITO do trigger não é necessário depois.

\set alvo_re '\\m' :alvo '\\M'
\set alvo_q '''public.' :alvo ''''

-- 1. ROTINAS: todo prokind (f=função, p=procedure) — late-bound, só o TEXTO acha
select 'rotina' as classe,
       n.nspname || '.' || p.proname as objeto,
       case p.prokind when 'f' then 'function' when 'p' then 'procedure' end as detalhe
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog','information_schema')
  and p.prokind in ('f','p')
  and pg_get_functiondef(p.oid) ~* :'alvo_re'

union all
-- 2. VIEWS / MATVIEWS
select 'view', n.nspname || '.' || c.relname,
       case c.relkind when 'v' then 'view' when 'm' then 'matview' end
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('v','m') and pg_get_viewdef(c.oid) ~* :'alvo_re'

union all
-- 3. RLS POLICIES em OUTRAS tabelas (subquery no USING/WITH CHECK) — invisíveis a pg_proc/pg_views
select 'policy', pol.polname || ' on ' || c.relname, 'RLS'
from pg_policy pol join pg_class c on c.oid = pol.polrelid
where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~* :'alvo_re'
   or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~* :'alvo_re'

union all
-- 4. CRON JOBS com SQL inline (não é pg_proc nem pg_views — classe própria)
select 'cron', j.jobname, j.schedule || case when j.active then ' [ativo]' else ' [inativo]' end
from cron.job j where j.command ~* :'alvo_re'

union all
-- 5. FKs apontando PARA o alvo (o DROP falha sem CASCADE)
select 'fk_entrante', con.conname || ' on ' || con.conrelid::regclass::text, pg_get_constraintdef(con.oid)
from pg_constraint con where con.confrelid = :alvo_q::regclass

union all
-- 6. CONSTRAINTS (CHECK) de outra tabela citando o alvo
select 'constraint', con.conname || ' on ' || con.conrelid::regclass::text, con.contype::text
from pg_constraint con
where con.conrelid <> :alvo_q::regclass and pg_get_constraintdef(con.oid) ~* :'alvo_re'

union all
-- 7. DEFAULTS de coluna citando o alvo
select 'default', c.relname || '.' || a.attname, pg_get_expr(ad.adbin, ad.adrelid)
from pg_attrdef ad join pg_class c on c.oid = ad.adrelid
join pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
where c.oid <> :alvo_q::regclass and pg_get_expr(ad.adbin, ad.adrelid) ~* :'alvo_re'

union all
-- 8. ÍNDICES com expressão citando o alvo
select 'indice', i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
from pg_index i where i.indrelid <> :alvo_q::regclass and pg_get_indexdef(i.indexrelid) ~* :'alvo_re'

union all
-- 9. TRIGGERS anexados AO alvo (caem junto no DROP — confira se o EFEITO ainda é necessário)
select 'trigger_no_alvo', t.tgname, p.proname || '()'
from pg_trigger t join pg_proc p on p.oid = t.tgfoid
where t.tgrelid = :alvo_q::regclass and not t.tgisinternal

union all
-- 10. pg_depend: o que o CATÁLOGO sabe (fonte da verdade do que o DROP reclamaria).
--     deptype='a' com objeto da própria tabela = auto (índice/constraint/policy/default próprios).
select 'pg_depend', coalesce(cl.relname, pr.proname, d.objid::text),
       d.classid::regclass::text || ' deptype=' || d.deptype::text
from pg_depend d
left join pg_class cl on cl.oid = d.objid and d.classid = 'pg_class'::regclass
left join pg_proc pr on pr.oid = d.objid and d.classid = 'pg_proc'::regclass
where d.refobjid = :alvo_q::regclass
  and d.deptype <> 'i'
  and coalesce(cl.relname, '') <> :'alvo'

order by 1, 2;
