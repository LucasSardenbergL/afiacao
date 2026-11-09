# Provas SQL: espera fixa vira espera por condição (2026-11-07)

Continuação de [ci-provas-sql-durabilidade-off.md](ci-provas-sql-durabilidade-off.md) (#3721: fsync=off + tabela de custo re-medida), item (e) da fase 1.
Precedente: [ci-e17-radar-espera-por-bloqueio.md](ci-e17-radar-espera-por-bloqueio.md) (360 → 69 s).

## Levantamento

Varredura de `sleep`/`pg_sleep` nas 193 provas do `db/nucleo-ci.txt`: 49 têm algum. A maioria já espera
por condição (polling com teto) ou usa `pg_sleep` longo como retentor que é encerrado ao observar. Sobram
~950 s de espera FIXA somada por run completo (cada `--falsificar` re-executa a suíte por sabotagem). Quatro
provas concentram ~580 s; são as deste lote.

## O que mudou

| prova | antes | agora |
|---|---|---|
| `radar-score` (A17) | A segura o row-lock com `pg_sleep(8)` | A solta ao ver B em `Lock`; teto de 8 s; o assert exige `espera=sim`, dito pela própria A |
| `radar-cadastro-omie-idempotente` (A5a–f) | A segura 2 s, 5×; a sabotagem `sem_trava` pagava o teto de 10 s, 5× | `segura_ate_ver_bloqueio`, cópia da irmã `radar-cadastro-conflitos`; `sem_trava` sai em `nao` na hora |
| `cliente-sucessoes` (J1–J2) | s1 segura 1,5 s, 2× | s1 solta ao ver s2 em `Lock`; teto de 1,5 s |
| `cliente-sucessao-plano` (CL1, CC1) | trava segura 3 s depois do assert; stub do cálculo dorme 2 s | trava encerrada (`pg_terminate_backend`) depois do CL1; o stub espera a bandeira que o shell levanta depois do cadastro no meio, teto de 2 s |

Nenhum assert e nenhuma sabotagem saiu. Onde B não bloqueia (sabotagem), A sai no mesmo teto de antes.

**Armadilha encontrada (`cliente-sucessoes`):** a sessão que segura roda sob `SET ROLE authenticated`, e
nesse papel o `pg_stat_activity` esconde a `query` das outras sessões. O laço nunca via B e sempre saía no
teto: a prova ficava verde, sem ganho nenhum. Só a medição velha × nova (10,5 s × 11,0) mostrou. Conserto:
`RESET ROLE` antes do laço (depois dele só vem o `COMMIT`). Quem converter outra prova: confira o tempo, não só o verde.

## Medição

Local (Mac, 1 passagem normal): `cliente-sucessoes` 10,5 → 8,3 s, `cliente-sucessao-plano` 16,3 → 11,6 s,
`radar-score` 3 s. `--falsificar` nos dois locales (`C` e `pt_BR.UTF-8`), todas as sabotagens vermelhas no
assert declarado: radar-score 17/17, omie-idempotente 10/10, cliente-sucessoes 35/35, cliente-sucessao-plano 38/38 (inclusive `drenar_trava_propria`→CL1, `drenar_com_grafo`→CC1 e `drenar_assinatura_depois`→CC2).

CI (run 42442800702 contra o do #3721, normal + `--falsificar`): radar-score 164 → 22 s, omie-idempotente
142 → 27, cliente-sucessoes 194 → 78, cliente-sucessao-plano 362 → 182 — **862 → 309 s (−64%)**. A pior
parte do `provas-sql` foi de 21 para 18 min, mas desequilibrada: as partes com essas provas fecharam em
13 min, porque a tabela de custo ainda tinha os pesos velhos. Re-pesadas no PR seguinte (só essas 4 linhas).

## Lote 2 (2026-11-08)

A receita virou helper em `db/lib/pg-harness.sh`:
- `pgh_segura_sql APP_B N TETO [CONDIÇÃO]` é o bloco que a sessão A roda segurando a trava. Ela segura até ver N sessões `APP_B%` em `Lock` (e a CONDIÇÃO, se dada), ou até as B saírem sem esperar, ou até o TETO, que é o sleep antigo. Na saída, A grava quantas viu em `pg_temp.pgh_espera`. O helper já faz o `RESET ROLE` da armadilha do lote 1.
- `pgh_espera_segurar APP_A PID_A CMD…` troca o `sleep 0.3..0.7` entre lançar A e lançar B: espera A entrar no laço, com teto de 5 s.

| prova | o que era fixo | agora |
|---|---|---|
| `radar-acesso-vendedor` | A `pg_sleep(1.5)`, shell `sleep 0.5` | A segura até B em Lock |
| `radar-socios-cpf` (P10) | A `pg_sleep(2)` | idem |
| `radar-placar` (A17) | A `pg_sleep(1.5)` | idem |
| `sayerlack-situacao-portal` | A `pg_sleep`, shell em laço de `pg_blocking_pids` | A segura e diz `VIU=1`; o assert "B esperou" lê a boca de A |
| `radar-contato-integridade` (C1, C4, D1, D3) | A `pg_sleep`, shell em `esperar_bloqueio` | idem, com `VIU=n` (C4 exige 2) |
| `tint-promocao-assincrona` (T4) | veneno `pg_sleep(3)` | veneno espera a bandeira `_t_solta`, teto 3 s; a prova a levanta depois do tick concorrente |

**Equivalência da parte D da contato** (a de risco, porque D afirma uma janela de tempo real): antes, A segurava a
trava o bastante para a janela de 300 s (D1) e de 120 s (D3) vencer no relógio do banco antes do desfazer ou registrar de B
seguir. Agora a CONDIÇÃO de A é `clock_timestamp() > created_at + 300,2 s` (ou 120,2 s), além de B em Lock. A só solta com
a janela já vencida, e B começou dentro dela. É o mesmo estado que o sleep produzia, só que sem a sobra.

**Fora do lote, de propósito:**
- `tint-promote-latest-indexado`: o `sleep 1` espera o flush das estatísticas do backend que saiu. Ler cedo dá delta MENOR, o teto (`cabe`) passaria e a prova ficaria com verde falso. Não há condição observável do flush sem tocar no que se prova.
- `tint-promocao-assincrona` X1 (`pg_sleep(2)`) e T3 (`statement_timeout` de 1 s): o tempo real é a premissa.

**Cobertura:** nenhum assert e nenhuma sabotagem saiu. As únicas linhas novas são o `VIU=n` (que substitui a observação do shell) e o
`j10` da D3. `--falsificar` em `LC_ALL=C` e `pt_BR.UTF-8`, todas vermelhas no assert declarado, controle verde:
acesso-vendedor 16/16, socios-cpf 19/19, placar 25/25, sayerlack 13/13, contato-integridade 19/19, tint 12/12.

**Local** (Mac, passagem normal, antes → depois): acesso-vendedor 9 → 7,3 s, socios-cpf 6 → 4,0, placar 6,1 → 4,2,
tint 18,0 → 13,5, sayerlack 10 → 5,8, contato-integridade 13 → 10,9.

**CI** (run 42487970899 do #3743 contra os pesos da tabela, normal + `--falsificar`): acesso-vendedor 84 → 27 s,
contato-integridade 200 → 87, placar 84 → 42, socios-cpf 92 → 48, sayerlack 120 → 24, tint 94 → 59: **674 → 287 s (−57%)**.
As 6 linhas de `db/nucleo-ci-custo.txt` foram re-pesadas no próprio PR, antes de sair do draft, para não repetir o
desequilíbrio do lote 1.

## Próximos da fila

Não sobra espera fixa óbvia nas provas caras do núcleo. A `tint-promote-latest-indexado` fica como está, pelo motivo acima.
Prova nova com corrida entre duas sessões deve nascer com `pgh_segura_sql`.
