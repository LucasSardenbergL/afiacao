# Edge aposentada é INERTE no /fecho — a prova que vem do git, não do banco

**2026-09-05 · Passo 3 do `/fecho` (`edges-pendentes.sh`) · gatilho: #2184 (`,5` vale 0,5 no parser).**

## O sintoma

Todo PR que toca `src/lib/preco/parse-decimal-br.ts` toca também `supabase/functions/tint-import/index.ts`,
porque a edge carrega um espelho VERBATIM do parser entre `// MIRROR-START` / `// MIRROR-END`, exigido
pelo `src/lib/tint/__tests__/edge-parse-parity.test.ts` (Deno não importa de `src/`). A edge entra na
janela do `/fecho`, está fora do mapa de sondas, e sai `SEM_PROVA` → chip de deploy para o founder.

Só que a `tint-import` está **aposentada** desde #1401 (2026-07-17): o `Deno.serve` responde
`410 TINT_IMPORT_RETIRED` logo após `authorizeCronOrStaff`, sem executar nada. O deploy é **inerte** —
bundle novo e velho respondem o mesmo 410 —, e o chip é ruído que enterra o chip que importa (o custo
exato que o `edges-pendentes.sh` existe para cortar).

## Por que nenhuma das provas existentes serve

- **Prova passiva** (`fonte` da sonda vs `sonda-fingerprints.ts`): impossível — a edge não tem `versao.ts`,
  não está no mapa, e instrumentá-la seria instalar sensor num handler que não roda.
- **Prova ativa** (`sonda:sql`): teatro — o 410 vem ANTES de qualquer lógica, então a resposta seria
  idêntica em qualquer bundle desde #1401. Sondar não distingue nada.
