# Deriva de CORPO sem sensor — a varredura de 2026-09-26 e o `deriva:corpo:prod`

> 2026-09-26 · sessão `ops/deriva-corpo-funcoes`. Desdobramento da lição 1 de
> [`cancelar-revertido-por-colagem-fora-de-ordem.md`](cancelar-revertido-por-colagem-fora-de-ordem.md):
> *"Deriva de CORPO não tem sensor geral."* Codex (`gpt-6-astra`·max): desenho 476s/181.181 tokens —
> 0 P0 · 6 P1 · 2 P2; código 473s/196.060 tokens — 0 P0 · 10 P1 · 2 P2. Todos os achados adotados.
> Censo irmão, da mesma madrugada e só de documentação:
> [`deriva-so-de-comentario-no-corpo.md`](deriva-so-de-comentario-no-corpo.md) (mesma datação do GRANT
> em massa; propõe refinar o gate do pacote — a "opção C", ainda não implementada, pode reusar o
> `tokensSql` daqui).

## O buraco

`cancelar_pedido_sugerido` rodou 18 dias o corpo da `20260906170000` (colada depois da
`20260907095841`). Os audits de migration medem EXISTÊNCIA; o `authz:funcoes:prod` mede o manifesto
de authz; o eixo de corpo do `pendencias:pacote` só olha as RPCs de uma leva de deploy. Função fora
de qualquer leva não tinha sensor nenhum.

## A varredura (read-only, 2026-09-26 01:46:03–01:46:08Z, `origin/main` `e9dbcf383`, 735 migrations)

316 funções `public` com corpo commitado, julgadas com a lib do gate do pacote
(`classificarCorpo` sobre a sonda `montarSondaPrecondicao`, md5 calculado NO banco):
**224 EM_DIA · 83 DERIVA · 1 CORPO_ANTERIOR · 1 INDECIDIVEL · 7 AUSENTE.** Destrinchado:

| Classe | n | O que era |
|---|---|---|
| (a) revert por ordem de colagem | 1 | `kb_documents_set_updated_at` roda a `20260517170000`; o repo commitou a `…180000` depois — mas as duas têm os MESMOS 14 tokens (só quebra de linha). Cosmético. |
| (b) só comentário/espaço | 77 | mesma sequência de tokens da última versão; todas de migrations custom coladas entre 18/05 e 07/08; em 57 o corpo de prod não tem comentário nenhum (hipótese: a colagem da época ia compactada). |
| patch por âncora | 5 | `despinar_parametro`, `reverter_parametro_auto`, `reverter_run_auto` (FU4-E, `0719`+`0723`), `reposicao_pos_candidatos` (`20260814022626`), `tint_promote_sync_run` (`20260924120000`): prod está À FRENTE do último CREATE — o extrator não vê `pg_get_functiondef`+`replace`+`EXECUTE` como versão. |
| (c) edição manual | 1 | `detectar_skus_sem_grupo`: 347 tokens iguais menos UM literal (a justificativa gravada em `eventos_outlier`). Já em prod em 19/06 (está no `schema-snapshot.sql` do sync do Lovable). **Aceita pelo founder.** |
| (d) overload | 1 | `aprovar_pedido_sugerido`: as 2 assinaturas de prod batem byte a byte com as 2 declarações da `20260906170000` — o "indecidível" era o extrator guardando só o último corpo por arquivo. |
| ausente | 7 | todas com `DROP FUNCTION` (5) ou `SET SCHEMA private` (2) posterior. |

**Conclusão da varredura: nenhum revert perigoso vivo** além do caso-índice, já consertado
(`cancelar_pedido_sugerido` com `md5 8f49cbaf…`, EM_DIA).

## Datar colagem por `xmin` — duas correções ao método

