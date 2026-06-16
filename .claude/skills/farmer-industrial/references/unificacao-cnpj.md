# Unificação de cliente por CNPJ (design — revisado com Codex, 2026-06-15)

Resolve dois casos reais do dono: **(A) sucessão** (cliente encerra um CNPJ e abre outro — o
histórico tem que seguir pro novo, senão ele parece "nunca comprou") e **(B) multi-CNPJ ativo**
(a mesma empresa fatura por vários CNPJs ao mesmo tempo — não pode ligar duas vezes pra mesma
empresa, e o mix/faturamento deve somar).

> **A lição central (Codex):** o risco não é *detectar* os candidatos — é tratar "mesmo cliente"
> como **uma fusão única para todas as métricas**. Sucessão e multi-CNPJ ativo exigem semântica
> **diferente**. Juntar pedidos de CNPJs paralelos que se alternam **encolhe o intervalo de
> recompra e faz um cliente em queda parecer saudável**. Por isso: **fusão é confirm-first, com
> `relation_type`, e algumas métricas NUNCA podem ser pooled.**

## 1. Não colapse os níveis

Mantenha quatro chaves distintas — colapsar tudo num `cliente_key` é o erro de raiz:

| Chave | O que é |
| --- | --- |
| `doc_key` | CNPJ (dígitos) — ou `user_id` como fallback quando não há CNPJ |
| `profile_key` | `user_id`/`customer_user_id` (registro no ERP) |
| `grupo_key` | cliente operacional real (grupo de CNPJs **confirmado** pelo dono) |
| `call_key` | alvo de dedup da lista de ligação (= `grupo_key` quando há grupo, senão `doc_key`) |
| `relation_type` | `sucessao` · `multi_ativo` · `incerto` — muda como agregamos |

## 2. Detecção de candidatos (sinais + confiança)

Nunca diga "mesmo cliente" por um sinal só. Ranque (menor → maior risco de falso-positivo):

1. **Nome normalizado + mesmo telefone + mesma cidade** → ALTA confiança.
2. Mesmo telefone + cidade + mix/comportamento parecido → MÉDIA.
3. Mesmo nome normalizado + cidade → BAIXA (cidade é sinal fraco em território rural).
4. Só nome / só telefone / só cidade → **candidato, nunca fundir**.

**Armadilhas de falso-positivo** (todas reais no interior): nomes genéricos (`MARCENARIA SÃO
JOSÉ`, `SÍTIO SANTA LUZIA`); stripar sufixo (`LTDA/ME/EIRELI`) colapsa demais; **telefone
compartilhado** (contador, escritório de compras, WhatsApp da família, vendedor); **endereço/
cidade** (centro comercial, mesma fazenda, escritório do contador); **grupo econômico** (mesma
família, mas compradores operacionalmente distintos → dedup de ligação sim, fusão de histórico
não). **Raiz de 8 dígitos do CNPJ NÃO serve** (grupo econômico compartilha raiz; sucessão troca raiz).

### Diagnóstico multi-sinal (read-only, Lovable)

```sql
with prof as (
  select regexp_replace(coalesce(p.cnpj,p.document,''),'\D','','g') as doc,
         coalesce(p.razao_social, p.name) as nome,
         lower(translate(trim(coalesce(p.razao_social, p.name)),
               'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
               'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')) as nome_norm,
         p.user_id
  from profiles p
  where length(regexp_replace(coalesce(p.cnpj,p.document,''),'\D','','g')) >= 11
),
fone as (  -- telefone mais recente por user (de sales_orders)
  select distinct on (customer_user_id) customer_user_id,
         regexp_replace(coalesce(customer_phone,''),'\D','','g') as tel
  from sales_orders where coalesce(customer_phone,'') <> ''
  order by customer_user_id, created_at desc
),
cid as (
  select user_id, lower(trim(regexp_replace(city,'\s*\([^)]*\)\s*$',''))) as cidade
  from addresses where is_default = true
),
base as (
  select distinct pr.doc, pr.nome, pr.nome_norm,
         nullif(f.tel,'') as tel, c.cidade
  from prof pr left join fone f on f.customer_user_id = pr.user_id
               left join cid  c on c.user_id = pr.user_id
)
select nome_norm,
       count(distinct doc) as qtd_cnpjs,
       count(distinct tel) filter (where tel is not null) as fones_distintos,
       count(distinct cidade) filter (where cidade is not null) as cidades_distintas,
       string_agg(distinct nome, ' / ') as nomes,
       string_agg(distinct doc, ', ')  as cnpjs,
       string_agg(distinct tel, ', ')  as telefones,
       string_agg(distinct cidade, ', ') as cidades
from base
group by nome_norm
having count(distinct doc) > 1
order by qtd_cnpjs desc, nome_norm
limit 80;
```

Leia: `fones_distintos = 1` **e** `cidades_distintas = 1` junto com nome igual → ALTA confiança.
Vários telefones/cidades → trate como candidato a revisar, não fusão.

