# O agente do Lovable conserta o que ninguém pediu — e o sync empurra na main

> 2026-09-26/27. Duas vezes em dois dias o pedido de deploy verbatim saiu certo e, na MESMA rodada,
> o agente editou OUTRAS edges por conta própria. Desfecho: o prompt passa a proibir o que ele fez
> (nomeando-o), exige uma linha de confirmação, e um sensor por fora confere a resposta do MCP e os
> commits do bot na `main`. Regra que fica: **o escopo de um pedido ao agente é o que o prompt
> PROÍBE, não o que ele pede — e a conferência não é a palavra dele.**

## 1. Os dois incidentes (medidos)

| | #2541 (2026-09-24) | #2579 (2026-09-26) |
|---|---|---|
| pedido | deploy verbatim da `omie-sync-sku-items` | deploy verbatim da `omie-sync-estoque` v1.2 (sessão do #2573) |
| o que o agente fez certo | conferiu os hashes e publicou | conferiu os 7 `sha256` e publicou |
| o que fez sem pedido | editou `whatsapp-inbound` (`SupabaseClient<any>`) | leu `/tmp/observability/build-errors.log` e "corrigiu" `whatsapp-inbound` (`SupabaseClient<any>`) e `sync-reprocess` (`omie_pedido_id: Number(codigoPedido)`) |
| commits do bot na `main` | `de48dff0a`, `a20f2fe30`, `5c9ddaff2` | `f84d7772e`, `eec8598d7` ("Changes") |
| sintoma | `bun lint` vermelho em todo PR (`no-explicit-any`) | `sonda:fingerprint` vermelho na `main` |
| reparo | revert `1460ea5e7` | revert #2579 — com bump de `VERSAO` (o `sonda:bump` compara contra a main COM os "Changes"): `whatsapp-inbound` v1.1-revert-changes-lovable, `sync-reprocess` v1.9-revert-changes-lovable |

A mesma edição (`SupabaseClient<any>` na `whatsapp-inbound`) nas duas vezes: o `build-errors.log`
do sandbox acusa o typecheck Deno daquela edge, e o agente, prestativo, "conserta" o que vê. Não é
acaso — é uma isca permanente no ambiente dele. Sem trava, a 3ª vez era questão de tempo.

## 2. Por que o prompt não segurou

O prompt dizia *"Deploy it **verbatim** — do NOT modify, reinterpret, "improve", or reformat any
code"*. O agente obedeceu **à letra**: não modificou os arquivos DA EDGE pedida. O texto não dizia
nada sobre (a) OUTROS arquivos, (b) erros vistos em LOG e (c) o que fazer DEPOIS do deploy. As três
brechas são exatamente o caminho que ele tomou. Proibição para LLM tem de nomear o comportamento,
não a intenção.

## 3. O que entrou

- **`blocoDeEscopo()`** em `scripts/lib/prompt-deploy.ts`, nos DOIS ramos do `montarPrompt` (1 edge
  e leva) — logo, também no Passo 2 do `pendencias:pacote`: nenhum arquivo editado/criado/renomeado/
  apagado, "nem os listados nem qualquer outro"; erro de build/typecheck/warning visto em
  `build-errors.log` ou em qualquer lugar é **só listado**; vale "before, during or after the
  deploy"; e a resposta termina com a linha exata `No files were edited.` (ou a lista do que tocou).
  `MARCAS_DE_ESCOPO` entra no `conferirCobertura`: colagem sem qualquer frase reprova
  (`escopo:<frase>`), e o `pendencias:prompt` sai 2.
- **`scripts/lovable-sensor-edicao.ts`** — rode ≥5 min depois do envio, com a resposta salva em
  arquivo: `--desde <ISO do envio> <arquivo>`. Dois eixos por fora da palavra do agente:
  `edit_id`/`commit_sha` não-nulos na resposta do MCP (inclusive dentro de JSON embrulhado em
  string), e commits `gpt-engineer-app` na `origin/main` desde o envio — o `git fetch` é do script.
  Só `src/integrations/supabase/types.ts` é tolerado (o "Lovable update" que regenera os tipos a
  cada deploy limpo, medido em 2026-09-08 e 2026-09-26). Exits: 0 `SEM_EDICAO` · **1
  `EDICAO_DETECTADA`** · 2 mecânica · 3 `SEM_CONFIRMACAO` · 4 `CEDO_DEMAIS` · 5 `ILEGIVEL`.
- **O Passo 2 do pacote** manda anotar o instante do envio e rodar o sensor (só quando há colagem).

## 4. Desenho — as decisões que não são óbvias

- **Ausência de dado nunca vira `SEM_EDICAO`.** O sync empurra com atraso: ler a `main` logo depois
  do envio e achar zero commits é *ainda não*, não *limpo* (`CEDO_DEMAIS`, a lição do
  `espera-sem-desistencia.md` na dimensão tempo). Resposta vazia é `ILEGIVEL`. E a confirmação
  ausente é `SEM_CONFIRMACAO` — o agente não fez a parte dele, leia a resposta.
- **A confirmação é sinal FRACO, de propósito.** LLM afirma o que quiser; presença não absolve, e
  por isso edição provada em qualquer eixo vence a confirmação.
- **Tolerância por lista, não por prefixo.** `startsWith('src/')` tolerava o `src/App.tsx` que o
  agente decidisse "consertar" — falsificado (S10).
- **Retroativo como calibração.** Rodado com `--desde 2026-09-24T00:00Z` sobre o histórico real:
  pega os **5** commits dos dois incidentes e tolera os **2** de `types.ts` (exit 1).

## 5. Evidência

- `bunx vitest run` nas 5 suítes afetadas (`prompt-deploy`, `pacote-entrega`,
  `lovable-sensor-edicao`, `pendencias-pacote`, `pendencias-prompt`): `Test Files 5 passed (5)`,
  `Tests 131 passed (131)`, exit 0. (A 1ª execução morreu em `Timeout calling "fetch"` do worker sob
  ~11 GB de swap — mecânica, não código; reroda com `--maxWorkers=1`.)
- `bun run falsificar:prompt-escopo`: controle verde nos dois locales na MESMA invocação e
  **24/24** sabotagens (12 × `C`/`pt_BR.UTF-8`) vermelhas pela marca certa — frase amputada (S01-S03),
  bloco fora de cada ramo (S04/S05), cobertura cega (S06), pacote sem o sensor (S07), e cinco
  defeitos do sensor (S08-S12). Exit 0.

## 6. O que fica descoberto (nomeado)

- **O formato real da resposta do `send_message` não estava documentado.** O sensor busca as chaves
  em qualquer profundidade; a 1ª resposta real de deploy calibra (anote-a aqui).
- **O `list_edits` do MCP** é um terceiro eixo possível (edições do projeto no Lovable, antes do
  sync). Não entrou: o eixo `main` é o que importa (é onde o estrago vira código servido/CI), e ele
  já pegou os dois casos.
- **A isca continua lá.** O `build-errors.log` segue acusando a `whatsapp-inbound`; consertar o
  typecheck dela por PR revisado tira a tentação — entrega separada.
