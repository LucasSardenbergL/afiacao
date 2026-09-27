# As provas tint no núcleo do CI — o pgvector era 1 de 4 camadas

**2026-09-27.** A entrega da promoção assíncrona do tint (migration `20260925210000`) deixou
`db/test-tint-promocao-assincrona.sh` já no contrato do núcleo, mas fora de `db/nucleo-ci.txt`, com
o motivo declarado no cabeçalho: carrega o `schema-snapshot.sql` inteiro, cujo prelude faz
`CREATE EXTENSION vector`, e o job `provas-sql` instalava só o `postgresql-17`. Nenhuma das 19
provas `db/test-tint-*.sh` barrava merge.

Resultado: **16 das 19 entraram** (as da promoção nos dois modos), o job instala o pgvector, e 3
ficaram de fora com o motivo escrito no próprio manifesto.

## O motivo declarado era 1 de 4 camadas

Rodando as 19 **no runner** (workflow temporário com o ambiente do job, 2 rodadas em paralelo),
o pgvector era a camada menor:

| camada | provas | conserto |
|---|---|---|
| `PGBIN` fixo no Homebrew — só rodavam no macOS, com ou sem pgvector | 18 de 19 | port mecânico para `db/lib/pg-harness.sh` + `PORT="${PGPORT_TEST:-…}"`, sem mudar asserção |
| snapshot inteiro → `CREATE EXTENSION vector` | 13 de 19 | `postgresql-17-pgvector` na MESMA chamada do `apt-get install` + step que confere que o servidor carrega a extensão |
| recibo fora do formato do runner (`RESULTADO: n ✅ · m ❌`, `✅ n ❌ m`, `n ok / m falhas`, ou nenhum) | 7 de 19 | linha `PASS=<n>  FAIL=<m>` ao lado do resumo que já existia |
| apodrecidas contra o snapshot de hoje (reprovam em qualquer plataforma) | 2 de 19 | fora; consertar antes de entrar |

Uma prova sem recibo reconhecível sai do runner como "exit 0 sem contagem" e reprova. Sete caíam
nisso sem ninguém ver, porque nenhum runner as lia. A `test-tint-promote.sh` é fail-fast: a
asserção é `RAISE` em SQL sob `ON_ERROR_STOP`, então o recibo dela conta os 24 checkpoints
ALCANÇADOS, com `FAIL=0` por construção. Truncar a prova, ou pôr um `exit 0` no meio, derruba a
contagem abaixo do mínimo.

## Medição (runner `ubuntu-latest`, rodadas 1 e 2)

| item | r1 | r2 |
|---|---|---|
| apt: fontes + update | 8,3s | 6,4s |
| apt install `postgresql-17` | 6,1s | 6,6s |
| apt install pgvector (isolado para medir) | 3,0s | 2,4s |
| sonda do pgvector (initdb + `CREATE EXTENSION`) | 2,4s | 1,0s |
| núcleo de antes (22 provas + 4 falsificações) | 126s | 151s |
| 16 provas tint, modo normal (soma) | ~48s | ~58s |
| `promocao-assincrona --falsificar` em C / em pt_BR.UTF-8 (12/12 nos dois) | 71s / 71s | 86s / 86s |
| `fase5-watchdog` (ficou fora) | 185s | 252s |

No runner o snapshot inteiro sobe em 1–2s: a `tombstone-fase5` leva 2,9s de ponta a ponta. No
laptop em swap, a mesma carga levava ~35s. É mais uma medição de que o laptop não projeta o
runner ([falsificacao-fora-do-ci.md](falsificacao-fora-do-ci.md)).

**Ensaio do job final** (cópia fiel do `provas-sql` novo, gerada do `ci.yml` por parser, 2 rodadas):
`SQL_PROOF_OK provas=38/38 falsificacoes=5/5`, `HARNESS_NUCLEO_OK casos=39`,
`PGVECTOR_OK versao=0.8.6`. Todo recibo tint bateu exatamente com o mínimo do manifesto. Job
inteiro: **399s e 320s** (núcleo 325s e 255s).

