# Radar — contato provável da contabilidade do cliente (2026-11-07)

**Pedido do founder:** "queria que o radar já me falasse se o número de contato é de uma contabilidade do cliente.
Assim eu não ligo e forço direto a visita presencial."

**Entrega:** migration `20261109140000_radar_contato_contabil` (manual) + ficha, fila, card "Prospectar hoje" e e-mail
semanal. Prova PG17: `db/test-radar-contato-contabil.sh` (42 asserts; 25 sabotagens vermelhas no assert certo, nos 2
locales).

## A regra (v1) — por contato, com motivo gravado

Telefone1, telefone2 e e-mail são classificados um por um: um lead pode ter um telefone direto e outro do contador.

| Motivo | Quando |
|---|---|
| `telefone_compartilhado` | o mesmo telefone (DDD + últimos 8 dígitos, junta o 9º dígito) em **4+ grupos sem vínculo detectado**, ou em **3 com corroboração** (algum membro tem e-mail forte de contabilidade) |
| `email_compartilhado` | o **mesmo endereço** de e-mail em 3+ grupos sem vínculo (qualquer domínio) |
| `email_palavra` | o e-mail tem `contab` ou `contador` (sem acento, minúsculo) |
| `email_palavra_fraca` | tem `escritorio` ou `assessoria` (e não as fortes); motivo separado para medir à parte |
| `dominio_servico` | lista fechada: `maismei.com.br`, `contabilizei.com.br`, os 27 `crcXX.org.br`, e o `.cnt.br` |

- **Grupo** = mesma raiz de CNPJ (filiais), unida às raízes com sócio em comum por **nome normalizado + CPF mascarado**
  (`radar_socios`, lote vigente). Nome sozinho não une.
- Lead com CNAE principal 6920-6 (é ele o escritório) não recebe marca automática.
- **Correção do vendedor** (`radar_contato_contabil_correcoes`, append-only): por (cnpj, tipo, valor estrito). O último
  veredito vence; NULL volta ao automático; a RPC exige a versão que o vendedor viu. Grava o que o automático dizia
  (sensor de acerto). Não propaga para outros CNPJs.
- **Visitar** = ≥ 1 contato utilizável, todos marcados no efetivo, e endereço presente. O lead continua elegível no
  e-mail e no card; vai como "visitar" com o endereço, e a copy não promete telefone.
- **Cálculo em lote**, 1 escritor (`radar_contato_contabil_recalcular`, cron `radar-contato-contabil-diario` 06:50 UTC),
  gate por impressão digital (versão da regra, lote Receita, lote de sócios, `max(updated_at)`, `count(*)`), rede de 7
  dias, MERGE na tabela. A leitura (ficha, fila, card, e-mail) só consulta por chave.

## Por que estas escolhas (dado + parecer Codex)

Medido em PROD (export com **hash** de telefone/e-mail/sócio, 573.021 CNPJs, PG17 local; o export foi apagado):

- **Domínio compartilhado saiu**, entrou **endereço compartilhado**: o que o domínio acrescentava além da palavra e do
  endereço eram 814 CNPJs em MG, quase todos typo de webmail (`gamil.com` 299, `gmai.com` 298, `gmal.com`, `hotmai.com`) e
  provedor regional (`netsite`, `uai`, `sercomtel`). O endereço compartilhado pega os escritórios sem palavra no domínio
  (`maismei.com.br` 3.484 raízes, 100% endereço compartilhado; um escritório com 11 caixas para 131 CNPJs).
- **V2 no limiar 3** (Codex P1): chaves de telefone com 3 grupos têm 68% de corroboração por e-mail de contabilidade; 4
  grupos 80%; 5–9 86%; 10+ 96%. Exigir corroboração no 3 tira 6% (MG) a 11% (Brasil) dos CNPJs que o "3 puro" marcaria.
- **Sem juntar por nome** (Codex P1): `socios_nomes` cobre 21% de MG e homônimo une empresas sem relação. Juntar por
  nome só derrubaria ~7% das chaves; `radar_socios` (nome + CPF mascarado) está **vazia** até a próxima carga mensal.
- **Palavra fraca mantida** (diverge do Codex, que pedia não marcar sozinha): é pedido explícito do founder, pesa 465
  de 9.151 e-mails com palavra em MG (5%), e tem motivo próprio para medir e desligar por versão se errar.
- Custo do falso positivo: o vendedor visita em vez de ligar; há o botão de correção. Falso negativo = status quo.

Escritor medido no volume real (573 mil linhas sintéticas a partir do export): **14 s** local, depois de trocar um
`EXISTS` por chave (sem índice: chaves × membros, 70 s) por junção agregada.

## Medição ANTES (previsão da regra v1 sobre o export de PROD, 2026-11-07)

Hoje (antes da migration) **nenhum lead tem o selo**: o sinal não existe. A regra final, aplicada ao export:

| Recorte | Empresas | Com selo (≥ 1 contato) | Telefone marcado | Só contabilidade | Elegíveis (a contatar, score, foto vigente, contato) | Elegíveis com selo | Elegíveis só contabilidade |
|---|---:|---:|---:|---:|---:|---:|---:|
| MG | 69.626 | 14.335 | 4.549 | 3.301 | 57.666 | 11.967 | 2.677 |
| Total | 573.021 | 69.971 | 24.873 | 16.346 | 489.068 | 61.373 | 14.317 |

Contexto do pedido (medição da sessão de origem, MG): 68 mil com telefone, 64 mil com e-mail; 9.151 e-mails com palavra;
911 telefones em 3+ CNPJs somando 4.372 empresas (máximo 55 no mesmo número).

