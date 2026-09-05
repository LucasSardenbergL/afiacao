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
- **(2) a aposentadoria JÁ ESTÁ NO AR.** O script não tem como verificar. Se o bundle no ar fosse
  anterior a #1401 (writer fail-open vivo), o deploy que INERTE suprime seria justamente o que instala
  o 410. Para a `tint-import` a evidência é indireta: `tint_importacoes` não tem linha não-`sync_agent`
  desde 2026-04-17 (medido em prod 2026-09-05) — consistente com o 410 no ar, mas ausência de sinal.
  **Regra:** só coloque o marcador depois de confirmar o 410 em prod; é responsabilidade de quem marca.

## A classe, não o caso

Qualquer edge que (a) esteja aposentada com resposta fixa antes da lógica e (b) continue sendo tocada
por PR (espelho, `_shared/` importado só para tipos, fixture de teste) cai aqui. O sinal de que uma
edge pertence à classe: `SEM_PROVA` recorrente numa edge que ninguém chama. O remédio NÃO é sondar mais
nem esperar — é declarar, na REF, com o gate travando a declaração.
