# Queries SQL (read-only) — Lovable SQL Editor

Todas são `SELECT`. Rode no **🟣 Lovable → SQL Editor → cola → Run** e cole o resultado de
volta. **Nunca** proponha `INSERT/UPDATE/DELETE` nem `curl`/`psql`/CLI.

> **MODELO DE CARTEIRA = CIDADE (decidido na auditoria 2026-05-23).** A atribuição por vendedor
> do Omie (`omie_clientes.omie_codigo_vendedor`) **está desconectada das vendas reais** — os
> perfis com vendedor não têm CNPJ e não casam (por `user_id` nem por CNPJ) com quem compra em
> `sales_orders`. Tentar usá-la dá carteira vazia. **A carteira de uma Farmer é o conjunto de
> CIDADES que ela atende** (cada Farmer é dona de certas cidades). O plano lista os
> **compradores reais** dessas cidades. Isso usa só dados sólidos e é o modelo operacional real.

> **Status que contam como compra** (auditoria 2026-05-23): `faturado`, `importado` (vendas
> históricas do Omie — essenciais p/ frequência), `separacao` (pedido firme) e `enviado`.
> **Excluir**: `cancelado`, `rascunho`, `orcamento`. Empresa em `sales_orders` é a coluna
> **`account`** (`colacor`/`oben`/`colacor_sc`); há `deleted_at` (soft-delete) → sempre filtre
> `deleted_at is null`. Um cliente pode comprar em mais de um `account` com **perfis (`user_id`)
> diferentes mas o MESMO CNPJ** — por isso consolidamos por CNPJ (`profiles.cnpj`/`document`).

> **Nomes de coluna podem variar.** Se o editor reclamar de uma coluna, **me cole o erro** que
> eu ajusto. Pontos prováveis de ajuste marcados com `-- ⚙️`.

---

## 1. Pré-flight (a condição de valor) — rode SEMPRE primeiro

```sql
-- (1) Histórico de compra real existe e é recente? (gate da condição de valor)
select count(*) as pedidos_total,
       count(distinct customer_user_id) as clientes_com_pedido,
       min(created_at)::date as primeiro_pedido,
       max(created_at)::date as ultimo_pedido,
       count(*) filter (where created_at > now() - interval '90 days') as pedidos_90d
from sales_orders
where status in ('faturado','importado','separacao','enviado') and deleted_at is null;

-- (2) Compradores reais POR CIDADE — é assim que se atribui cidade → Farmer.
with buyers as (
  select distinct so.customer_user_id as uid
  from sales_orders so
  where so.status in ('faturado','importado','separacao','enviado') and so.deleted_at is null
)
select initcap(trim(regexp_replace(a.city,'\s*\([^)]*\)\s*$',''))) as cidade,
       count(distinct b.uid) as compradores
from buyers b
join addresses a on a.user_id = b.uid and a.is_default = true
where coalesce(a.city,'') <> ''
group by 1 order by 2 desc limit 60;

-- (3) Cobertura: quantos compradores têm cidade preenchida? (os sem cidade não roteiam)
with buyers as (
  select distinct so.customer_user_id as uid
  from sales_orders so
  where so.status in ('faturado','importado','separacao','enviado') and so.deleted_at is null
)
select (select count(*) from buyers) as compradores_total,
       count(distinct a.user_id) filter (where coalesce(a.city,'')<>'') as com_cidade
from buyers b left join addresses a on a.user_id = b.uid and a.is_default = true;
```

**Interpretação:**
- **Query 1** vazia/zero → **PARE** (sem dado real, sem plano). Avise o dono.
- **Query 2** lista as cidades onde há compradores reais. É a base pra mapear **Farmer → cidades**
  e pra casar com o calendário de rota (`rotas-cidades.md`). Cidades grandes fora do calendário
  = oportunidade (ver seção de órfãs lá).
- **Query 3**: `com_cidade / compradores_total` é a cobertura roteável. Os sem cidade entram no
  bucket "completar cadastro" do plano (degradação explícita).