- **O `xmin` de `pg_proc` data a última escrita da TUPLA, não do corpo.** `GRANT`/`REVOKE`/`ALTER`
  também a reescrevem. Em **2026-08-14 00:16–02:15Z** um GRANT em massa da plataforma (papel
  `sandbox_exec_…`, `xmin 9106714`) reescreveu 410 das 489 funções de `public` (+80 de `extensions`,
  10 de `storage`, 4 de `auth`, 52 sequences, 11 default ACLs) — a data de corpo de tudo que não foi
  recolado depois se perdeu ali. `xmin 9261717` idem: é o `REVOKE EXECUTE` da `20260818121919`.
- **O `sync_reprocess_log` não é só-de-inserção** (`n_tup_upd` 3.338 de 4.800): o `xmin` de uma linha
  pode ser o do UPDATE, então ele dá o limite INFERIOR com segurança e o superior pode sair cedo.
  Aperte o superior com tabela de `n_tup_upd = 0` (`tint_sync_errors`, `health_score_history`). A
  ordem do incidente (9924256 > 9923079) segue valendo — ela vem dos `xmin`, não das datas.

## O sensor — `bun run deriva:corpo:prod`

`db/audit-deriva-corpo-prod.ts` + lógica pura `scripts/lib/deriva-corpo.ts`. Exit **0** bate · **1**
divergiu · **2** não consegui medir. Sexta chave do carimbo (`AUDITS`, `SCHEMA_VERSION` 3) e Passo 2c
do `/fecho`. O que ele faz, e o achado que cada peça fecha:

- **Estado TERMINAL por identidade** (`nome(tipos de entrada)`, no formato de `format_type`):
  CREATE/DROP/SET SCHEMA/RENAME na ordem de apply e, no mesmo arquivo, pela posição. Fecha o
  overload trocado, o `f(text)` legítimo que a redefinição de `f(int)` não aposenta, e a função
  aposentada recriada à mão (`RESSUSCITADA`) — os três falsos-verdes do Codex (P1-2/P1-3).
  Calibrado antes de valer: identidade reconstruída do repo × `format_type` de prod = **311/311**.
- **Cosmético por TOKENS, com scanner próprio** (P1-4): o stripper compartilhado reanalisa o interior
  de dollar-quote de propósito (`sql-comentarios.ts:18`), então `$q$a--x$q$` e `$q$a--y$q$` saíam com
  a mesma máscara. O scanner segue o `scan.l` do PG17 (dollar-quote opaco, bloco aninhado, `''`/`""`,
  fronteira de operador, concatenação de literais por quebra de linha).
- **Patch por âncora exige CONCILIAÇÃO** (P1-1): todo par (função, migration de patch) posterior ao
  último CREATE precisa estar na baseline como `ALTERA` (com o md5 aceito) ou `SO_CITA`. Sem isso nada
  fica verde — nem com prod igual ao último CREATE (o patch pode nunca ter pegado). Medido: 18
  candidatos, 9 eram o mesmo arquivo do CREATE (excluídos), 5 alteram, 4 só citam.
- **Nenhuma declaração sem destino** (P1-5): versão posterior sem corpo dollar-quoted não deixa a
  anterior virar "última" (vira `NAO_MENSURAVEL`, que só fica verde DECLARADA); o `CREATE FUNCTION`
  escrito como texto dentro de outro corpo não rouba mais o corpo dele (corpus: delta ZERO em 2.404
  objetos); e um CREATE "solto" (identificador citado) que o extrator não reconheça derruba a medição.
- **Ref atual** (P1-6): `git fetch` antes de medir; sem ele exit 2, ou `--sem-rede` declarado no `🔎`.
- **Um retrato só** (P2-7): a sonda reaproveitada do gate do pacote e o detalhe por overload numa
  transação `REPEATABLE READ READ ONLY`, conferindo uma contra a outra (contagem e md5 por nome).
- **Aceite tolera cosmético** (P2-8): a baseline guarda md5 do banco **e** md5 dos tokens.

### O que o parecer de CÓDIGO derrubou (0 P0 · 10 P1 · 2 P2, todos com cenário de falso-verde)

