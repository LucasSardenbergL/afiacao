# Provas SQL: a `radar-privacidade-j --falsificar` em 2 faixas, e por que a `hoje-sp` ficou como está (2026-11-11)

Continuação de `ci-provas-sql-venda-repasse-faixas.md`. Depois do #3836, as maiores unidades do `provas-sql`
(16 partes × 3 workers) eram duas falsificações de ~290 s: `test-radar-privacidade-j --falsificar` (pool, 27
sabotagens) e `test-hoje-sp-views-defaults --falsificar` (faixa SERIAL, 33 sabotagens).

## radar-privacidade-j: sem medição sem teto, só volume

- **Procurei o equivalente ao PERF da venda-repasse** (query sabotada sem `statement_timeout`, `\timing`,
  EXPLAIN ANALYZE): não há. O único `auto_explain` lê o plano do expurgo numa base pequena, e não depende
  da sabotagem.
- **A duração é uniforme:** o modo normal leva ~12 s local (initdb + cadeia de migrations + 46 asserts),
  e o `--falsificar` são 28 invocações disso (controle + 27). ~290 s no CI = 28 × ~10 s.
- **O que mudou:** o idioma da venda-repasse, sem diferença de contrato. `NUCLEO_FAIXA=i/k` roda o controle
  verde e a fatia canônica i de k, e emite `FAIXA: i/k sabotagens a-b de T`. T é contado por `wc -w`, sem
  um 2º laço sobre a lista (R2 do `falsificar-exige-assert`). O `LOGDIR` já é um `mktemp` por invocação,
  então as 2 faixas rodando juntas não disputam log, e não precisam de sufixo. Manifesto: `faixas=2`
  (1–13 e 14–27).

## hoje-sp: não partida — decisão registrada

`faixas=2` sozinho não ganha nada nela: a prova é SERIAL (`barra()` usa `lock_timeout=1500`), a partição é
por prova, e as 2 faixas rodariam na mesma parte, uma depois da outra.

Conta da partição (custo atual, serial × W + pool/W + cauda): carga ≈ 3806 s, média ≈ 238 s por parte. A
`hoje-sp` (309 s) fica ~70 s acima da média sozinha, então é piso real.

Propus a partição por BLOCO (prova com `faixas=k` vira k blocos, cada um atribuído a uma parte; a união
confere cada identidade `(prova, modo)` na parte do seu bloco) e levei ao `/codex` (gpt-6-astra, high,
128 s). Veredito: **não mudar a partição agora.**

- O ganho é hipótese: `custo/k` ignora o controle extra de cada faixa (~25 s), e o LPT não garante blocos
  irmãos em partes distintas (na simulação dele, os 2 da venda-repasse ficaram juntos).
- Há uma alavanca local mais barata, para medir antes: as sondas K1 e K2 da `hoje-sp` fazem duas esperas
  SEGUIDAS de 1,5 s com a mesma sessão A aberta, sobre objetos distintos. Em paralelo (2 sessões B), cada
  invocação poupa ~1,5 s; × 35 invocações ≈ 50 s. Mexe no mecanismo do assert, então é entrega à parte.
- Se K1/K2 não entregar, a partição por bloco volta à mesa, com os casos de harness que ele pediu além dos
  meus: bloco omitido pelo atribuidor, controles positivos com blocos separados e reunidos em N=1, e o §4
  exigindo igualdade exata localmente.

**Furo teórico apontado pelo Codex (não fechado aqui):** o runner confere a fatia de cada faixa contra o T
que a PRÓPRIA faixa declara. Se `1/2` declarasse T=33 (1–16) e `2/2` T=35 (18–35), as duas passariam e a
sabotagem 17 sumiria. Hoje não acontece: nas duas provas com faixas, T é `wc -w` de um literal estático. Exigir
o mesmo T entre as faixas é estender o gate; fica para quando houver uma prova com lista condicional.

## Medido local

- Runner com o manifesto só da prova, `NUCLEO_WORKERS=3` (M2 disputado, load ~15): normal 12 s, `--falsificar 1/2`
  13 sabotagens em 167 s, `2/2` 14 em 192 s, cada uma com o seu controle verde; `SQL_PROOF_OK provas=1/1
  falsificacoes=2/2`, exit 0.

## hoje-sp: K1/K2 em paralelo — entregue (#3867, 2026-11-12)

A alavanca local que o `/codex` pediu para medir antes da partição por bloco.

- **O que mudou:** cada uma das sondas K1 (`fin_aging_pagar`) e K2 (`priority_score_log`) roda numa sessão B
  própria, ao mesmo tempo, contra a mesma A parada no fim da pré-condição. As duas esperas de
  `lock_timeout=1500` correm juntas. Fica igual: os dois `eq`, os dois timeouts, a marca de cada um
  (`BARROU`, `PASSOU`, ou o erro como VALOR, que vira `ERRO_DE_EXECUCAO`) e as sabotagens `sem_trava:K1,K2` e
  `trava_na_ordem_errada:K3:K1,K2`. Cada sonda escreve no seu arquivo, e o assert lê depois do `wait`.
- **JIT conferido antes:** com `auto_explain`, o maior custo estimado de plano da prova é 36.793, abaixo do
  `jit_above_cost` (100.000). O JIT não dispara, então `jit=off` não seria alavanca aqui, ao contrário da
  `tint-corante-giro`.
- **Medido no CI** (run 43198804946, 16 × 3): `--falsificar` 232 s (era ~303), normal 7 s, ou seja 239 s
  contra 309 na tabela. O ganho de ~70 s supera a estimativa de ~50 s (1,5 s × 34 invocações, mais o ruído).
  Local, a falsificação inteira deu 33/33 vermelhas, com o controle verde.
- **Já não é o piso.** Maiores unidades nesse run: `rls-has-role-initplan-classe` NORMAL 279 s (a tabela
  diz 218), `cliente-sucessao-plano --falsificar` 264 s, `venda-repasse 2/2` 236 s, e só depois a `hoje-sp`.
  A `sayerlack-cancelado-com-compra-viva --falsificar` deu 187 s e não virou a pior, então não foi partida.
  A pior PARTE (11, 348 s) é carga do pool, sem unidade acima de 165 s. Com a tabela atualizada, a
  partição reequilibra. A partição por bloco sai da mesa enquanto nenhuma prova serial for o piso.
