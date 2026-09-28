# As duas provas tint apodrecidas — o alvo tinha envelhecido, não o ambiente

**2026-09-27.** Das 19 provas `db/test-tint-*.sh` medidas no runner pelo
[#2605](provas-tint-no-nucleo.md), duas ficaram de fora do núcleo por reprovarem contra o
`schema-snapshot.sql` de hoje em qualquer plataforma:

- `test-tint-cobertura-lista-email.sh` morria no E2E via watchdog com
  `materialized view "customer_metrics_mv" has not been populated`;
- `test-tint-vigia-cobertura.sh` morria no setup: o stub de
  `_vendas_familia_ausente_lista_email(int)` colidia com a função real que o snapshot já traz
  (`cannot change name of input parameter "p_limit"`).

Resultado: as duas entram no eixo `sensores`, com `--falsificar` rodando no CI (13 + 6
sabotagens), medindo a versão do trio de data-health que **produção executa**.

## Os dois sintomas escondiam um defeito de alvo

O conserto óbvio — popular a MV, apagar o stub — deixava as duas verdes e erradas. Ambas aplicavam
as migrations da SUA fase por cima do snapshot de setembro: a vigia, a `20260611210000` + a
`20260615130000` (junho); a lista-email, a `20260708210000` (julho). Um `CREATE OR REPLACE` antigo
REVERTE, no banco de teste, tudo o que veio depois ([database.md §3](../agent/database.md)). Os
cenários mediam um watchdog de 17 fontes com `INSERT` direto, e o que roda tem 22 fontes, dead-man,
estado persistido e emissão por episódio com anti-flap. É a oitava da família "o HARNESS mente"
([money-path.md](../agent/money-path.md)): VERSÃO COBERTA ≠ VERSÃO ENTREGUE.

Duas consequências concretas, que só aparecem executando o corpo vivo:

1. **A falsificação antiga da lista-email passaria por vacuidade.** Ela dispensava o alerta, sabotava
   o watchdog e rodava de novo, esperando "e-mail sem a lista". No corpo vivo o
   `_data_health_episodio` não re-enfileira e-mail de episódio dispensado há menos de 2h: não sai
   e-mail nenhum, sabotado ou não, e "nenhum e-mail com a lista" fica verde sem provar nada. O
   restore, por sua vez, reprovaria.
2. **Os negativos da vigia passariam por vacuidade.** O watchdog vivo ENGOLE a falha do compute
   (`BEGIN … EXCEPTION`) e só deixa de avaliar. Com a MV vazia, "o B não entra em `fin_alertas`"
   fica verde porque nada entra. A prova agora exige, antes de cada negativo, que a rodada que
   acabou de rodar tenha sido COMPLETA (`last_success_at >= last_run_at`, `checks_falhos = 0`).

## "Versão viva" foi medida, não presumida

Via `psql-ro`, `md5(pg_get_functiondef())` das 6 funções envolvidas em prod × reconstrução local:

| reconstrução | compute | watchdog | heartbeat | episódio | 2 helpers de lista |
|---|---|---|---|---|---|
| snapshot sozinho (05/09) | ≠ | ≠ | ≠ | = | = |
| + MV + ACL + `0918 → 0920a → 0920b → 0922` | = | = | = | = | = |

O snapshot é gerado com `--no-privileges`, então toda função nasce executável por `PUBLIC`, e a
pós-condição da `20260918200000` (compute fechado para `anon`/`PUBLIC`) reprova. O ACL medido em
prod é reproduzido antes do apply, o mesmo idioma de `test-data-health-sync-reprocess.sh`.

## O desenho: `db/lib/data-health-vivo.sh`

- **Cadeia DINÂMICA.** A partir de `20260918200000`, entra toda migration que redefine uma função
  guardada (`CREATE/ALTER/DROP FUNCTION`). Lista fixa apodreceria do mesmo jeito na próxima reescrita
  do trio, que acontece quase toda semana. Um tripwire que reprovasse até alguém atualizar a lista
  deixaria a main vermelha para todo PR numa corrida de merge. Com a cadeia dinâmica, a migration
  nova é exercida sozinha, e só reprova se quebrar as invariantes tint ou não aplicar sobre o
  snapshot, que são sinais reais. Limite: a seleção é textual, e a substituição programática
  (`EXECUTE replace(pg_get_functiondef(...))`) escapa dela.
- **Banco-base + clones.** O snapshot sobe uma vez e cada rodada (controle e cada sabotagem) roda
  num `CREATE DATABASE … TEMPLATE`, sem herdar histórico da outra, o que importa por causa do
  anti-flap.
- **Sabotagem com alvo, no idioma do `falsificar-exige-assert`.** Cada uma troca um trecho do corpo
  VIVO (âncora única, conferida; md5 tem de mudar) e se declara em `SABOTAGENS` como
  `nome:VERMELHOS:VERDES`: o assert que tem de ir de verde no controle a vermelho na rodada, e as
  pré-condições que têm de seguir verdes. Rodada que não aplicou, que executou menos asserts que o
  controle, ou cujo vermelho é ERRO de execução é falha, não dente
  ([falsificacao-exit-nao-e-dente.md](falsificacao-exit-nao-e-dente.md)). O gate entrou na main
  durante este trabalho; as duas provas o adotaram limpas, sem pedir juiz.
- **A cadeia dinâmica também é falsificada.** `migracao_nova_*` escreve uma migration 2999… com o
  watchdog vivo regredido e reaplica a cadeia de um diretório que a contém. Isso prova que a
  regressão que chegar pela PRÓXIMA reescrita do trio fica vermelha.

## Medição (runner `ubuntu-latest`, ambiente do `provas-sql`, 2 rodadas)

Workflow temporário com os steps de instalação copiados do job (PG17 do PGDG + pgvector, sonda da
extensão, locale pt_BR), removido antes do PR:

| execução | r1 | r2 |
|---|---|---|
| vigia, modo normal | `PASS=30  FAIL=0` · 5s | `PASS=30  FAIL=0` · 5s |
| vigia `--falsificar` em C / em pt_BR.UTF-8 | `SABOTAGENS: 13 vermelhas / 0 falhas` · 23s / 22s | 13/0 · 20s / 18s |
| lista-email, modo normal | `PASS=22  FAIL=0` · 5s | `PASS=22  FAIL=0` · 4s |
| lista-email `--falsificar` em C / em pt_BR.UTF-8 | `SABOTAGENS: 6 vermelhas / 0 falhas` · 12s / 13s | 6/0 · 11s / 10s |
| núcleo de antes (39 provas + 6 falsificações) | 331s | 289s |

As 19 sabotagens ficaram vermelhas NO assert-alvo, com as pré-condições verdes. As provas fixam
`LC_ALL=C`, e o servidor nasce com `--locale=C`: a rodada em pt_BR prova que o locale de fora não
vaza, não que a asserção muda com ele.

**2ª medição, com o manifesto final** (depois do merge com a main, que trouxe a `fase5-watchdog` e o
gate `falsificar-exige-assert`, e com as falsificações no idioma dele): os mesmos recibos nas duas
rodadas (30/0 e 13/0; 22/0 e 6/0, em C e em pt_BR) e o núcleo inteiro em
`SQL_PROOF_OK provas=43/43 falsificacoes=9/9 fora_do_ci=0`, em **379s e 373s**. Dentro dele as duas
somam ~30s (3–4s + 16s; 3s + 7s). Com o setup e a falsificação do runner, o `provas-sql` fica em ~7,5
min: a folga até o `timeout-minutes: 12` cai de ~1,8× para ~1,6×.

## Achado lateral

`test-data-health-sync-reprocess.sh`, já no núcleo, aplica `0918 → 0920a → 0920b` e para: o compute
que ela cobre (md5 `f0eecc…`) não é o de prod (`4cc51b…`, da `20260922225500`). É a mesma classe,
dentro do núcleo. O conserto de 2026-09-27 no JUIZ dela (exit≠0 não é dente) não toca nisso: o alvo
segue velho. Fica como tarefa com dono (chip "Levar a prova sync-reprocess ao compute que prod
executa"), não consertada aqui.

## Lições

1. **Prova que re-aplica a migration da SUA fase sobre um snapshot mais novo mede a versão
   revertida.** Consertar o sintoma (MV, stub) a deixa verde e errada. Monte o corpo vivo e confira
   por md5 contra prod.
2. **No corpo que engole erro, negativo sem pré-condição positiva é vacuidade.** "B não entrou" só
   vale depois de "a rodada avaliou tudo".
3. **Reescrever o alvo muda o que a falsificação precisa.** O anti-flap tornou a sabotagem antiga
   vacuamente verde. Sabotagem sem controle no MESMO estado de partida não prova dente.
