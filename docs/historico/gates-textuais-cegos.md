# Gate textual cego: o `/*` dentro de string apagava o arquivo antes do fiscal olhar

**Data da medição:** 2026-08-20 · **Classe:** fiscal que fica **verde por CEGUEIRA** — indistinguível de verde por mérito.

## A classe

Todo gate textual deste repo (o padrão `edge-parse-parity`: vitest lê a FONTE com `readFileSync` e mede
um padrão) limpava comentário assim, com uma cópia local por arquivo de gate:

```ts
s.replace(/\/\*[\s\S]*?\*\//g, '')
```

É **regex**: não sabe o que é string. Qualquer `/*` que apareça DENTRO de uma string pareia com o
**próximo `*/` real do arquivo** e apaga tudo entre os dois — antes de o fiscal medir qualquer coisa.

O caso que revelou: o header HTTP `'Accept': '…image/webp,*/*;q=0.8'` das edges Sayerlack carrega
`/*` no `*/*` do mimetype coringa. Em `supabase/functions/sayerlack-captura-precos/index.ts`, **1.041
das 1.226 linhas (85%)** eram invisíveis aos gates.

Isto é a mesma família de `§"Validação só conta com EVIDÊNCIA POSITIVA"`: ausência de sinal não é
aprovação. Aqui o fiscal *tinha* sinal — só que de 15% do arquivo, e não dizia isso a ninguém.

## Alcance medido (repo inteiro, 2.390 fontes `.ts/.tsx` de `src/` + `supabase/functions/` + `scripts/`)

Arquivos onde a limpeza antiga apagava ≥5 linhas que a nova preserva:

| linhas reveladas | arquivo |
| --- | --- |
| 883 | `supabase/functions/sayerlack-captura-precos/index.ts` |
| 208 | `supabase/functions/enviar-pedido-portal-sayerlack/index.ts` |
| 45 | `src/services/financeiroService.ts` |
| 39 | `src/components/tarefas/ComprovacaoDialog.tsx` |
| 33 | `supabase/functions/posthog-error-webhook/index.ts` |
| 22 | `src/components/ToolImageIdentifier.tsx` |
| 11 | `src/components/unifiedAI/AIInputArea.tsx` |
| 9 | `src/components/farmer/tacticalPlan/PlanCard.tsx` |
| 9 | `src/components/reposicao/pedidos/PoSumidoCard.tsx` |
| 6 | `src/components/PhotoUpload.tsx` |
| 5 | `src/pages/FarmerRecommendations.tsx` |
| 5 | `scripts/audit-custom-migrations.ts` |

Duas correções ao briefing que originou a varredura, ambas por MEDIÇÃO: `enviar-pedido-portal-sayerlack`
e `financeiroService` não estavam na lista (e são o 2º e o 3º maiores), e os 3 arquivos suspeitos que
estavam nela se confirmaram.

## O que foi feito

**1. Um stripper só, com máquina de estados** — `src/lib/gates/limpeza-fonte.ts`: entende aspas simples,
duplas, template literal (inclusive `${…}` aninhado) e regex literal. Preserva o número de linhas, para
que gate com `^…`/multiline e gate que compara POSIÇÃO (`indexOf` de A antes de B) continuem medindo a
mesma coisa. Os 10 gates de `.ts/.tsx` importam dele; a cópia local morreu em todos.

Limite deliberado: sem parser de verdade, texto JSX (`<p>Don't</p>`) e divisão ambígua podem ser lidos
como abertura de string/regex — por isso string de aspas e regex literal **abortam na quebra de linha**,
como manda a gramática do JS. O estrago máximo de uma leitura errada é o RESTO DA LINHA, nunca 1.041.

**2. A dívida REVELADA, registrada como revelação.** `erro-object-object-gate`: `A` foi de 1→3 e `C` de
0→1 em `sayerlack-captura-precos` (linhas 737/986 e 659). Nasceram com o arquivo — ninguém reintroduziu.
Os outros 9 gates não mudaram de veredito: a região que eles não viam não continha o padrão que medem.
Esse "não mudou" só vale porque foi MEDIDO com o gate rodando, não presumido.

**3. O sentinela que faltava** — `src/lib/gates/__tests__/limpeza-fonte.test.ts`. Os gates já provavam
que o walker anda (quantos ARQUIVOS leu); nada provava quanto de CADA arquivo sobrou depois da limpeza.

