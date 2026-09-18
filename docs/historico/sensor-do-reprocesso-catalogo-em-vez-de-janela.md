# O reprocesso ganhou sensor — e ele vigia por CATÁLOGO, não por janela (2026-09-18)

**Em 3 linhas.** O reprocesso da Oben ficou 10 dias quebrado sem um único alerta porque nenhum dos
checks do `_data_health_compute` lia `sync_reprocess_log`. Este PR fecha o ponto cego com o check
`sync_reprocess_saude`, recriando as **três** funções do trio acoplado. A decisão de desenho que
importa não é o limiar: é vigiar um **catálogo explícito de chaves** em vez de descobrir quem vigiar
por uma janela de atividade recente.

Irmão: [reprocess-oben-parado-seis-dias.md](reprocess-oben-parado-seis-dias.md) (o diagnóstico) ·
o conserto do reprocesso em si é o #2496.

## O ponto cego, medido

De 2026-09-08 20:15Z a 2026-09-18 houve 122 execuções `operational/orders` em `status='error'` e 10
`strategic/orders`; os estágios seguintes (`inventory`, `products`) pararam de gravar, porque o
estágio de pedidos lança antes. Por que ninguém soube:

| Sensor | Por que não viu |
|---|---|
| `_data_health_compute` (29 checks) | nenhum lia `sync_reprocess_log` |
| check `vendas_pedidos` | mede o sync **incremental** (`fin_sync_log`/`sync_pedidos`) — verde o tempo todo |
| check `sync_state_saude` | veria erro autodeclarado, mas a edge não escreve `sync_state` (o marcador `orders` saiu como fóssil na `20260824232212`) |
| `data_health_watchdog` | só consome o compute |
| `fin_sync_heartbeat` | só resume `fin_alertas`/`fin_sync_log` |
| ação `get_health` da própria edge | lê a tabela, mas não tem limiar, não escreve e ninguém a chama |
| `cron.job_run_details` | `succeeded` prova o **enqueue**, não o HTTP (a verdade estava em `net._http_response`, que retém poucas horas) |

**`checks_falhos=0` nunca significou saúde.** O estado de 14/09 (`checks_avaliados=21,
checks_falhos=0`) foi lido no diagnóstico como "os sensores estavam verdes". Não é o que o campo
mede: o laço do watchdog só incrementa `v_falhos` no `EXCEPTION` — ele conta **check que explodiu**,
nunca check com status ruim. Um watchdog com 21 checks todos `broken` grava `checks_falhos=0`.
Fixado como assert na prova (`db/test-data-health-sync-reprocess.sh`), porque é a leitura que
naturalmente se faz do nome.

## A decisão de desenho: catálogo, não janela

O desenho óbvio — descobrir as chaves que rodaram nos últimos N dias e vigiar essas — é **fail-open
no tempo**, a mesma armadilha de `ausente ≠ zero` aplicada à cobertura:

- a chave que ficar quebrada por mais de N dias **sai da janela** e o alerta **some sozinho**,
  exatamente quando o problema é mais grave;
- a chave que **nunca** rodou (cron criado, edge que nunca produziu) é invisível desde sempre —
  o pior caso é o mais silencioso.

Com catálogo explícito (`VALUES` no corpo do check, com o SLA de cada chave):

- ausência de linha é **`broken`**, não silêncio;
- aposentar uma chave vira decisão humana **versionada no diff**, não um alerta que se apaga;
- o SLA fica escrito, não inferido de uma mediana que rajadas distorcem.

O preço do catálogo é não enxergar o que é novo. Por isso o `FROM` é um **FULL JOIN** entre o
catálogo e a atividade das últimas 48h: chave ativa que ninguém catalogou sai como **`unknown`** —
nunca `ok`. Cobertura desconhecida não é cobertura saudável. Os dois lados ficam fechados: o
catálogo não perde o morto, o FULL JOIN não perde o novo.

## Escopo: a tabela tem 4 escritores e 3 dialetos

Medido em prod antes de decidir — o vocabulário **não** é uniforme:

| Escritor | `reprocess_type` | `account` | Status que emite |
|---|---|---|---|
| `sync-reprocess` | `operational`, `strategic`, `manual` | `oben`, `colacor` | `running`, `complete`, `error` |
| `omie-sync-status-produtos` | `status_produtos` | `oben`, `colacor` | `running`, `complete`, **`failed`** |
| `gerar-pedidos-diario` | `ciclo_diario` | **`OBEN`** | `ok`, `error` |
| `disparar-pedidos-aprovados` | `disparo_diario` | **`OBEN`** | `ok`, **`partial`**, `error` |

**Vigiadas (7 chaves).** As do `sync-reprocess` com cron (`operational` SLA 4h — cron a cada 2h;
`strategic` SLA 30h — diário) mais `status_produtos` (SLA 30h — cron diário jobid 48). O
`status_produtos` entrou por medição, não por escopo criativo: tinha cron vivo e **zero** cobertura
em qualquer check. Deixá-lo de fora recriaria o mesmo ponto cego num recorte menor, e a próxima
sessão teria de recriar o trio inteiro de novo — arquivo quente, custo alto.

**Dispensadas, com o motivo no catálogo** (`sla_h NULL`, para não caírem em "não catalogada"):