`NAO_MENSURAVEL` dispensava até a EXISTÊNCIA; a perda contada por nome se escondia atrás do CREATE
antigo (redefinição com identificador citado) — virou contagem por declaração; excluir o patch do
mesmo arquivo do CREATE escondia "cria, patcheia e alguém reverte" — virou decisão por POSIÇÃO (o que
trouxe 8 conciliações `SO_CITA`, todas postcondições lidas uma a uma); `SELECT 'DROP FUNCTION …'`
aposentava função — literal de string não é comando (o `DROP` estático dentro de `DO` segue valendo);
`DROP` de assinatura ilegível aposentava todos os overloads — virou incerteza; `DEFAULT ')'` encurtava
a assinatura; perder as linhas de corpo de um nome escapava à conferência — a sonda ganhou a CONTAGEM
por nome no mesmo retrato; a continuação de `E''` perdia o escape; CR não fechava comentário; `'f'::regproc`
não era alvo de patch; tag de dollar-quote longa escapava da janela do regex; `int[][]`/`float(p)`.
Uma exceção inesperada no runner saía com o exit 1 cru do bun ("divergiu") — virou 2 (harness K6).

## Evidência

- Lib: **104** testes (`scripts/lib/deriva-corpo.test.ts`) + 43 do extrator + 3 do leitor da ref,
  inclusive o incidente REPLAYADO com as duas migrations reais (falsificado: sabotar a busca de versão
  anterior deu `SEM_PAR` e o teste ficou vermelho; restaurado, verde — na mesma invocação).
- Harness PG17 (`db/test-audit-deriva-corpo-prod.sh`): **28/28 em `LC_ALL=C` e em `pt_BR.UTF-8`** —
  controle verde primeiro (aborta se falhar), 12 sabotagens com o código certo e o dente de volta ao
  verde, mudança só cosmética verde, e 6 quebras de medição (truncada, psql caído, vazia, hex
  corrompido, exceção dentro e fora de `try`) saindo 2.
- Extrator com posição, argumentos cientes de literal e fantasma pulado: corpus de 735 migrations
  **byte a byte idêntico** (2.404 objetos) antes e depois.
- Baseline: 22 entradas — 1 `EDICAO_MANUAL`, 9 `PATCH/ALTERA`, 11 `PATCH/SO_CITA`, 1 `NAO_MENSURAVEL`.
- 1ª execução real (2026-09-26 03:15Z, `origin/main@6fe383e09`): **exit 0** — 313 identidades vivas
  (228 em dia, 78 cosméticas, 6 aceitas, 1 não mensurável declarada) e 15 aposentadas ausentes.

## A 1ª divergência viva: DDL aplicada ANTES do merge

Às 03:34Z o sensor saiu **exit 1**: `gerar_pedidos_sugeridos_ciclo(text,date)` e
`atualizar_parametros_numericos_skus(text,uuid)` em `SEM_PAR`, reescritas em prod minutos antes (`xmin`
10598692 e 10598741). Varrendo as branches remotas, os dois corpos batem **byte a byte** com migrations
do #2573 (`20260925225004`, `20260926001425`), aberto e ainda fora da main: outra sessão aplicou a DDL
primeiro. É divergência de verdade (prod roda código que a main não tem) e some quando o PR mergear; se
ele não mergear, é exatamente o que o sensor existe para não deixar calado.

## Lições

1. **O sensor pegou deriva ao vivo antes de nascer.** O #2565 (mergeado 02:19Z, depois da varredura)
   patcheou `tint_promote_sync_run` por âncora e foi aplicado em prod — o `xmin` pulou para 10596327
   e o md5 mudou (`408edc16…` → `ae04a67b…`). Sem conciliação, isso é `PATCH_NAO_CONCILIADO`; a
   baseline nasceu já com o aceite dessa mudança, medida e lida linha a linha.
2. **Comparar corpo exige saber QUEM é a função** — identidade é nome + tipos de entrada. Casar por
   corpo sozinho aprova overloads trocados.
3. **"Cosmético" é léxico, e o léxico é o do banco** — o stripper que serve a um gate (olhar DENTRO do
   dollar-quote) é o errado para outro (tratá-lo como literal). Reuso de ferramenta pressupõe o
   mesmo contrato.