O eixo que funciona é o **maior BLOCO CONTÍGUO descartado**, não a fração: o arquivo envenenado
preservava 0,118 e há `versao.ts` legítimo em 0,154 — fração não separa os dois. Forma separa: o maior
cabeçalho honesto do repo tem **88 linhas** (`src/hooks/useFarmerScoring.ts`); a região comida pelo par
falso tinha **924**. Teto em 150 — 1,7× acima do maior legítimo, 6× abaixo do estrago. Linha em branco
no original é neutra: contá-la como fronteira quebrava o bloco de 924 em pedaços de <88, e o alarme
silenciava exatamente no caso que existe para pegar.

A fração (`medirPreservacao`, piso 0,10 para arquivos com ≥60 linhas) fica como eixo grosso do outro
extremo — e o comentário no teste diz explicitamente que ela NÃO teria pego o caso Sayerlack.

**4. Falsificação (as duas rodadas, com o commit já feito antes):**
- Sabotar o reconhecimento de string (`fimDeString` → `-1`): 5 vermelhos, incluindo os DOIS sentinelas.
- Trocar o stripper de volta pelo regex antigo: 7 vermelhos — e entre eles `A`/`C` do `erro-object-object`,
  o que prova que as entradas novas da baseline são causadas pelo stripper, não por um número escolhido.

## O que sobrou aberto (medido, não presumido)

- ~~**4 gates Deno**~~ — **FECHADO** (ver §"Perna Deno" abaixo).
- **Sub-classe CSS** (`table-overscroll.test.ts`): insumo é um arquivo só (`src/index.css`), sob nosso
  controle; varredura deu **zero**. Registro, sem chip.
- **Sub-classe SQL — eixo `--`, medida ATÉ O VEREDITO (3ª rodada, 2026-08-20). Exposição real, dano
  zero, blindada mesmo assim.** É irmã desta classe, não a mesma: mecanismo idêntico (limpeza que não
  entende literal), delimitador `--` em vez de `/*`.

  | eixo | exposição | veredito do `authz:check` |
  | --- | --- | --- |
  | `/*` dentro de literal | 0/656 | — |
  | bloco ANINHADO (`/* /* */ */` — Postgres permite, e `[\s\S]*?` fecha no `*/` interno) | 0/656 | — |
  | **`--` dentro de literal** | **6/656** | **não muda (byte-a-byte)** |

  **O `16/656` da rodada anterior não reproduz.** Três métodos independentes convergem em **6**: (a)
  walker de gramática recursivo, (b) diff do SQL entregue ao parser pelos dois strippers ignorando
  espaço, (c) contagem ingênua de aspas ímpares antes do `--` na linha. Os três apontam o MESMO
  conjunto de 6 arquivos. Denominador publicado só vale com o método junto.

  **O que a medição do dano diz** — e é o ponto: rodar `authz:check --json` com o stripper velho e com
  o novo dá saída **byte-a-byte idêntica** (`ok:true`, 8 avisos). A sonda mais sensível, um dump de
  `extractFunctions` + `detectarReescritaViva` das 656 migrations, também é **idêntica** — e a sonda foi
  **falsificada** (com o stripper virando no-op, 254/656 arquivos mudam, então ela enxerga).
  A razão é **estrutural, não sorte**: os 6 sítios ficam **fora de corpo de `CREATE FUNCTION`** — 5 dentro
  de bloco `DO $tag$` (assertivas que fazem `regexp_replace(pg_get_functiondef(…), '--[^\n]*', …)`, ou
  seja, carregam o próprio padrão como DADO) e 1 num arquivo sem função nenhuma (o template fiscal
  `E'FORMA DE PGTO BOLETO\n\n-- --\n…'` de `20260703090000_pedidos_programados.sql`). O parser da Parte
  A/B só lê corpo de `CREATE FUNCTION`; a Parte D exige `pg_get_functiondef` **+ EXECUTE**.

  **Mesmo assim foi trocado**, e a neutralidade é justamente o argumento: `stripComments` passou a
  delegar para `scripts/lib/sql-comentarios.ts` (máquina de estados: `''` escapado, `E'…\'…'`,
  `"ident"`, `$tag$` recursivo, bloco ANINHADO). Trocar quando a saída é **provadamente igual** é a
  adoção mais barata que existe — depois vira migração de veredito. E o que estava aberto não era a
  exposição, era a **invariante DECLARADA**: o docstring afirmava *"preserva strings e dollar-quotes"*
  enquanto o código não preservava. A inércia de hoje é contingente ao corpus: o dia em que alguém
  escrever `regexp_replace(…, '--[^\n]*', …)` **dentro** de uma SECDEF — e há um `DO` block a poucas
  linhas de distância que já faz exatamente isso — a cegueira cai sobre o gate de authz.

  **Decisão de gramática que não é óbvia:** `$tag$…$tag$` **não** é tratado como opaco. Um lexer puro
  pararia ali; aqui o consumidor é o gate de authz, cuja razão de existir é não ser enganado por
  `-- gate comentado` DENTRO do corpo. Medido: tratar como opaco divergia do stripper anterior em
  **277/656** migrations. O interior é re-analisado com a mesma gramática.

  **Sentinela** (herdado de `maiorBlocoDescartado`): `maiorBlocoDescartadoSql` + teto de **300** linhas
  em `scripts/sql-comentarios.test.ts`. Calibração medida: maior bloco LEGÍTIMO descartado nas 656
  migrations = **175** (`20260615130000_tint_vigia_cobertura_sentinela.sql`); um `/*` que nunca fecha
  no quarto inicial dos 3 maiores arquivos devolve **676–762**. O teto fica 1,7× acima do legítimo e
  2,3× abaixo do estrago — a mesma folga do sentinela irmão (150 sobre 88). O teste também **prova o
  alarme disparando** num arquivo envenenado: alarme que nunca se viu disparar é decoração.