> **Atribuição por vendedor / `farmer_client_scores` / `farmer_recommendations`**: todas vivem no
> espaço de `customer_user_id` dos perfis de app (sem CNPJ), **desconectado das vendas**. Não use
> como fonte de carteira nem de cross-sell — derive tudo das vendas + mix por ramo
> (`contexto-industrial.md`). Registre pro time de dados: unificar perfis por CNPJ destravaria o
> enriquecimento por scores.

---

## 2. Carteira por cidade (query principal) — passos 2 e 4

Troque a **lista de cidades** no `in (...)` final pelas cidades da Farmer (ou do dia de rota).
Use as **chaves normalizadas** (minúsculas, sem acento, hífen→espaço): ex. `'sao joao del rei'`,
`'para de minas'`, `'carmo do cajuru'`. Retorna **uma linha por cliente** (consolidado por CNPJ),
com sinais de queda + produtos comprados (a skill classifica em categorias via
`contexto-industrial.md`).

```sql
with pedidos as (
  select so.id, so.customer_user_id, so.created_at::date as data, so.account, so.items,
         coalesce(so.total, (                                  -- ⚙️ ajustar se 'total' não existir
           select sum((it->>'quantity')::numeric * (it->>'unit_price')::numeric)
           from jsonb_array_elements(so.items) it              -- ⚙️ json_array_elements se 'items' for json
         )) as valor
  from sales_orders so
  where so.status in ('faturado','importado','separacao','enviado') and so.deleted_at is null
),
cli as (   -- enriquece cada pedido com CNPJ (chave do cliente) + cidade do comprador
  select ped.*,
         p.name, p.customer_type, p.cnae,
         coalesce(nullif(regexp_replace(coalesce(p.cnpj, p.document, ''), '\D','','g'),''),
                  ped.customer_user_id::text) as cliente_key,
         initcap(trim(regexp_replace(a.city, '\s*\([^)]*\)\s*$',''))) as cidade,
         upper(trim(a.state)) as uf,
         lower(translate(regexp_replace(trim(a.city), '\s*\([^)]*\)\s*$',''),
               'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ-',
               'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC ')) as cidade_key
  from pedidos ped
  join profiles p on p.user_id = ped.customer_user_id     -- ⚙️ ajustar se a PK de profiles for 'id'
  left join addresses a on a.user_id = ped.customer_user_id and a.is_default = true
),
agg as (
  select cliente_key,
         max(name) as cliente, max(customer_type) as customer_type, max(cnae) as cnae,
         (array_agg(cidade     order by data desc) filter (where cidade is not null))[1] as cidade,
         (array_agg(uf         order by data desc) filter (where uf is not null))[1] as uf,
         (array_agg(cidade_key order by data desc) filter (where cidade_key is not null))[1] as cidade_key,
         count(distinct id) as qtd_pedidos,
         min(data) as primeira_compra, max(data) as ultima_compra,
         (current_date - max(data)) as dias_desde_ultima,
         case when count(distinct id) > 1
              then round((max(data)-min(data))::numeric / nullif(count(distinct id)-1,0),0) end as intervalo_medio_dias,
         round(coalesce(sum(valor) filter (where data > current_date-60),0),2) as gasto_60d,
         round(coalesce(sum(valor) filter (where data > current_date-180)/6.0,0),2) as media_mensal_6m,
         round(coalesce(sum(valor),0),2) as gasto_total
  from cli group by cliente_key
),
itens as (   -- produtos comprados (com descrição + família), consolidados por cliente_key (CNPJ)
  select cli.cliente_key,
         coalesce(op.descricao, 'cod '||(it->>'omie_codigo_produto')) as produto,
         op.familia,
         sum((it->>'quantity')::numeric) as qtd
  from cli
  cross join lateral jsonb_array_elements(cli.items) it
  left join omie_products op
    on op.omie_codigo_produto = nullif(regexp_replace(it->>'omie_codigo_produto','\D','','g'),'')::bigint  -- ⚙️ join pelo ID NUMÉRICO do Omie (não por 'codigo')
  group by 1,2,3
),
final as (   -- CTE separada: 'tier_queda' vira coluna real p/ o ORDER BY usar
  select a.cliente, a.customer_type, a.cnae, a.cidade, a.uf,
         a.qtd_pedidos, a.ultima_compra, a.dias_desde_ultima, a.intervalo_medio_dias,
         a.gasto_60d, a.media_mensal_6m, a.gasto_total,
         case
           when a.ultima_compra is null then 'nunca_comprou'
           when a.dias_desde_ultima > 365 then 'dormente'   -- sumido há +1 ano: reativação, NÃO call da semana
           when a.dias_desde_ultima > 2*coalesce(a.intervalo_medio_dias,45)
             or a.dias_desde_ultima > 90 then 'critico'
           when a.dias_desde_ultima > 1.5*coalesce(a.intervalo_medio_dias,45)
             or a.gasto_60d < 0.6*(a.media_mensal_6m*2) then 'alerta'
           else 'em_dia'
         end as tier_queda,
         (select string_agg(distinct left(i.produto,40) || coalesce(' ['||i.familia||']',''), '  |  ')
            from itens i where i.cliente_key = a.cliente_key) as produtos_comprados
  from agg a
  where a.cidade_key in (
    'formiga','pimenta','piumhi','capitolio'  -- ⚙️ TROQUE pelas cidades da Farmer / do dia (chave normalizada)
  )
)
select * from final
order by case tier_queda when 'critico' then 0 when 'alerta' then 1 when 'em_dia' then 2
                         when 'nunca_comprou' then 3 else 4 end,   -- dormente por último (reativação)
         gasto_total desc nulls last;
```

