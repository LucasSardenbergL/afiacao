# CI: fail-fast das provas SQL e recibo no mesmo PR (fatias B+C, 2026-11-09)

Programa "merge de PR mais rápido sem perder qualidade". A medição do Fable (06–09/11, 236 runs de
PR) achou 33% do runner-min gasto em commits superados. Dois padrões dentro disso:

- 22 cancelamentos vinham de um push feito **depois de um vermelho real**. Nesses runs, as 5 partes
  do `provas-sql` (11–17 min cada) rodavam até o fim de um run que já estava reprovado.
- 17 vinham de pushes **só de docs** num PR cujas provas já tinham passado. Como o PR inteiro toca
  SQL, o escopo mandava rodar tudo de novo.

## B: fail-fast (`ci.yml`, job `fail-fast`)

- Só em `pull_request`. Espera os 5 jobs não-SQL: `typecheck`, `testes`, `edges-e-build`,
  `gates-e-falsificacao` e `falsificacao`. Todos terminam em ≤ 7 min.
- Se algum deles **falhou** (`failure()`; `cancelled` não conta), roda `gh run cancel` no próprio run.
  As partes de `provas-sql` que ainda rodam param.
- Espera os 5, e não só o primeiro vermelho, para o autor ver todas as falhas não-SQL antes do corte.
  A API não cancela um job sozinho: o cancelamento é do run inteiro.
- **O cancelamento nunca vira aprovação.** O gatilho é a falha de um job que o `validate` exige em
  `success`. O `validate` (`if: always()`) roda no run cancelado e reprova por esse job e pelas partes
  `cancelled`. Se o `validate` nem iniciar, o check fica ausente e o PR não mergeia.
- O `fail-fast` fica fora do `needs` do `validate`: no caso verde ele fica `skipped`, e isso não é
  veredito de nada.
- O pós-merge (dispatch do `auto-merge.yml`), o push e o cron não mudam.

## C: recibo das provas no MESMO PR (`scripts/provas-sql-escopo.ts`, bloco "Recibo do MESMO PR")

Todo run de PR passa a deixar no job de escopo a anotação `provas-sql-recibo`, com
`pr=N base=B head=H tree=T` do merge commit que testou.

Quando o diff do PR alcança as provas (`decidir` → roda), o escopo procura um run anterior do mesmo
PR que já provou a mesma coisa. Só reaproveita quando tudo isto vale:

1. **O run-recibo vem da API.** É da mesma branch, do mesmo repo (fork não reaproveita), concluído e
   diferente do run atual. O mais recente que EXECUTOU as provas decide: se ele ficou vermelho ou
   cancelado, não há recibo, sem atravessar até um verde mais velho. Nele, todas as partes
   `provas-sql (k)` e a `provas-sql-uniao` terminaram `success`.
2. **A anotação do recibo vem da API** (`check_run_url` do job de escopo). Ela é exatamente uma, do
   PR certo, com o `head` igual ao `head_sha` do run.
3. **A mesma base:**
   - H1 é ancestral de H2 e H1 ≠ H2;
   - não há merge commit em H1..H2 (merge da main ⇒ roda);
   - o merge-base com a main é o mesmo (rebase ⇒ roda);
   - B1 é ancestral de B2.
4. **A árvore provada é recalculada.** `git merge-tree --write-tree B1 H1` precisa bater com o `tree`
   registrado. Com isso, o diff entre essa árvore e a de agora é exato.
5. **Todo arquivo** desse diff e de diff(H1,H2) é inerte pelo mesmo `inerte()` do escopo, e nenhum
   diff é vazio. Nenhum arquivo é symlink nem submódulo.

O drift da main entre os dois runs é aceito só se for inerte. Sem isso, o recibo quase nunca valeria,
porque a main anda ~30×/dia. A condição 4 é o que torna o drift seguro.

As saídas passam a ter `modo` (`inerte` | `recibo` | `main-docs`) e `recibo=<run_id>`. O `validate`
**exige** o `modo`. No `recibo`, ele não confia no escopo: relê o run pela API (mesmo PR, concluído,
partes e união `success`), imprime "♻️ REAPROVEITADO do run X" (diferente de "⏭️ skipped") e
**reprova** se a leitura falhar.

O reaproveitamento deixa a anotação `provas-sql-reaproveitado`, que serve de sensor para a medição.

## Parecer do Codex (gpt-6-astra, high, 119 s, 73,6k tokens)

O Codex aprovou B. Em C, apontou estes pontos, todos incorporados:

- **Falha aberta: `.gitattributes`** num prefixo inerte muda os bytes do checkout. Um
  `src/.gitattributes` com `eol=crlf` derruba um `grep` ancorado de prova. Agora `.gitattributes` nunca
  é inerte, e isso vale também para o escopo de PR que já existia.
- **Falha aberta: mapa incompleto.** Um arquivo de `db/` que não se lê virava "não lê nada". Agora
  `lidosEmInerte` devolve `null` e o escopo roda. Um symlink de `db/` registra o alvo como lido.
- **O argumento "merge de 3 vias por arquivo" era incompleto** (renomeação, base virtual). Ele foi
  trocado pela árvore registrada e recalculada (condição 4).
- A rota do check-run vem do `check_run_url`, sem presumir que o id do job é o do check-run.
- Limitado a 10 candidatos por busca, por causa do rate-limit do token (1.000/h por repo).
- Faltava `checks: read` no escopo, para ler as anotações.

## Provas

- `scripts/provas-sql-escopo.test.ts`: 170 casos. Inclui o step REAL do `validate`, extraído do
  `ci.yml`, com um `gh` falso no PATH, e git real para o cenário do PR: só docs, SQL no meio de docs,
  drift de código na main, merge da main, rebase e outra história.
- **Falsificação** em 2026-11-09, com o controle verde (170) na mesma invocação e restauração por
  `git checkout` depois do commit: as 16 sabotagens deram VERMELHO.
  - No `validate`: não revalidar; aceitar `cancelled`; ignorar a branch; ignorar a conclusão das partes.
  - Na escolha do recibo: aceitar outra branch; atravessar um vermelho; aceitar a anotação de outro PR.
  - Na decisão: ignorar a base; o merge-base; o diff da árvore; o diff do head; a árvore recalculada;
    os merges; a ausência de recibo.
  - No inerte e no mapa: `.gitattributes` inerte; mapa incompleto.

## Medir depois de 7 dias

A query está no corpo do PR. Ela compara o runner-min `cancelled` dos runs de PR com o dos 7 dias
antes, conta os `fail-fast` que dispararam e conta as anotações `provas-sql-reaproveitado`.
