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

- **4 gates Deno** (`supabase/functions/**/*_test.ts`) ainda têm cópia local: não podem importar de `src/`
  (`--no-remote`), precisam de um `_shared/limpeza-fonte.ts` + teste de paridade. **Medido hoje: zero
  impacto** — os alvos deles (`calculate-scores/index.ts`, `generate-bundle-argument/index.ts`,
  `_shared/cmc-snapshot-retry.ts`, `omie-analytics-sync/politica-retry.ts`) não estão na tabela acima.
  Latente, não ativo. Chip próprio.
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

## Assinatura para varredura futura

```bash
rg -n "replace\(/\\\\/\\\\\*\[\\\\s\\\\S\]\*\?\\\\\*\\\\//" src/ supabase/ scripts/
```

Casa toda cópia do stripper regex. Em `.ts/.tsx` de `src/`, o correto é importar
`removerComentarios` de `@/lib/gates/limpeza-fonte`.

O eixo `--` (SQL) tem assinatura própria — casa quem limpa comentário de SQL sem gramática:

```bash
rg -n "replace\(/--\[\^" src/ supabase/ scripts/ db/
```

Quem lê SQL deve importar `removerComentariosSql` de `scripts/lib/sql-comentarios.ts`.
