# A postcondição copiada herda o pressuposto do molde

**PR #2249** (`aprovar_pedido_sugerido` — REVOKE de `anon`/PUBLIC), replicando o #2241
(`cancelar_pedido_sugerido`). Medido na PROD em 2026-09-06 via `psql-ro`.

## A classe

Replicar uma migration que já funcionou é o caminho certo — o molde carrega a forma, o
vocabulário e os contrapesos que alguém já pagou para descobrir. O que **não** viaja junto é
o **estado do banco que o molde pressupunha**.

A postcondição do #2241 tinha, além dos asserts de ACL, um assert sobre o **corpo** da função:

```sql
IF (SELECT prosrc FROM pg_proc WHERE oid = v_oid) !~ 'WHERE id = p_pedido_id[[:space:]]+AND status NOT IN' THEN
  RAISE EXCEPTION 'POST FALHOU [GUARD-NO-UPDATE]: o guard atomico do #2218 sumiu ...';
```

Ele é correto **lá**: em `cancelar_pedido_sugerido`, o guard atômico já estava na PROD, então o
assert só dispara se alguém recriar a função por cima. Copiado para a irmã `aprovar_pedido_sugerido`,
o mesmo assert vira uma **bomba**: o guard equivalente vive na migration `20260906151715` (#2239),
que está **mergeada mas não aplicada**. A migration abortaria no `Run` do founder — por causa de uma
pendência **de outra migration**, não por um defeito da sua. Um round-trip humano inteiro, gasto
para descobrir algo que uma query de leitura respondia de graça.

> **A regra:** ao replicar uma postcondição, cada assert copiado é uma **afirmação sobre a PROD**.
> Meça o pressuposto de cada um antes de herdá-lo. Um assert que você não mediu não é uma rede —
> é um palpite que aborta na cara de quem colou.

## O achado colateral: o #2239 mergeou e não foi aplicado

Duas testemunhas independentes, porque uma só não distingue "não aplicado" de "não registrado":

| testemunha | o que disse |
|---|---|
| catálogo (`pg_get_functiondef`) | o corpo vivo ainda é o TOCTOU original: `SELECT … WHERE id` e depois `UPDATE … WHERE id`, **sem** `AND status NOT IN` |
| registro (`supabase_migrations.schema_migrations`) | `20260906151715` **ausente**; as três irmãs (`20260905224959`, `20260906105549`, `20260906154202`) presentes |

O registro sozinho seria fraco (SQL colado à mão não escreve lá — a Section 1 do audit dá `MISSING`
por rotina). O catálogo sozinho é forte, mas o par elimina a dúvida. **Merge ≠ produção** continua
sendo a falha-mãe deste repo, e ela reaparece exatamente onde ninguém olha: numa migration que
passou no CI e cujo PR já fechou.

## Ordem de apply: verificada, não presumida

Com duas migrations pendentes sobre a **mesma função**, "a última a rodar vence" é a armadilha
padrão (database.md §4). Aqui as duas ordens **convergem**, e isso é uma propriedade que precisou
ser conferida no arquivo, não assumida:

- a `20260906151715` usa `CREATE OR REPLACE` (**preserva** o ACL — nunca `DROP`+`CREATE`, que o
  resetaria) e concede apenas `authenticated` — **jamais** `anon`;
- a desta entrega só mexe em ACL e não toca o corpo.

Logo: revoke→replace preserva o revoke; replace→revoke revoga depois. Mesmo estado final. Se a
`20260906151715` usasse `DROP`+`CREATE`, a ordem seria obrigatória e teria de ir no handoff.

## A falsificação que cabia no pré-voo

O `psql-ro` é read-only, então o SQL de escrita não pode ser ensaiado — mas **a postcondição sim**,
porque ela só lê. Rodar o bloco `DO $post$` **extraído do arquivo commitado** contra a PROD, antes
do apply, dá os dois controles na mesma medição:

- **vermelho** — `exit=1`, `ERROR: POST FALHOU [ACL-ANON]`. O assert do alvo enxerga o estado real
  de hoje; não é sempre-verde.
- **verde** — os contrapesos (`authenticated`, `service_role`, `prosecdef`) já estão verdes, então a
  migration não vai abortar por eles; e a **irmã já corrigida pelo #2241** exibe a linha inteira
  verde, provando que o estado-alvo é atingível e que o predicado o reconhece.

Uma linha vermelha, e é o alvo. Sem o controle verde na mesma invocação, "abortou" não distinguiria
o assert que funciona daquele que sempre falha ([base](falsificacao-sem-linha-de-base.md)) — e um
`DO` block com sintaxe válida mas predicado sempre-vermelho passa no `CREATE` e só morre em runtime,
porque **plpgsql é late-bound**.

## O que esta entrega NÃO é

Não é correção de vulnerabilidade, e o PR diz isso. `aprovar_pedido_sugerido` é SECURITY INVOKER
(`prosecdef=false`, medido) e `pedido_compra_sugerido` tem RLS ligada: sob `anon` o UPDATE não casa
policy nenhuma. A RLS **já** nega. Isto remove a dependência de que a RLS permaneça como está —
defesa em profundidade, o mesmo julgamento que o #2241 fez. Vender profundidade como correção gasta
a credibilidade que a próxima correção de verdade vai precisar.
