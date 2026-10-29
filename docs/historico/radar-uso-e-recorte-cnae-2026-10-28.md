# Radar de Clientes: uso real e recorte de CNAE (medição de 2026-10-28)

> Entrega **só de leitura**: nenhuma migration, edge ou código de produto. Fontes: `psql-ro` (prod
> `fzvklzpomgnyikkfkzai`), HogQL read-only (`scripts/posthog-query.sh`) e uma amostra do dump RFB
> 2026-10. Todas as consultas terminaram com `FIM_OK`/`rc=0`. Pergunta: antes de construir mais nada
> no Radar, ele é usado? E o recorte de CNAE deixa de fora clientes que importam?

## Resumo

1. **O Radar não tem uso.** Só 1 pessoa tem acesso (o master). `/radar` foi servido em **1 dia de 51**
   com sensor server-side. O último contato humano com um lead foi em **15/06/2026**. Nenhum lead
   foi vinculado ao Omie pelo Radar. Os 3 e-mails de aviso de lote (20/10, 22/10 e 28/10) não
   geraram nenhuma abertura depois.
2. **O recorte de CNAE não é o gargalo.** Os 80% de clientes fora do Radar existem mesmo
   (12.048 de 15.061). Mas, entre os compradores dos últimos 12 meses, os que estão **dentro** do
   Radar respondem por **85% do faturamento atribuível**. Os de fora são, na maioria, arquitetos,
   construtoras e funilarias que não compram.
3. **Próximo passo:** um piloto com dono (vendedor com acesso e meta de toques). Ampliar o
   recorte agora só aumentaria uma fila que ninguém trabalha.

## Medição 1: quem usa o Radar

### Quem PODE usar

Gate do servidor: `private.pode_ver_carteira_completa` = `master` **ou** `employee` com
`commercial_role` em `gerencial`/`estrategico`/`super_admin`. A rota `/radar` só exige
`RequireStaff` e o item de menu usa `gestorComercialOuMaster`.

| Papel (`user_roles` × `commercial_roles`) | Usuários | Acessam o Radar |
| --- | ---: | ---: |
| master / master | 1 | 1 |
| employee / farmer | 2 | 0 |
| **Total staff no app** | **3** | **1** |

Dos 2 farmers que ficam de fora, um tem **1.003 pedidos** atribuídos (`created_by`) nos últimos
60 dias. É o vendedor ativo, mas nenhuma rota foi servida a ele no app em 51 dias: os pedidos dele
entram por importação/sync, não pela UI.

### Quem ABRE

- **Ledger server-side** (`navegacao.rota_servida`: 1 por rota, titular e dia; o outbox
  `analytics_outbox` repassa ao PostHog e purga em ~7 dias, então a série longa está no PostHog).
  O sensor existe desde **2026-09-08**: 230 rota-dias em 51 dias, **1 titular distinto** (o master).
  `/radar` aparece **1 vez**, em 2026-10-19 00:51 UTC (domingo, 21:51 BRT). Nos últimos 7 dias o
  outbox não registra `/radar`, e as rotas do master ficaram em reposição, tintométrico e `/`.

| Semana (seg) | 07/09 | 14/09 | 21/09 | 28/09 | 05/10 | 12/10 | 19/10 | 26/10 (parcial) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rotas servidas (todas) | 15 | 15 | 26 | 27 | 39 | 45 | 43 | 20 |
| `/radar` servido | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| titulares distintos | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |

Resultado: **30 dias = 1 abertura, 1 usuário; 60 dias = 1 abertura, 1 usuário** (o sensor cobre 51
dos 60 dias).

- **PostHog client-side:** **0** eventos `radar.*` em 90 dias. O controle é positivo: no mesmo
  período chegaram de 214 a 1.256 eventos por semana, de 2 a 5 pessoas. `$pageview` em `/radar*`:
  0 em 120 dias. **Esse zero não prova ausência de uso.** O Chrome do founder bloqueia o PostHog
  (`analytics.md` §4) e ele é o único autorizado. Por isso a fonte de abertura é o ledger, e os
  sensores dos blocos 2 a 5 (`radar.sugeridos_filtro`, `radar.cadastro_pos_sinal*`,
  `radar.kpis_vistos`, `radar.lote_cadastrado_omie` etc.) estão **cegos** para o único usuário.

### Quem TOCA leads

