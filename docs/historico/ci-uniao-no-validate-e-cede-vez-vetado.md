# CI: a união das partes do `provas-sql` vira step do `validate`, e a espera do pós-merge é vetada (2026-11-12)

**Substrato:** `.github/workflows/ci.yml`, `scripts/provas-sql-escopo.ts` e 3 testes · **Sem banco, sem Publish, sem edge.**

Programa "push→merge mais rápido", parte grátis. A sessão recebeu duas mudanças. Uma entrou e a outra foi vetada
pela 2ª opinião.

## 1. União dentro do `validate` — FEITO

**Antes.** Depois da última parte `provas-sql (k)`, o job `provas-sql-uniao` (~16–21 s de trabalho) pedia um
runner próprio, e só então o `validate` pedia outro.

**Linha de base** (40 runs de PR verdes com SQL, 11/11 11:37Z → 12/11 03:39Z, API do Actions):

| métrica | p50 | p90 | máx |
|---|---|---|---|
| push → `validate` concluído | 834 s | 1.272 s | 2.623 s |
| fim da última parte → início do `validate` | 27 s | 81 s | 231 s |
| fila da união (fim das partes → início dela) | 4 s | 39 s | 117 s |

**Mudança.** Os steps da união (partes `success`?, checkout, download dos recibos, `db/roda-nucleo-ci.sh --uniao`
e recibo do harness) passam a ser os primeiros steps do `validate`, com a mesma condição de antes. O `outcome` do
step entra no agregador como o job virtual `provas-sql-uniao`, de modo que o denominador (13), a guarda nominal e
a regra "skipped só com o escopo justificando" ficam idênticos. A chave voltar a `needs` reprova.

- **Sem `continue-on-error`.** O censo do `exclusividade-gate` (`bloqueantesOpacos`) lê `continue-on-error`
  como step não-bloqueante, e a união sumiria do contador. A primeira versão o usava, e o teste
  `exclusividade-gate.test.ts` pegou isso. Agora a união vermelha reprova o job na hora, e o agregador
  (`if: !cancelled()`) roda mesmo assim, só para mostrar a tabela.
- **Ajuste do Codex.** Partes `success` exigem união `success`, mesmo com o escopo dizendo que pulou. A
  inferência dos leitores abaixo virou invariante, em vez de depender da coerência entre os `if:`.
- **Leitores pela API de runs antigos.** `provasVerdes` (E14) e `recibo_confere` (modo recibo do PR) aceitam o
  job legado `provas-sql-uniao` em `success`. Sem ele, aceitam `validate` em `success` mais todas as partes em
  `success`. O legado, quando existe, decide sozinho. Isto é mais estrito que antes, porque o `validate` exige
  também os jobs não-SQL: perde-se reaproveitamento quando um gate não-SQL falhou com as provas verdes. É o lado
  seguro. O Codex vetou ler o `conclusion` do step pela API: com `continue-on-error`, ele sai `success` mesmo
  com a união vermelha.

**Falsificação da fiação** (scratch `falsifica-uniao-validate.sh`, sem commit). Ela executa os 3 steps reais
extraídos do `ci.yml`, sobre recibos reais gerados por `roda-nucleo-ci.sh` com provas falsas. O controle verde
roda na mesma invocação e aborta se não sair verde. Resultado: 9/9 em `LC_ALL=C` e em `pt_BR.UTF-8`. O agregador
reprova (exit 1) em 8 casos: parte sem recibo, unidade (faixa) sem conclusão, parte duplicada, sem recibo do
harness, harness abaixo do piso, partes `failure`, partes `cancelled` e recibos que não baixaram. A sabotagem da
fiação (agregador que ignora o `UNIAO`) faz o caso "parte sem recibo" passar, ou seja, o laço detecta a fiação.

**Ganho esperado.** Some o salto da união: fila p50 4 / p90 39 s mais ~18 s de execução. Fica a fila do próprio
`validate`. A ressalva do Codex: agora a união espera também os jobs não-SQL. Quando eles terminavam depois do
SQL, a união antiga rodava em paralelo. Por isso os 26–234 s não são economia garantida em todo run. A medição
depois do merge segue abaixo.

**Depois.** _a preencher com os runs de PR com SQL depois do merge (mesmo script `mede.sh`: `fim_partes_validate_ini`
e `push_validate`)._

## 2. "O CI da main cede a vez aos PRs" — VETADO (Codex), não implementado

**Desenho proposto.** Um job `cede-vez` na raiz do run de pós-merge (e do push do Lovable) que espera, com teto
de 15 min e fail-open, enquanto houver run de PR não concluído. Ele não cancela nada e não pula prova.

**Parecer** (`scripts/codex-async.sh`, gpt-6-astra high, 295 s, 130.137 tokens, modo desafio): **NÃO FAZER neste
desenho.** Os motivos:

1. **"Qualquer run de PR não concluído" é largo demais.** Um PR num job longo com slots livres, ou um
   `mutation-check` pós-validate, faz a main esperar sem reduzir contenção. Em rajada, todo pós-merge paga os
   15 min. A espera dá adiamento inicial, não prioridade contínua: um PR que chega depois da liberação disputa
   com os 20–37 jobs igual. `per_page=50` também não garante ver todos os ativos.
2. **Frescor da main sem garantia.** Cada run que começa pode pagar de novo o teto, e o run fica preso ao SHA
   antigo. Vários pushes diretos geram vários waiters, um por `run_id`. Um dispatch manual com teto 0 fica atrás
   do lock do grupo. "48 + 15 = 63 ≤ 65" pressupõe que a fila não muda, e é justamente ela que a mudança altera.
3. **E14 realimentado.** A base verde envelhece e acumula código, então menos runs pulam as provas, o que gera
   mais provas e mais slots. Pendentes coalescidos podem esgotar os 40 candidatos do `escolherBase`.
4. **Regressão no grafo.** Com um ancestral `skipped`, o `docs-gates` (cujo `if` não tem função de status)
   seria pulado num PR só de docs, e o `validate` reprovaria (actions/runner#2205). Não basta pôr `!cancelled()`
   só nas 4 raízes.
5. **O timeout do job não serve de fail-open.** A saída precisa vir de um deadline no script, com timeout por
   chamada HTTP.

**O análogo já simulado.** Adiar o trabalho do pós-merge é o mesmo eixo do `max-parallel` só no pós-merge
([ci-fila-actions-decisao-nao-mexer.md](ci-fila-actions-decisao-nao-mexer.md)). Com K=4, ele tirou 3–4% do p90 da
fila de PR e custou +16 a +23 min no veredito da main. Nada indica que esperar no início renda mais.

**Reabrir só com:** critério de contenção real (job de PR `queued`, não run em andamento), simulação com o E14
recalculado, e os critérios pré-registrados daquele doc (intervalo entre vereditos p90 ≤65 min, push→`validate`
p90 −10%). Também é preciso corrigir o `if` do `docs-gates` antes de pôr qualquer job acima das raízes.