## Medição DEPOIS (PROD, após o apply)

Apply em 2026-11-08 02:25 UTC (`db:aplicar`, tentativa #981, sha256 `5ac7ebee…`). 1º cálculo: **83.709 contatos**
(23.115 telefones, 60.594 e-mails) em 62 s no banco; `socios_lote` nulo (`radar_socios` vazia: grupo = raiz de CNPJ
até a próxima carga). Conferido por `psql-ro`: `radar_lista` só na forma de 23 argumentos; md5 de `radar_lista`,
`radar_avisar_vendedores` e `radar_prospectar_hoje` iguais aos da PÓS; RLS ligada e sem SELECT para `anon` ou
`authenticated` nas 3 tabelas; o cron existe.

| Recorte | Com selo (≥ 1 contato) | Telefone marcado | Só contabilidade | Visitar (só contabilidade + endereço) | A contatar com selo | A contatar para visitar |
|---|---:|---:|---:|---:|---:|---:|
| MG | 14.190 | 4.327 | 3.280 | 3.280 | 12.818 | 2.949 |
| Total | 67.893 | 22.111 | 16.043 | 16.043 | 60.840 | 14.431 |

A previsão ficou a menos de 3% em MG (14.335 → 14.190 com selo; 3.301 → 3.280 só contabilidade) e a ~11% no telefone
total (24.873 → 22.111); a base andou desde o export. Todo lead só-contabilidade tem logradouro. "A contatar" é
`prospeccao_status = 'a_contatar'`, mais largo que a elegibilidade do e-mail (score e foto vigente).

Query (psql-ro; normalização inline, porque `claude_ro` não executa `private.*`):

```sql
WITH ag AS (
  SELECT cnpj, array_agg(valor) FILTER (WHERE tipo='telefone') tels, array_agg(valor) FILTER (WHERE tipo='email') ems
  FROM public.radar_contato_contabil GROUP BY cnpj
), tv AS (
  SELECT ag.tels, ag.ems, e.uf, e.logradouro, e.prospeccao_status,
    (SELECT CASE WHEN length(d) IN (10,11) AND right(d,8) !~ '^(.)\1{7}$' THEN d END FROM (SELECT CASE WHEN length(x) IN (12,13) AND left(x,2)='55' THEN substr(x,3) ELSE x END d FROM (SELECT ltrim(regexp_replace(coalesce(e.telefone1,''),'[^0-9]','','g'),'0') x) a) b) t1,
    (SELECT CASE WHEN length(d) IN (10,11) AND right(d,8) !~ '^(.)\1{7}$' THEN d END FROM (SELECT CASE WHEN length(x) IN (12,13) AND left(x,2)='55' THEN substr(x,3) ELSE x END d FROM (SELECT ltrim(regexp_replace(coalesce(e.telefone2,''),'[^0-9]','','g'),'0') x) a) b) t2,
    (SELECT CASE WHEN v ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN v END FROM (SELECT lower(btrim(e.email)) v) a) em
  FROM ag JOIN public.radar_empresas e ON e.cnpj = ag.cnpj
), m AS (
  SELECT uf, logradouro, prospeccao_status,
    (t1 = ANY(coalesce(tels,'{}')) OR t2 = ANY(coalesce(tels,'{}'))) IS TRUE tel_m,
    (t1 IS NULL OR t1 = ANY(coalesce(tels,'{}'))) AND (t2 IS NULL OR t2 = ANY(coalesce(tels,'{}')))
      AND (em IS NULL OR em = ANY(coalesce(ems,'{}'))) AND coalesce(t1,t2,em) IS NOT NULL so_contab
  FROM tv
)
SELECT coalesce(CASE WHEN uf='MG' THEN 'MG' ELSE 'outras' END, 'total') recorte,
  count(*) com_selo, count(*) FILTER (WHERE tel_m) tel_marcado,
  count(*) FILTER (WHERE so_contab) so_contab,
  count(*) FILTER (WHERE so_contab AND nullif(btrim(logradouro),'') IS NOT NULL) visitar,
  count(*) FILTER (WHERE prospeccao_status='a_contatar') a_contatar_com_selo,
  count(*) FILTER (WHERE prospeccao_status='a_contatar' AND so_contab AND nullif(btrim(logradouro),'') IS NOT NULL) a_contatar_visitar
FROM m GROUP BY ROLLUP (CASE WHEN uf='MG' THEN 'MG' ELSE 'outras' END) ORDER BY 1;
```

**Re-medir** quando `radar_socios` carregar (o grupo passa a unir raízes por sócio e o selo deve cair um pouco), e o
acerto pela query do sensor abaixo.

## Sensor de uso e de acerto

- **Uso:** `radar_contato_contabil_correcoes` (quem corrigiu, quando, o que o automático dizia) + `track('radar.contato_contabil_corrigido')`.
  Denominador: fichas abertas com selo = `radar_eventos` 'abriu' com cnpj ∩ `radar_contato_contabil`.
- **Acerto:** `automatico = true AND veredito = false` é falso positivo confessado; `automatico = false AND veredito = true`
  é falso negativo. Query:

```sql
SELECT automatico, veredito, count(*) FROM public.radar_contato_contabil_correcoes GROUP BY 1, 2 ORDER BY 1, 2;
```

- **E-mail:** `radar_email_vendedor_leads.visitar` (NULL = envio anterior à migration).

## Fase 2 (não feita)

Cruzar com a base de escritórios contábeis da Receita (CNAE 6920-6): o Radar não carrega esses CNPJs hoje.