| Fonte | Medido |
| --- | --- |
| `radar_contatos` (humano) | **5** linhas, todas do master em **2026-06-15** (3 `em_conversa`, 2 `contatado_sem_resposta`). **0 desde então**, e 0 em 30/60/120 dias |
| `radar_contatos` (sistema) | 64.299 `descartado` entre 21/10 e 28/10, gravados por um usuário sem papel: a situação cadastral RFB (`RFB: INAPTA…`), não gente |
| `radar_empresas.prospeccao_status` | `a_contatar` 508.719 · `descartado` 64.299 · `contatado_sem_resposta` 2 · `em_conversa` 1 (total 573.021; `ja_cliente` 3.013) |
| Vínculo Omie pelo Radar | `omie_codigo_cliente` não nulo = **0** · `omie_cadastrado_em` não nulo = **0** |
| Execuções no ledger (`acoes_execucoes`, `radar.*`) | só `automatica`: `recruzar_ja_cliente` 11, `score_recalcular` 9, `avisar_lote` 3, `aplicar_situacao` 1. **0 manuais** (cadastro em massa e 1-clique nunca rodaram) |
| Aviso de lote | `radar_ingest_state.avisado_em` = 13/06, 20/10, 22/10, 28/10. Nenhuma abertura de `/radar` depois dos 3 avisos de outubro |

### Funil

| Autorizados | Abriram (60d) | Contataram (60d) | Cadastraram no Omie | 1º pedido |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1 (1 dia) | 0 | 0 | 0 (não há cadastro de onde partir) |

Denominador da fila: 508.719 leads `a_contatar` para 1 usuário autorizado.

## Medição 2: o CNAE dos clientes fora do Radar

### O número confirmado

A fonte é a mesma de `radar_recruzar_ja_cliente`: `profiles.document` ∪
`omie_clientes_nao_vinculados.cnpj_cpf`, só dígitos, 14 posições.

| | CNPJs |
| --- | ---: |
| Clientes com CNPJ (distintos) | 15.061 (4.976 em `profiles`, 10.085 só no Omie) |
| Presentes em `radar_empresas` | 3.013 (20,0%), todos com `ja_cliente` |
| **Fora do Radar** | **12.048 (80,0%)** |

Não há CNAE na base de clientes: `profiles.cnae` está preenchido em **0** linhas, e
`omie_clientes_nao_vinculados` não tem a coluna. A carga até lê o `cnae1` de todo CNPJ conhecido
(passo 3 do `carga.ts`), mas `radar_situacao_cadastral` não o guarda.

### O método (amostra calibrada, sem baixar o dump inteiro)

Baixei **2 dos 10** arquivos `Estabelecimentos` do dump 2026-10 (`5` e `9`, 700 MB de 5,4 GB) para
o scratchpad e extraí `cnpj`/`situacao`/`cnae1`/`uf` direto para parquet (`unzip -p | duckdb`).
Também baixei o `Cnaes.zip`.

- **Fração amostral** f = 65.094 ativas com CNAE-alvo na amostra ÷ 503.929 no lote 2026-10 do Radar
  = **12,92%**.
- **Sem viés:** a razão amostra/Radar ÷ f fica entre **0,94 e 1,04** nos 10 maiores CNAEs-alvo e
  entre **0,97 e 1,06** nas 8 maiores UFs. Os clientes aparecem na amostra na razão 1,09
  (2.123 de 15.061).
- As estimativas a seguir são contagem na amostra ÷ f. Onde a amostra tem n ≤ 2, o número é só
  indicativo.

### Quem são os 12.048 de fora

Situação RFB dos clientes de fora na amostra (n = 1.693): **ativa 79,3%** · baixada 13,0% ·
inapta 7,1% · suspensa 0,5%. Entre os ativos de fora, **0** têm CNAE que já está no alvo, o que
confirma que a única causa é o recorte. São 244 CNAEs distintos: 5 deles cobrem 50% e 47 cobrem 80%.

| CNAE | Descrição | Clientes fora (est.) | Universo ativo BR (est.) | Penetração |
| --- | --- | ---: | ---: | ---: |
| 7111100 | Serviços de arquitetura | 1.688 | 46.565 | 3,6% |
| 4120400 | Construção de edifícios | 1.208 | 182.577 | 0,7% |
| 4520002 | Funilaria e pintura de veículos | 937 | 91.567 | 1,0% |
| 7112000 | Serviços de engenharia | 921 | 167.520 | 0,5% |
| 4110700 | Incorporação imobiliária | 457 | 194.491 | 0,2% |
| 4399103 | Obras de alvenaria | 263 | 631.719 | 0,04% |
| 4754701 | Varejo de móveis | 209 | 98.008 | 0,2% |

Por divisão: 71 (arquitetura/engenharia) 26,5% · 41 (construção) 16,0% · 45 (veículos) 14,1% ·
47 (varejo) 8,4% · 43 (obras) 6,7%.

