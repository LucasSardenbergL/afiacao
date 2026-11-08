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

## Próximos da fila

`radar-contato-integridade` (~65 s; mais ~105 s em espera de relógio real, com risco), `sayerlack-situacao-portal`
(~85 s), `radar-acesso-vendedor`, `tint-promocao-assincrona`, `radar-socios-cpf`, `radar-placar` e
`tint-promote-latest-indexado` (~40–55 s cada). A receita é a mesma.