## Perna Deno — fechada (2026-08-20, mesmo dia)

`supabase/functions/_shared/limpeza-fonte.ts` é **espelho byte-idêntico** de `src/lib/gates/limpeza-fonte.ts`,
amarrado por `src/lib/gates/__tests__/limpeza-fonte.parity.test.ts`. A duplicação é obrigatória, não
preguiça: `test:edges` roda `deno test --no-remote`, e sob esse flag um teste de edge não pode importar
de `src/` — o jeito de não ter duas verdades é provar que os bytes são os mesmos.

**5 sítios** trocados em 4 arquivos (o `sonda-versao-contrato_test.ts` tinha dois — o `codigoDaEdge` e um
`semComentario` local dentro do teste de calibração):

| arquivo | sítios |
| --- | --- |
| `calculate-scores/ordem-lease_test.ts` | 1 |
| `_shared/cmc-snapshot-retry_test.ts` | 1 |
| `_shared/sonda-versao-contrato_test.ts` | 2 |
| `omie-analytics-sync/politica-retry_test.ts` | 1 |

### Re-medição dos alvos (não presumida)

Confirma o que a tabela do topo já dizia: **a classe estava LATENTE aqui, não ativa**. Nenhum alvo tinha
`/*` dentro de string; o maior bloco descartado foi 56 linhas (`omie-analytics-sync/index.ts`), bem abaixo
do teto de 150, e a fração preservada ficou entre 0,63 e 0,87.

O que MUDOU não é a classe catastrófica e sim uma **segunda cegueira, menor e real**: 4 dos 5 sítios usavam
`.filter((l) => !/^\s*\/\//.test(l))`, que só descarta a linha que **começa** com barra-barra —
comentário no FIM de uma linha de código continuava sendo medido como se fosse código (9 linhas em
`omie-analytics-sync/index.ts`, 3 em `cmc-snapshot-backfill/index.ts`). Isso produz **falso VERMELHO**:
um comentário de fim-de-linha que cite a forma proibida reprova uma edge correta. O módulo remove os dois
tipos. **Nenhum veredito virou** — `test:edges` seguiu 765/765 antes e depois.

### Falsificação (todo gate exigido em vermelho)

- **Stripper portado vira no-op** (`return fonte`): `politica-retry`, `cmc-snapshot-retry` e
  `sonda-versao-contrato` ficam **vermelhos** (3 testes). `ordem-lease` **continua verde** — a proteção
  dele também é latente hoje: nenhuma das agulhas que ele usa (`claim_calculate_scores`,
  `farmer_algorithm_config`, `finalizar_calculate_scores`) aparece em comentário do `index.ts`.
- **Controle positivo 2×2 para o `ordem-lease`** (o único que a sabotagem sozinha não discriminava):
  injetando no topo do `calculate-scores/index.ts` um comentário que cita `farmer_algorithm_config`,
  o gate fica **verde com o stripper real** e **vermelho com o no-op**
  (`ORDEM QUEBRADA: os pesos (indice 26) sao lidos ANTES do claim (indice 52)` — o índice 26 é a PROSA).
  Prova que a limpeza é carga, e que sem ela o modo de falha é falso-vermelho contra edge correta.