### ⚠️ Lição empírica (rodado contra produção, 2026-06-15): sucessão NÃO é auto-detectável

Testei "mesma cidade + A parou + B começou ≤180d depois" contra a base real → **ruído quase
total**. A região é cheia de marcenaria pequena com rotatividade alta, então qualquer CNPJ novo
casa com dezenas de CNPJs que ficaram quietos (ex.: "APARECIDA MÓVEIS" pareou com 7 empresas
diferentes de Cláudio). E `customer_phone` vem NULL nos registros antigos (2020), então o sinal
forte some. **Conclusões:**
1. **Cidade + tempo sozinhos = inútil.** Nunca proponha fusão só com isso.
2. **Exija uma ÂNCORA de identidade**: mesmo **telefone** OU mesmo **endereço físico** (rua+número).
   A versão abaixo já filtra por isso — e tende a voltar pouquíssima coisa, o que é a resposta
   honesta (sucessão raramente deixa rastro detectável aqui).
3. **O mecanismo real é OWNER-ASSERTED**: o dono conhece as sucessões ("Fulano fechou a X e abriu
   a Y"). O fluxo robusto é **o dono afirmar o par → a skill validar** (timing/cidade plausíveis? o
   antigo parou mesmo? o novo está ativo?) **→ aplicar**. Não "detector propõe"; "dono afirma,
   skill valida". Multi-CNPJ ativo idem.

### Detector de SUCESSÃO (só com âncora: telefone OU endereço) — fila de revisão

Pegue um CNPJ que **parou** e outro que **começou logo depois** SÓ quando dividem **telefone ou
endereço** (mesma oficina, CNPJ novo). Sem a âncora, é ruído (ver lição acima). Diagnóstico:

```sql
-- FILA DE REVISÃO (não fusão): A parou, B começou ≤365d depois, E dividem TELEFONE ou ENDEREÇO.
-- A âncora (telefone/endereço) é o que separa sucessão real de "duas marcenarias diferentes na
-- mesma cidade". Sem ela o resultado é ruído (ver lição acima). Nada aqui funde — é lista pra revisar.
with ped as (
  select regexp_replace(coalesce(p.cnpj,p.document,''),'\D','','g') as doc,
         so.created_at::date as data,
         coalesce(p.razao_social, p.name) as nome,
         regexp_replace(coalesce(so.customer_phone,''),'\D','','g') as tel,
         lower(trim(regexp_replace(a.city,'\s*\([^)]*\)\s*$',''))) as cidade,
         lower(trim(coalesce(a.street,'')||' '||coalesce(a.number,''))) as endereco
  from sales_orders so
  join profiles p on p.user_id = so.customer_user_id
  left join addresses a on a.user_id = so.customer_user_id and a.is_default = true
  where so.status in ('faturado','importado','separacao','enviado') and so.deleted_at is null
    and length(regexp_replace(coalesce(p.cnpj,p.document,''),'\D','','g')) >= 11
),
attr as (   -- por CNPJ: janela de compra + âncoras (telefone, endereço) + nome, mais recentes
  select doc,
         (array_agg(cidade   order by data desc) filter (where cidade is not null))[1] as cidade,
         (array_agg(nullif(endereco,'') order by data desc) filter (where nullif(endereco,'') is not null))[1] as endereco,
         (array_agg(nullif(tel,'')      order by data desc) filter (where nullif(tel,'') is not null))[1] as tel,
         (array_agg(nome     order by data desc))[1] as nome,
         min(data) as primeiro, max(data) as ultimo
  from ped group by doc
)
select a.cidade,
       a.nome as nome_antigo, a.doc as cnpj_antigo, a.ultimo  as parou_em,
       b.nome as nome_novo,   b.doc as cnpj_novo,   b.primeiro as comecou_em,
       (b.primeiro - a.ultimo) as gap_dias,
       (a.tel is not null and a.tel = b.tel) as mesmo_telefone,
       (a.endereco is not null and a.endereco = b.endereco) as mesmo_endereco,
       a.tel as tel_antigo, b.tel as tel_novo, a.endereco as endereco
from attr a join attr b
  on a.doc <> b.doc
 and a.ultimo < b.primeiro                          -- A morre antes de B nascer
 and (b.primeiro - a.ultimo) between 0 and 365      -- B começou em até 1 ano
 and b.ultimo > current_date - 180                  -- B está ativo agora
 and a.ultimo < current_date - 180                  -- A parou de vez
 and ( (a.tel is not null and a.tel = b.tel)        -- ÂNCORA: mesmo telefone, OU
       or (a.endereco is not null and length(a.endereco) > 6 and a.endereco = b.endereco) )  -- mesmo endereço
order by mesmo_telefone desc, mesmo_endereco desc, gap_dias
limit 80;
```

Mostre ambos os diagnósticos ao dono; ele confirma quais são o mesmo cliente.

## 3. Sucessão vs Multi-CNPJ ativo (teste de tempo)

