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

_Preenchido depois do apply — ver a seção abaixo._

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
