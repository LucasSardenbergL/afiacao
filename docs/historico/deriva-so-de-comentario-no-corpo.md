# `reposicao_persistir_qtde_inteira` em `DERIVA`: prod = repo menos 3 linhas de comentário, e a classe é maior

> 2026-09-26. Anomalia do `/fecho` de 2026-09-26: o `pendencias-pacote` reportou "corpo em prod não bate
> com nenhuma das 1 versão(ões) commitadas — edição manual". A nota do #2563 já dizia "3 linhas de
> comentário, cosmético". Esta mede por fora e dimensiona a classe. Nenhuma escrita em prod.

## A função: lógica idêntica, provado no banco

- Só **uma** migration define a função (`20260606190000_reposicao_qtde_inteira_persist.sql`, #683), e o
  arquivo tem um único commit: não foi editado depois de aplicado.
- Medido por `psql-ro`, md5 calculado **pelo Postgres** (não reimplementado no shell):

  | corpo | md5 | chars |
  |---|---|---|
  | `prosrc` em prod | `0f1d1cd2d9fefafa9465bd5fb287f200` | 673 |
  | corpo do arquivo, inteiro | `fcc3048e4b173db55acddd207abd00fc` | 936 |
  | corpo do arquivo **sem as 3 linhas `--`** (L42, L43, L53) | `0f1d1cd2d9fefafa9465bd5fb287f200` | 673 |

- `SECURITY DEFINER`, `search_path=public, pg_temp` e ACL (sem PUBLIC/anon/authenticated) batem com a
  migration. As 3 linhas são comentário inequívoco, fora de literal, e o corpo não faz introspecção
  (confirmado pelo Codex).

## A origem: não dá para datar pelo `xmin`, e a transformação é de CLASSE

- **O `xmin` da tupla em `pg_proc` (9106714) NÃO data o corpo.** 504 funções e 83 relações compartilham
  esse `xmin`. Todas as plpgsql do lote têm o papel `sandbox_exec_*` do Lovable no ACL, e 75 das 242 ainda
  guardam comentários, então foi um GRANT em massa e não uma recriação. Datado por `sync_reprocess_log`:
  **2026-08-14, entre 00:16Z e 02:15Z**. O corpo sem comentário já existia antes disso.
- **Censo de prod** (394 funções plpgsql/sql de `public`+`private`, com o extrator do próprio gate):

  | estado | n |
  |---|---|
  | `EM_DIA` | 245 (112 com comentário preservado) |
  | `DERIVA`: prod = última versão menos linhas iniciadas por `--`, byte a byte | **31** |
  | `DERIVA`: igual só após `removerComentariosSql` + colapso de whitespace | 40 |
  | `DERIVA` real | 12 (nenhuma é RPC chamada por edge; controle positivo conferido) |
  | `CORPO_ANTERIOR` | 1 (`kb_documents_set_updated_at`, trigger, fora de edge) |
  | sem corpo commitado / overload | 63 / 2 |

- **Concentração temporal** (mês da última migration): comentário perdido mai 15 · jun 38 · jul 17 · ago 1;
  comentário preservado jun 13 · jul 32 · ago 25 · set 36. **31/31** migrations com ≥2 funções comentadas
  são uniformes: todas perdem ou todas mantêm.
- **Hipótese mais forte:** o canal de apply de mai–jul/2026 tirava comentários da migration inteira. É
  inferência sobre a uniformidade e a data, não medição do canal.

## O que a 2ª opinião derrubou (Codex, `gpt-6-astra`/`max`, 372 s, 101.886 tokens)

- **"71 cosméticas" era exagero meu.** A receita geral (`removerComentariosSql` + colapso de whitespace)
  produz falsas equivalências, reproduzidas: `'a  b'` = `'a b'`; dollar-quotes com `-- desconto=10` e
  `-- desconto=90` viram iguais (o helper recursa em dollar-quote por contrato); continuação de `E''` perde
  conteúdo. As 40 são **candidatas**. As 31 exatas também pedem revalidação **léxica**: `^\s*--` por regex
  pode apagar linha que está dentro de string multilinha ou de comentário de bloco, e aí vira código.
- **Opções:** C (refinar o gate) vence. A (reaplicar só o `CREATE OR REPLACE`) é viável, mas intervém
  mais para resolver 1 de 31. B (commitar o corpo de prod) deve ser evitada. D (nada) é aceitável enquanto
  C não existe.
- **P1 latente no gate:** variante cosmética **comprovada** de uma versão ANTERIOR hoje cai em `DERIVA`,
  que libera, quando deveria bloquear como `CORPO_ANTERIOR`. 0 casos hoje.
- **P1 latente na orientação:** para `CORPO_ANTERIOR` o pacote diz "APLIQUE essa migration"
  (`scripts/lib/precondicao-banco.ts`) sem ressalva de DML. Esta migration, por exemplo, traz um backfill
  one-time sobre pedidos `pendente_aprovacao`…`aprovado_aguardando_disparo`. Reaplicar o arquivo inteiro
  reescreveria pedidos vivos depois do selo de aprovação (#2187/#2258).
- **Se A for escolhida**, `CREATE OR REPLACE` volta ao default toda propriedade não repetida no comando. A
  pós-condição precisa conferir identidade/OID, linguagem, assinatura/defaults, volatilidade, strict,
  parallel, leakproof, custo, `prosecdef` e todo `proconfig`, além de usar `lock_timeout` curto e ensaio
  com `RAISE` rotulado. A validação lê o catálogo, sem chamar a rotina sobre pedidos vivos.

## Desenho de C (o que o parecer propôs, ainda não implementado)

Depois das checagens EXATAS, que não mudam, o que hoje é `DERIVA` é re-testado contra um hash adicional
da **variante segura** do corpo cru do repo: só linhas inteiras de comentário em contexto de código,
com reconhecedor léxico que preserva strings, identificadores citados, dollar-quotes e comentários de
bloco aninhados. Sintaxe não suportada vale "não reconheci", nunca sucesso. Os resultados possíveis:

- bate a variante da última versão ⇒ `VARIANTE_SEM_COMENTARIOS` (não bloqueia);
- bate a variante de uma anterior ⇒ `CORPO_ANTERIOR` (bloqueia);
- senão ⇒ `DERIVA`.

O relatório mostra método, migration e hashes. O lado de prod continua sendo o md5 exato: nada de
normalizar os dois lados. A prova é controle verde e mais duas mutações que têm de ficar vermelhas
(remover código real; antecipar o reconhecimento às checagens exatas).

## Estado

Nenhuma escrita em prod. A decisão entre C, D e A é do founder.