- **Paridade**: 1 byte de divergência no espelho → `limpeza-fonte.parity.test.ts` vermelho.

## Assinatura para varredura futura

```bash
rg -n "replace\(/\\\\/\\\\\*\[\\\\s\\\\S\]\*\?\\\\\*\\\\//" src/ supabase/ scripts/
```

Casa toda cópia do stripper regex. Em `.ts/.tsx` de `src/`, o correto é importar
`removerComentarios` de `@/lib/gates/limpeza-fonte`; em `supabase/functions/**`, de
`_shared/limpeza-fonte.ts` (espelho byte-idêntico — **não** editar só um dos lados).

Medido na base de 2026-08-20 (pós-#1832/#1833), o comando acima devolve **8 ocorrências**, e o
número sozinho não julga nada — o que julga é a classificação:

| ocorrência | veredito |
| --- | --- |
| `src/lib/gates/limpeza-fonte.ts:5` · `supabase/functions/_shared/limpeza-fonte.ts:5` · `scripts/lib/sql-comentarios.ts:5` | cabeçalho citando a forma ANTIGA para explicar o que a substituiu |
| `src/lib/gates/__tests__/limpeza-fonte.test.ts:9,56` · `scripts/sql-comentarios.test.ts:9` | controle deliberado — o teste roda a regex velha para exigir que ela FALHE onde a nova passa |
| **`src/__tests__/import-tint-formulas-aposentada-gate.test.ts:47`** | **uso ATIVO** — sub-classe SQL, aberta acima |
| **`src/components/ui/__tests__/table-overscroll.test.ts:25`** | **uso ATIVO** — sub-classe CSS, aberta acima |

Ou seja: **6 legítimas e 2 usos ativos**, os dois já registrados como sub-classe aberta. Em
`supabase/functions/` isoladamente a varredura devolve **1**, e é cabeçalho. Qualquer match novo
fora dessas 8 é reincidência da classe.

O eixo `--` (SQL) tem assinatura própria — casa quem limpa comentário de SQL sem gramática:

```bash
rg -n "replace\(/--" src/ supabase/ scripts/ db/
```

Quem lê SQL deve importar `removerComentariosSql` de `scripts/lib/sql-comentarios.ts`.

### O `[^` da assinatura era um furo (2026-08-22)

A assinatura acima era `replace\(/--\[\^` até esta data, e o `[^` **estreitava demais**: casava a
forma `--[^\n]*` e era cega à equivalente `--.*$` (com `/m`). Resultado — `extractObjects` de
`scripts/lib/migration-objects.ts`, o **2º consumidor** do eixo (alimenta `bun run audit:migrations`
e o `wt-preflight-migration`), atravessou a varredura de 2026-08-20 intacto, com
`sql.replace(/--.*$/gm, '')`. Foi achado por LEITURA, não pela varredura: assinatura estreita demais
devolve **ausência de dado**, não ausência de sítio — e devolve verde. A forma acima casa as duas.

Neste sítio a classe mordia nos **dois** sentidos, não só no de sempre:

| sentido | mecanismo | efeito no audit |
| --- | --- | --- |
| objeto **some** | `--` dentro de literal/identificador citado come até o fim da linha | a DDL seguinte não vira objeto → **ausência** (o pior modo de falha de um audit) |
| objeto **é inventado** | comentário de BLOCO não era removido | DDL comentada para rollback entra como objeto esperado → **vermelho eterno** (o banco nunca vai tê-la) |

Trocado com a mesma prova de neutralidade que barateou a adoção anterior: **1671 objetos em 483
migrations custom antes e depois — zero somem, zero surgem** — e `bun run audit:migrations`
regenerado dá **diff vazio** nos dois artefatos (2ª medição, pelo pipeline real). Exposição ativa
hoje: **zero** `CREATE POLICY` dentro de bloco no corpus ⇒ é endurecimento, não correção de falha
em produção. Casos em `scripts/lib/migration-objects.test.ts`, falsificados nos dois eixos (voltar
ao stripper local ⇒ 3 vermelhos; stripper no-op ⇒ o guarda de comentário de linha também cai).

Re-medido no HEAD pós-troca, a assinatura ampliada devolve **4**, e a classificação é a de sempre:
3 legítimas (`scripts/lib/sql-comentarios.ts:5` e `scripts/lib/migration-objects.ts:88` citam a
forma ANTIGA no cabeçalho para explicá-la; `scripts/sql-comentarios.test.ts:9` é o controle
deliberado) + **1 uso ATIVO**, o `import-tint-formulas-aposentada-gate.test.ts` já aberto acima.


## Variante 3 — o comentário prometia o stripper; o código não tinha nenhum (2026-08-22)

O gate de citações (`scripts/docs-citacoes-gate-check.ts`) nasceu com esta linha logo acima do
laço que mede:

```
// Bloco de código não é citação — é exemplo. (Heurística barata: linha dentro de ``` é pulada.)
```

Não havia variável de estado de cerca em lugar nenhum do arquivo — a varredura por
`dentro|fence|```` devolvia só a própria linha do comentário. Toda citação escrita dentro de um
bloco cercado, como EXEMPLO do formato, era cobrada como afirmação real sobre o repo: quem
quisesse documentar o próprio gate teria de inventar um alvo válido para o exemplo.