Notas:
- Rode **um dia de rota por vez** (4–6 cidades no `in`) ou a semana inteira da Farmer. Se ficar
  lento, é aceitável — são ~6 mil pedidos.
- **Consolidação por CNPJ** (`cliente_key`): junta os perfis Colacor+Oben do mesmo cliente, então
  o `produtos_comprados` reflete o mix REAL entre as linhas (é onde mora o cross-sell).
- Clientes **sem CNPJ** caem no fallback `user_id` (não consolidam, mas aparecem). Clientes **sem
  cidade** não entram no `in (...)` — trate-os à parte (bucket "completar cadastro").

---

## 3. Unir CNPJs do mesmo cliente (sucessão / multi-empresa) → ver `unificacao-cnpj.md`

O mesmo cliente real às vezes tem **CNPJs diferentes**: encerrou um e abriu outro (**sucessão** —
o histórico tem que seguir) ou fatura por vários ao mesmo tempo (**multi-CNPJ ativo** — não ligar
duas vezes, somar mix/faturamento). É **confirm-first** e tem armadilha séria de métrica (juntar
pedidos de CNPJs paralelos encolhe o intervalo e esconde queda). O design completo — diagnósticos
de detecção (multi-sinal + sucessão comportamental), distinção sucessão×ativo por sobreposição de
tempo, CTE `aliases` com `relation_type`+auto-validação, e quais métricas podem/não podem ser
pooled — está em **`references/unificacao-cnpj.md`**. **Leia esse arquivo antes de unir qualquer
CNPJ.** Até o dono confirmar grupos, o **default por-CNPJ** (1 CNPJ = 1 cliente) é o que roda — é
seguro porque não funde nada.

## Como consumir o resultado

1. **`tier_queda`** já vem calculado (critico/alerta/em_dia/nunca_comprou) — é o sinal de queda.
2. **`produtos_comprados`** é uma string `Descrição [Família]  |  Descrição [Família]`. Use a
   **família** pra classificar a categoria (mapa em `contexto-industrial.md`). O **mix ausente** =
   categorias esperadas do **ramo** (inferido pelo NOME do cliente — `cnae`/`customer_type` vêm
   vazios) que NÃO aparecem no que ele compra.
3. **Cidade** → dia de rota via `rotas-cidades.md` (e qual Farmer atende aquela cidade).
4. Ordene por cotas dentro de cada dia (≈50% recuperação / 30% expansão / 20% follow-up) e gere
   o plano com os roteiros de `roteiros.md`.