- **Esperar**: não resolve (não há cron de sondagem — `docs/historico/` já registrou isso no #2188).

O que sobra é uma **declaração**: um fato sobre o handler que o git conhece e o banco não.

## O desenho

1. **Marcador declarado** `// EDGE-APOSENTADA: <motivo>` no `index.ts`. Declarado, e não inferido por
   `status: 410` no texto, porque inferência classifica errado: `omie-analytics-sync` tem uma **função**
   aposentada (`syncOrdersIncremental`) e a edge viva. Um marcador é decisão; um `grep 410` é acidente.
2. **Lido da REF (`origin/main`), nunca do working tree** — a lição do closure da
   `lovable-deploy-verify` §Passo 3 (2026-09-04): `git fetch` move a REF, mas `cat`/`grep` leem a árvore
   local, que pode estar atrás ou à frente. Marcador numa fatia não mergeada NÃO absolve; marcador
   mergeado que o working tree perdeu CONTINUA absolvendo. A suíte prova as duas direções com uma
   fixture git, e a falsificação troca `git show "$REF:…"` por `cat` e exige vermelho.
3. **INERTE vem antes da mecânica do banco**: sobrevive a `psql-ro` mudo, porque a prova é o git.
   Ausência de marcador (ou `git show` que falha) cai no ramo de sempre — fail-closed.
4. **`FECHO_REF`** (default `origin/main`) existe SÓ para teste/falsificação — apontar para branch
   local em uso real faria o `DESATUALIZADA` mentir. Foi o que permitiu falsificar contra o repo REAL:
   um commit temporário sem o marcador (construído por `GIT_INDEX_FILE` separado, working tree intacto)
   devolveu a `tint-import` a `SEM_PROVA`.

## O contrato do marcador é DUPLO — e o gate só fecha metade

- **(1) o handler é no-op.** Fechado por `supabase/functions/_shared/edge-aposentada-marcador_test.ts`:
  varre todas as edges; marcador sem `status: 410` no mesmo arquivo = vermelho (falsificado: marcador
  posto em `omie-analytics-sync` reprovou). E o conjunto marcado é lista FECHADA (`["tint-import"]`) —
  aposentar edge é decisão, aparece no diff. `tint-import/retired_test.ts` trava o par no outro sentido:
  410 sem marcador também reprova.
- **(2) a aposentadoria JÁ ESTÁ NO AR — PROVADA em prod (2026-09-06).** O script continua sem poder
  verificar: a prova é externa a ele, e foi obtida sondando. **Evidência:** `request_id` **71099**
  (`net._http_response`, `created 2026-09-06 18:46:41Z`) — `status_code` **410**, corpo
  `{"error":"tint-import foi aposentado","code":"TINT_IMPORT_RETIRED","detail":"…removido no #1314."}`.
  O `code` **discrimina o bundle**: `TINT_IMPORT_RETIRED` tem **0** ocorrências no pai do #1401
  (`git show b0092d884^:supabase/functions/tint-import/index.ts | grep -c TINT_IMPORT_RETIRED`) e na
  `origin/main` só sai deste `index.ts` (o `retired_test.ts` não vai ao bundle) — logo nenhum bundle
  pré-#1401 podia emiti-lo, e o INERTE não está suprimindo o deploy que instala o 410. De brinde, o
  `detail` voltou **byte a byte** igual ao da `origin/main`, o que é sinal de deploy verbatim daquele
  `return` (não do arquivo inteiro — só o ramo que respondeu).
  A evidência indireta anterior (`tint_importacoes` sem linha não-`sync_agent` desde 2026-04-17,
  re-medida em 2026-09-06) segue **consistente** com isso, e segue sendo ausência de sinal: quem
  fecha o contrato é o 410 acima.
  **A sonda foi barata nos DOIS bundles, e é isso que a torna segura — medido antes de disparar.** O
  "só sonde DEPOIS do deploy" da `lovable-deploy-verify` protege do bundle PRÉ-sensor que ignora o
  `{"probe":true}` e roda o fluxo real; aqui o fluxo real do bundle pré-#1401 **também** é inócuo para
  este corpo: sem `multipart/form-data` e sem `action`, ele cai em `handleChunkMode`, que devolve
  **400** por `tipo`/`rows`/`chunk_index` ausentes **antes** de qualquer `upsert`
  (`git show b0092d884^:…/index.ts`, linhas 492-503). Os dois bundles discriminam (410 vs 400) e
  nenhum escreve — a ordem que a skill trava por default não se aplica, e sondar ANTES respondeu de
  graça a pergunta que o marcador deixava aberta. É o mesmo raciocínio do `--caro` da
  `lovable-deploy-verify`: **quem decide é o EFEITO medido, não a forma do handler.**
  ⚠️ O veredito nasceu com os quatro ramos fechados no SQL, e nenhum outro se lê como aprovação: 401 é
  `INDETERMINADO_CREDENCIAL_RECUSADA` (`ausente ≠ zero` na dimensão CREDENCIAL), `status_code IS NULL`
  é `INUTILIZAVEL_TIMEOUT_SEM_CORPO`, 400 seria `BUNDLE_PRE_1401_WRITER_VIVO`. Ler qualquer um deles
  como "410 no ar" seria o falso positivo que ENCERRA a verificação.
  🔴 **O que esta prova NÃO diz: ela é de PASSADO, não de estado atual** (a ressalva do
  `BUNDLE_NOVO_OBSERVADO_EM_T` da `lovable-deploy-verify`). O 410 estava no ar às 18:46:41Z de
  2026-09-06; um deploy posterior que ressuscite o writer deixaria esta linha intacta. A `tint-import`
  não tem sonda de versão (nem `versao.ts`, nem entrada no mapa — `bun run sonda:sql tint-import`
  recusa com exit 1), então **reprovar o INERTE no futuro exige repetir esta sondagem**, não reler
  este parágrafo. O custo é uma linha de SQL, e ele acabou de ser medido.
  **Regra:** só coloque o marcador depois de confirmar o 410 em prod; é responsabilidade de quem marca.

## A classe, não o caso

Qualquer edge que (a) esteja aposentada com resposta fixa antes da lógica e (b) continue sendo tocada
por PR (espelho, `_shared/` importado só para tipos, fixture de teste) cai aqui. O sinal de que uma
edge pertence à classe: `SEM_PROVA` recorrente numa edge que ninguém chama. O remédio NÃO é sondar mais
nem esperar — é declarar, na REF, com o gate travando a declaração.