Para cada par A/B com `A_first/A_last`, `B_first/B_last`:
- **Sucessão**: `A_last < B_first` (janelas **não** se sobrepõem), B ativo agora, A parou. →
  cliente operacional **ao longo do tempo**; concatena histórico, mas **guarda o gap de transição**.
- **Multi-CNPJ ativo**: janelas **se sobrepõem** (`A_first ≤ B_last` e `B_first ≤ A_last`), com
  ≥2 pedidos de cada no mesmo período (tolerância p/ nota fiscal avulsa/devolução). → uma conta
  com **várias entidades de faturamento**.
- Senão → `incerto`: dedup de ligação pode valer, fusão de métrica não.

## 4. Confirmação sem tabela no banco (a interface é a skill, não o git)

Não dá pra persistir tabela (read-only). O dono também não edita `VALUES` cru com segurança.
**Melhor**: o dono te passa um bloco estruturado simples (CSV/lista), **a skill gera o CTE** com
metadata e auto-validação. O alias mínimo NÃO é `(doc, grupo)` — é:

```sql
aliases(doc, grupo, relation_type, valid_from, valid_to, confirmed_at, note) as (
  values
    ('12345678000199','G001','sucessao',  date '2019-01-01', date '2022-06-30','2026-06-15','CNPJ antigo, encerrado'),
    ('98765432000188','G001','sucessao',  date '2022-07-01', null,             '2026-06-15','CNPJ novo herda histórico'),
    ('11111111000122','G002','multi_ativo',null,             null,             '2026-06-15','fatura junto com 000133'),
    ('11111111000133','G002','multi_ativo',null,             null,             '2026-06-15','idem')
)
```

**A query deve auto-validar** (cole junto, saída de "avisos" primeiro) — cada vez, porque não há
estado persistido: doc duplicado; mesmo doc em >1 grupo; grupo com 1 doc só; dígitos inválidos;
`relation_type` conflitante dentro do grupo; alias "stale" (um doc do grupo sem aparecer há 18m+).
Sem isso, um mapa velho corrompe **todo** relatório silenciosamente.

**Armadilhas do mapa manual** (por isso a skill gera, não o dono na unha): erro de dígito; CNPJ
formatado vs só-dígitos; transitividade (`A=B`, `B=C` mas `A` não listado); pares vs grupos;
duas pessoas editando; centenas de linhas ilegíveis; o CTE vira "código de negócio escondido".

## 5. Métricas — o que pode e o que NÃO pode ser pooled

A regra de ouro: **recência / mix / faturamento / dedup de ligação = post-merge** (somar o grupo
é certo). **Frequência / churn / "está caindo?" = NÃO pode ser só pooled** — calcule por-doc e
agregue com cuidado, e **exponha a composição** pra Farmer.

**Sucessão com gap** (A parou jan, B começou jul): concatenar cria um intervalo gigante na
transição. Guarde `gap_transicao = novo_primeiro − antigo_ultimo` à parte. Recência/mix/LTV =
post-merge; frequência = calcule as duas (longo prazo com o gap, e janela recente só do CNPJ
novo); churn = post-merge mas marque "reativado após sucessão" se o gap foi grande.

**Multi-CNPJ ativo interleaved**: pooling encolhe o intervalo. Ex.: A compra a cada 60d, B a
cada 60d, alternando a cada 30d → o grupo "parece" comprar a cada 30d, e um comprador caindo
parece saudável. Não classifique churn pelo `max(data)` pooled se um CNPJ parou e outro
continua. Use **janelas móveis**, não intervalo médio global.

**Pare de usar só `(max−min)/(n−1)`** como sinal principal (já é fraco; pooled fica pior).
Prefira **mediana do intervalo entre pedidos** + **deltas de janela recente**:

```text
orders_90d vs orders_prev_90d          -- caiu o volume?
spend_60d  vs média dos 60d anteriores
familias_distintas_180d vs baseline
dias_desde_ultimo_pedido_do_grupo
dias_desde_ultimo_pedido_por_doc       -- por CNPJ
mediana_intervalo  /  p75_intervalo
```

**Exponha a fusão no plano** (senão o sistema parece confiante quando está chutando): cada linha
de cliente agrupado mostra `merged_docs_count`, `relation_types`, `last_order_per_doc`,
`merge_warning`. Se a Farmer vê 1 cliente com 4 CNPJs fundidos, ela precisa saber.

## 6. Quando materializar (ordem disciplinada)

1. Dono roda os **dois diagnósticos** (§2) → vê quantos candidatos reais existem.
2. Confirma os grupos (relation_type por grupo).
3. **Só então** a skill gera a query de carteira com o CTE `aliases` + as métricas post-merge/
   per-doc da §5, e valida contra dado real (igual ao resto da skill: nada de máquina elaborada
   sem input real pra testar).

Até lá, o **default por-CNPJ** (1 CNPJ = 1 cliente) é seguro e é o que roda — ele não sofre da
armadilha de pooling porque não funde nada. A unificação é uma camada **opt-in, confirmada**.