É a classe deste doc pelo avesso. Lá o stripper existia e apagava demais; aqui o comentário
descrevia um stripper que nunca existiu. O efeito é o mesmo: **quem lê o gate acredita numa
proteção que não está lá** — e o comentário é lido por quem revisa, não pelo CI.

### O que o reuso ingênuo teria feito (medido, não presumido)

A correção óbvia é reusar `removerCodigo`, do gate irmão de links, em vez de escrever um segundo
stripper. Medido sobre os docs vivos, 2026-08-22:

| stripper | citações que sobrevivem à limpeza |
| --- | --- |
| nenhum (estado anterior) | 22 |
| `removerCodigo` (cerca **+ crase inline**) | **0** |
| `removerCercas` (só cerca) | 22 |

`removerCodigo` também esvazia trecho entre crases — e a citação canônica deste repo NASCE entre
crases. Rodando o gate real com essa troca:

```
docs-citacoes-gate: ✓ 0 citação(ões) verificada(s) contra o conteúdo real · 0 externa(s).   # exit 0
```

Verde, silencioso, medindo nada. A mesma falha deste doc, agora causada pelo próprio remédio.

**A lição nova: stripper compartilhado não é UM — tem camadas, e a camada certa depende do que o
gate MEDE.** Por isso `scripts/lib/markdown-codigo.ts` expõe as duas com nome (`removerCercas` e
`removerCodigo`) em vez de um flag booleano: quem chama escolhe explicitamente, e cada gate prende
a escolha com um **teste-sentinela** que fica vermelho quando alguém "limpa" trocando uma pela
outra. Sem esse sentinela, a troca é um diff de uma palavra que passa em qualquer revisão.

### O preço do skip, pago à vista

Pular cerca abre um modo de falha novo: cerca que nunca fecha esvazia tudo abaixo dela, e o gate
mede só o que sobrou. Herdou do gate de links a regra inteira — vira achado apontando a linha da
abertura, e **só quando escondeu citação de fato**, senão o gate passaria a cobrar estilo de
markdown, que não é o assunto dele.

### Falsificação (exigida nos dois sentidos)

| sabotagem | resultado |
| --- | --- |
| citação com trecho errado DENTRO de ``` num doc vivo | gate **verde**, exit 0 — é exemplo |
| a MESMA citação FORA da cerca | gate **vermelho**, exit 1, apontando linha e conteúdo real |
| reverter o skip (voltar ao texto cru) | 3 testes vermelhos |
| trocar `removerCercas` por `removerCodigo` | **7 vermelhos, incluindo o sentinela** |
| cerca aberta deixar de virar achado | 1 vermelho — só o dela |

### O terceiro gate de markdown

`scripts/docs-indice-gate-check.ts` não usa stripper nenhum. Ele lê célula de TABELA de README, e
a exposição foi MEDIDA, não presumida: 0 linhas de tabela dentro de cerca em todos os `README.md`
do repo hoje, gate verde. Risco latente registrado, sem caso ativo — quem mexer nele já sabe onde
mora o stripper.

### Assinatura para varredura futura

```bash
for f in $(grep -ln "endsWith('.md')" scripts/*.ts); do
  grep -q "lib/markdown-codigo" "$f" || echo "SEM STRIPPER: $f"
done
```

Medido em 2026-08-22 devolve **1** — o gate de índice, classificado acima. Qualquer match novo é
um gate de markdown nascendo sem ter tomado a decisão de camada.