### Ponderado por faturamento: o dado que decide

Faturamento atribuível em 12 meses = `sales_orders` não cancelados (`faturado`/`importado`/
`separacao`/`enviado`) ligados a `profiles.document`. Isso cobre R$ 4,05 mi dos R$ 6,19 mi em
pedidos no período (65%). Os 10.085 clientes que só existem no Omie não têm pedido atribuível e
**não entram na ponderação**: é ausência de dado, não zero.

| | Clientes | Compradores 12m | Faturamento 12m |
| --- | ---: | ---: | ---: |
| No Radar | 3.013 | 219 | R$ 3,43 mi (**84,7%**) |
| Fora do Radar | 12.048 | 146 | R$ 0,62 mi (15,3%) |

Os CNAEs grandes de fora (arquitetura, construção, funilaria) têm **0 compradores 12m** na amostra.
Os 16 compradores de fora que caem na amostra se espalham por 12 CNAEs, sem concentração: varejo de
madeira, fundição, outros produtos de metal, ferragens, montagem de móveis.

### CNAEs candidatos (estimativa do que entraria na fila)

| CNAE | Descrição | Universo ativo (est.) | Clientes na amostra | Compradores 12m na amostra | Leitura |
| --- | --- | ---: | ---: | ---: | --- |
| 2451200 | Fundição de ferro e aço | ~880 | 6 | 0 | aderente (abrasivos), fila mínima |
| 2452100 | Fundição de não-ferrosos | ~890 | 2 | 2 | aderente, fila mínima |
| 2599399 | Outros produtos de metal | ~11.800 | 4 | 2 | aderente ao bloco metal |
| 4744002 | Varejo de madeira e artefatos | ~27.700 | 17 | 2 | revenda: decisão de canal |
| 3329501 | Montagem de móveis | ~54.200 | 10 | 1 | borda do moveleiro |
| 4744001 | Varejo de ferragens e ferramentas | ~75.500 | 5 | 1 | revenda: decisão de canal |
| 7111100 | Arquitetura | ~46.600 | 218 | 0 | **não**: muito cadastro, nenhuma compra |
| 4520002 | Funilaria e pintura de veículos | ~91.500 | 121 | 0 | **não**: fora do mix (repintura automotiva) |
| 4120400 | Construção de edifícios | ~182.500 | 156 | 0 | **não** |

Se o founder incluir as 3 aderentes ao metal (2451200, 2452100, 2599399), a fila cresce
**~13,6 mil (+2,7%)**. Incluir também as 3 de borda (4744002, 3329501, 4744001) acrescenta outros ~157 mil, num
total de **~171 mil (+34%)**, quase todos leads frios.

## Recomendação

- **Piloto antes de recorte.** O problema medido é a falta de alguém trabalhando a fila: 1
  autorizado, 1 abertura em 51 dias, 0 toques desde junho. Um piloto de 50 leads com dono (o farmer
  ativo, que hoje não tem acesso, ou o founder com meta semanal) dá o 1º sinal positivo com
  denominador (`fase-sem-sinal.md`).
- **Recorte: não mexer agora.** A premissa de que 80% de fora invalida o recorte não se sustenta
  quando se pondera por receita: 85% do faturamento atribuível está dentro. Se for mexer, só as 3
  de metal (+2,7% de fila). Arquitetura, construção e funilaria ficam de fora.
- **Lacunas para o próximo bloco** (só se o piloto andar): (a) os sensores `radar.*` só vão ao
  PostHog, que é cego para o único usuário, então toque e oferta precisam ir ao ledger;
  (b) gravar o `cnae1` que a carga já lê dos CNPJs conhecidos, para que esta medição vire uma query
  e não exija baixar amostra.

## Como reproduzir

- Medição 1: `psql-ro` em `user_roles`/`commercial_roles`, `analytics_outbox`, `radar_contatos`,
  `radar_empresas`, `acoes_execucoes` e `radar_ingest_state`; HogQL em `events` (`event LIKE
  'radar.%'`, `navegacao.rota_servida` com `properties.rota`, controle semanal sem filtro de evento).
- Medição 2: `bun` + `rfb.ts` (`basesCandidatas`/`authorizationDe`) para baixar
  `Estabelecimentos{5,9}.zip` e `Cnaes.zip`; `unzip -p | iconv -f latin1 | duckdb` → parquet; join
  com o `\copy` dos CNPJs de clientes; calibração contra `radar_empresas` (lote 2026-10, por CNAE e
  por UF). Amostra descartável: nada foi gravado em prod.
