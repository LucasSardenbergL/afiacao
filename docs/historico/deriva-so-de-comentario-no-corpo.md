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

## Desenho de C (o que o parecer propôs — implementado em 2026-10-01, ver abaixo)

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

## C implementado sobre `mesmosTokens` (2026-10-01)

O founder escolheu C, sem escrita em prod. A 1ª implementação (branch de referência
`claude/gate-corpo-variante-sem-comentarios`, sem PR) seguia o desenho acima ao pé da letra, com um
léxico PRÓPRIO de linhas inteiras de `--` — e o Codex a reprovou com 3 P1 reproduzíveis nesse léxico:
`\r` isolado encerra comentário no Postgres (`BEGIN\n-- c\rRETURN 1;…` perdia o `RETURN 1`), a
continuação de `E''` herda o modo de escape (o `-- desconto=90` está DENTRO do literal), e tag de
dollar-quote com mais de 126 caracteres escapava da janela de 128. O scanner do #2576 (`tokensSql`)
responde DIFERENTES nos três: o léxico da 1ª versão foi descartado, não corrigido.

- **Uma verdade só.** O léxico mudou de casa, não de conteúdo: `scripts/lib/tokens-sql.ts`, movido byte
  a byte de `deriva-corpo.ts` (que reexporta), porque o gate não pode importar do sensor — o sensor
  importa `precondicao-banco.ts`, e seria ciclo.
- **O exato não muda.** `classificarCorpo` está intocado; `classificarComTokens` (`corpo-esperado.ts`)
  delega a ele e só re-testa o que sai `DERIVA`, a ÚLTIMA versão primeiro. Tokens da última ⇒
  `VARIANTE_COSMETICA` (lista `cosmeticas`, não bloqueia; o relatório mostra método, migration e os md5
  de prod, do repo e dos tokens). Tokens de uma anterior ⇒ `CORPO_ANTERIOR` com `casouPor: 'tokens'`
  (bloqueia — o P1 latente). Sem texto de prod que reproduza o md5 medido ⇒ `INCERTA`.
- **Exceção conservadora, documentada:** se a última só acrescentou comentário e prod = a anterior
  EXATA, a precedência exata segue bloqueando. Caso vivo: `kb_documents_set_updated_at`.
- **O texto de prod** vem da sonda de detalhe do #2576 (`montarSondaDeriva`, uma transação
  `REPEATABLE READ`; pela nuvem, as duas consultas de `consultasDeriva` num statement só, juntadas pela
  receita única `saidaDerivaComoPsql`, que o audit também passou a usar).
- **Ressalva de DML** no "⇒ APLIQUE essa migration": reaplicar o ARQUIVO re-executa o que mais ele traz
  (a `20260606190000` roda um backfill one-time sobre pedidos vivos).

### Evidência

- **Censo de prod** com o código do branch (`psql-ro -q -v ON_ERROR_STOP=1`; canal íntegro: marcadores,
  dialeto, autoteste hex, zero incoerência; `origin/main@1163a1225`, 757 migrations, 316 funções vivas):
  239 `EM_DIA` · **69 `DERIVA` → `VARIANTE_COSMETICA`** · 5 `DERIVA` restantes (os 4 patches por âncora e a
  edição manual aceita de [`deriva-corpo-sem-sensor.md`](deriva-corpo-sem-sensor.md)) · 1 `CORPO_ANTERIOR`
  exato (a exceção conservadora) · 2 `INDECIDIVEL` · **0 `CORPO_ANTERIOR` novo pela via de tokens** · 0 sem
  texto.
- **Execução real:** `bun scripts/pendencias-pacote.ts disparar-pedidos-aprovados` → exit 0, com
  `reposicao_persistir_qtde_inteira` em `VARIANTE_COSMETICA` (prod `0f1d1cd2…` ≠ repo `fcc3048e…`, md5 dos
  tokens `9c309ece…`). Na main, a mesma leva dizia "edição manual".
- **Testes:** os 3 P1 e os 3 P2 do Codex (empate de variantes; propagação SQL → extração → histórico →
  bloqueio, com o caso real lido da migration e os md5 medidos no banco; `DECLARE a$q$ int`) viraram
  regressão do caminho por tokens em `precondicao-banco.test.ts`, com controles positivos na mesma suíte.
- **Mutcheck:** 4 contratos (`scripts/mutcheck.d/*tokens*.mut`), controle+ em todos, inclusive "variante
  antes do exato" e "tokens iguais aceitam diferença de literal"; o do léxico é medido pela suíte do
  GATE, não só pela do sensor. Harness PG17 do audit: 28/28 em `C` e em `pt_BR.UTF-8`.

### 2ª opinião: Codex de código NÃO consultado ainda — Caminho B

`codex-async.sh` saiu 79 (`SALDO_ALTO`: cota em 86%, teto 85%, janela reabre 03/10 19:11), sem gastar a
chamada. Por `money-path.md`, isso é gatilho de DRAFT, não de pular. No intervalo, auto-challenge com
prova executada, que achou um desvio no léxico ÚNICO: o `\s` do JS ≠ o `space` do scan.l. Um NBSP, BOM
ou U+2028 que abria token era engolido, e `SELECT <NBSP>x` igualava `SELECT x`. Medido em prod:
`column " x" does not exist`, enquanto `SELECT\f1`/`SELECT\v1` devolvem 1. Corrigido em `tokens-sql.ts`
(vale para o gate e para o sensor), sem efeito no censo (0 corpos em prod e 0 migrations com esses
caracteres). **REVISÃO INDEPENDENTE PENDENTE** até o Codex rodar no diff.

## Estado

Nenhuma escrita em prod. C entregue.
