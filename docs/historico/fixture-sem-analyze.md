# O custo era o plano, não o universo — a fase5-watchdog e o fixture sem ANALYZE

**2026-09-27.** `db/test-tint-fase5-watchdog.sh` (a prova de `tint_watchdog_fase5_check`, migration
`20260730120000`) ficou fora do núcleo no #2605 por custar **185s e 252s** no runner, mais que o
núcleo inteiro de antes. O motivo declarado no manifesto: *"universo de ~464 mil chaves × 17
execuções do watchdog × (controle + 4 sabotagens)"*, com a entrada condicionada a **encolher o
universo**. Medido no runner, o motivo estava errado nas três parcelas.

## O "universo de 464 mil" era um número da asserção

`463995` é a baseline de PROD (psql-ro, 2026-07-28) que a migration grava como **literal** em
`sync_state.metadata.universo_max`, e é ela que a B15b confere. O seed da prova monta **4 + 1.000
chaves**. E 1.000 já é o piso: o B5 afirma `v_s1 >= 1000 -> critico`, limiar **absoluto** na
migration. Não havia universo para encolher sem semear um lote só para o B5 e removê-lo depois —
complexidade para atacar um custo que não estava ali.

## O custo era o plano da view sem estatística

A view `v_tint_formula_canonica` é correlacionada por fórmula (`EXISTS` nos itens, `max()` pela
chave, `NOT EXISTS` com LATERAL por gêmea), e o fixture não tinha estatística nenhuma: sem
`ANALYZE`, o planner não conhece tamanho nem distinção das chaves e resolve tudo em laço aninhado.
Custo de UMA varredura no runner (mediana, ms):

MEDIDAS_ESCALA_AQUI

Sem estatística, o custo cresce ~N^2,75; com `ANALYZE`, fica em milissegundos em qualquer N medido.
Os índices que a prod tem e o fixture não (`UNIQUE (formula_id, corante_id)` nos itens e
`(account, sku_id, cor_id)` nas fórmulas) também resolvem, mas o `ANALYZE` basta e não mexe no DDL
do fixture.

## E o tempo dependia de quando o autovacuum acordava

A prova instrumentada (cada execução do watchdog, cada psql, cada suíte) mostra que o custo NÃO
se distribui pelas 6 × 20 execuções do watchdog:

MEDIDAS_INSTRUMENTADA_AQUI

As primeiras execuções pagam o plano ruim; depois que o autovacuum analisa as tabelas (o
`naptime` é 60s), as seguintes caem para milissegundos. A diferença entre 185s e 252s era o
sorteio de QUANDO isso acontecia.

## O B14 parava o relógio 6s por suíte

`pg_sleep(6)` numa sessão em background + `sleep 2` antes do `roda`, e um `wait` pela sessão. São
~6s por suíte × 6 suítes. Pior: era um palpite. Uma sessão que levasse mais de 2s para pegar o
lock deixava o B14 medir o watchdog SEM contenção.

Agora a sessão segura o lock até ser encerrada (`pg_terminate_backend` pelo `application_name`), e
as duas esperas são POSITIVAS e com teto: o `pg_locks` tem de mostrar a chave do watchdog com
OUTRA sessão antes do `roda`, e livre depois. Como o mecanismo mudou, entrou a sabotagem **F5**
(tira a anti-sobreposição da função e exige `{B14}` vermelho): sem ela, nada provaria que o B14
novo ainda morde.

## Resultado

MEDIDAS_RESULTADO_AQUI

## Lições

1. **Número copiado de uma asserção não é medida do fixture.** O 463.995 estava no arquivo, e
   virou "o universo" por leitura. O inventário do fixture é o seed, e o seed é que se mede.
2. **Fixture de prova SQL com volume leva `ANALYZE` depois do seed.** Sem estatística o plano de
   uma view correlacionada vira laço aninhado, o custo fica super-linear em N e o tempo passa a
   depender do autovacuum, que é um sorteio. Em prod as tabelas são analisadas; o fixture sem
   `ANALYZE` mede um plano que a prod nunca executa.
3. **`sleep N` em prova é palpite duas vezes**: custa N sempre, e erra quando o ambiente demora
   mais que N. Espera em prova é positiva e com teto
   ([espera-sem-desistencia.md](espera-sem-desistencia.md)).