## O orçamento que importa não é o teto do job

Linha de base pela API do Actions, 34 runs de PR: `provas-sql` p50 205s, p90 223s, máx 250s.
O `validate` espera o `gates-e-falsificacao`, que tem p50 955s e mínimo 810s. O comentário do
`ci.yml` ainda dizia 357s, número de 09-07. Depois da entrada, o `provas-sql` fica em ~5–7 min:
1,8× de folga no pior ensaio até o `timeout-minutes: 12`, e abaixo da metade do caminho crítico.
O merge não fica mais lento.

A `fase5-watchdog` levaria o job a ~10 min. Isso exigiria subir o teto e custaria ~4 min de
runner por PR. O precedente manda medir de onde vem o custo antes de dizer "não cabe", e foi
medido: é de **fixture**. A prova monta um universo de ~464 mil chaves e roda o watchdog 17 vezes
sobre ele, no controle e em cada uma das 4 sabotagens. Ela entra quando o universo encolher
preservando os limiares.

## As duas apodrecidas

- `test-tint-cobertura-lista-email.sh`: o `_data_health_compute` do snapshot de hoje lê a
  `customer_metrics_mv`, que a prova não popula. O E2E via watchdog morre com
  `materialized view "customer_metrics_mv" has not been populated`.
- `test-tint-vigia-cobertura.sh`: o stub de `_vendas_familia_ausente_lista_email(int)` colide com
  a função real que o snapshot já traz (`cannot change name of input parameter "p_limit"`).

É a mesma classe dos harnesses de data-health que apodreceram fora do caminho do merge. Prova
que nenhum gate executa envelhece junto com o snapshot, sem ninguém ver.

## Janela de relógio: triagem estática

Entrar no núcleo transforma uma janela de relógio latente em bloqueio de merge, como no #2583. Nas
16 provas não há construção de calendário no texto (`current_date`, `date_trunc`, `::date`,
`extract(hour…)`, `AT TIME ZONE`, `date +%…`). Nas funções sob teste, essas construções só
aparecem na formatação da mensagem do alerta (`date_trunc('minute', …)`, `to_char(… AT TIME
ZONE …)`). A decisão usa intervalo relativo ao `now()` do próprio banco. **Limite:** a triagem é
estática, e o injetor de relógio simulado de
[provas-janela-de-relogio-fora-do-nucleo.md](provas-janela-de-relogio-fora-do-nucleo.md) não rodou
nelas. A `promocao-assincrona`, que tem concorrência e sleeps, rodou 6 vezes no runner sem flake.

## O lab do retry acompanhou o step

O pgvector entrou na chamada do `apt-get install` que o retry já cobre, então continuam sendo três
camadas de rede. O rótulo mudou para `apt-get install postgresql-17 + pgvector`, e com ele os
marcadores C3/C7 de `scripts/lab-retry-pgdg/lab.sh` e a âncora S4 do `falsifica.sh`. O lab segue
em 29/29 e a falsificação em 12/12. A sonda que CARREGA a extensão ficou num step próprio, porque o
texto do step de install roda no lab com dublês e lá não há servidor para perguntar.

## Lições

1. **O motivo que uma prova declara para estar fora do CI é hipótese, não inventário.** Aqui ele
   era 1 de 4 camadas, e a maior nem era citada. Antes de "instalar X no job", rode o candidato
   NO RUNNER.
2. **Recibo que o runner não casa vale o mesmo que recibo nenhum.** Formato humano bonito
   (`✅ 37 ❌ 0`) não é contrato. O contrato é `PASS=<n>  FAIL=<m>`.
3. **Prova fora do caminho do merge apodrece.** 2 de 19 já estavam vermelhas contra o snapshot de
   hoje, e ninguém sabia.