- `manual` — disparo **humano e síncrono**: quem dispara vê o resultado na hora, e *staleness* não
  tem sentido sem cadência. `colacor/manual/products` está em `error` desde 28/02/2026: vigiá-lo
  faria o check **nascer vermelho** por um fóssil de sete meses — e alerta que nasce vermelho é o
  que ensina o founder a ignorar o alerta.
- `OBEN` maiúsculo — **já vigiado por EFEITO**, por outro eixo: `reposicao_sugestoes` lê
  `pedido_compra_sugerido.data_ciclo` e `reposicao_disparo` lê a fila
  `aprovado_aguardando_disparo`. Vigiar aqui também seria alarme duplicado. (Conferido no corpo dos
  dois checks, não presumido do nome.)
- `sync_full/omie_condicoes_pagamento` — 6 linhas, todas de 30/04/2026, sem cron.

## Precisão: degradação ≠ quebra

Uma run que **completou** registrando falha por pedido (o comportamento que o #2496 introduz) não é
`broken` — o estágio andou. Mas o vocabulário do compute é **fechado**: o watchdog levanta `22023`
em qualquer status fora de `ok|stale|broken|unknown`, então não há `degraded` a inventar. A saída:
a degradação entra **na `message` do ramo `ok`**. Ali o watchdog dismissa o alerta e não emite
e-mail — a degradação fica visível no `/health` sem gritar. E a contagem instável (que muda a cada
run) só aparece **nesse** ramo: nos ramos que alertam, a message fica ancorada em data congelada,
porque o fingerprint do push é `source|status|severity|message` e o cron é `*/30`.

## Limiares, e de onde saíram

- **órfã `running` > 2h**: a duração máxima de uma run bem-sucedida em 90 dias é **2,6 min**
  (`percentile_cont(0.99)` ≤ 2,4 min). 2h é ~46× o pior caso real — folga que exclui run lenta
  legítima como fonte de falso positivo.
- **`stale`**: 2× a cadência do cron, com folga para jitter. Diários ficaram em 30h e não 26h
  porque a idade natural já chega a ~24h + atraso do cron; 26h daria 2h de margem, e um cron
  atrasado viraria alarme falso.

## A prova

`db/test-data-health-sync-reprocess.sh` — **27 asserts**, PG17 descartável, `--falsificar` com
**9 sabotagens**. Três coisas que ela faz diferente dos harnesses de data-health anteriores:

1. **Não depende do `schema-snapshot.sql`.** Cinco dos oito harnesses existentes apodreceram em
   silêncio por causa dele (medido 2026-08-14), e o CI é vitest — ninguém viu. Aqui os
   pré-requisitos são `db/stubs-data-health-trio.sql`: as 21 tabelas + a MV `private` que as três
   funções leem/escrevem, com a forma **medida em prod** via `pg_attribute`/`format_type`. Se um
   check novo passar a ler uma tabela que não está lá, o `CREATE` falha no harness — barulhento.
2. **Prova o ACL, não o default do harness.** Um PG limpo daria `EXECUTE` a `PUBLIC`; prod tem o
   `REVOKE`. O harness reproduz o estado de prod com um stub de assinatura idêntica **antes** do
   apply, e a postcondição então mede o que a migration faz com ele — provando que
   `CREATE OR REPLACE` **preserva** o ACL.
3. **Espiona o push em vez de simulá-lo.** `_data_health_episodio` é stubado para **registrar a
   chamada** e devolver `true`. O assert prova o que importa (o watchdog roteou o source novo) sem
   depender da semântica de dedupe do episódio real, que não está sob prova.

**O teste de message tem dois lados, e só um deles é óbvio.** "A message é estável" sozinho é
satisfeito por uma message **constante**, que não avisaria ninguém — por isso o par: ela congela
enquanto o problema é o mesmo e **muda** quando um 2º estágio quebra (aí re-emitir é o certo). As
duas metades têm sabotagem própria (`message_com_idade` e `message_constante`).

**A falsificação pegou um assert sem dente** — e esse é o registro que vale. O assert de "message
estável" ficava **verde** sob a sabotagem `message_com_idade` (hora corrida na message) sempre que
as duas leituras caíam no mesmo segundo: ele passava por coincidência de relógio. "Idade variável"
tem duas escalas, e o assert só cobria uma. O dente veio de variar as duas entre as leituras — o
**dado** envelhece 3h (pega idade em horas/dias) e o **relógio** anda >1s (pega `HH24:MI:SS`).

A postcondição embutida também pegou um erro real antes de qualquer apply: eu assumira que o compute
tinha 21 checks. Tem **29** — 21 é o tamanho do `v_sources`, isto é, quantos o watchdog **avalia**.
O compute produz mais checks do que o push avalia; os de fora são dashboard-only.

## Regras que este PR deixa

- **Sensor de coisa que roda sozinha vigia catálogo, não janela.** Janela de atividade recente é
  fail-open no tempo: apaga o alerta do que ficou quebrado tempo demais e é cega ao que nunca rodou.
- **`checks_falhos` do watchdog conta exceção, não status.** Ler esse campo como saúde é ler
  ausência de dado como aprovação.
- **Alerta que nasce vermelho por fóssil é alerta morto.** Antes de incluir uma chave na vigilância,
  meça se o estado atual dela é verde; se não for e ninguém for consertar, ela é dispensada — com o
  motivo escrito ao lado, não omitida.
