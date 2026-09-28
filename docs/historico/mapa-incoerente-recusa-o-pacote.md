# O pacote recusa a ref cujo mapa de fingerprints não descreve a própria fonte

> 2026-09-27. Fecha o furo que o [sonda-bump-retorno-ao-canonico.md](sonda-bump-retorno-ao-canonico.md) §3
> registrou fora de escopo. **Regra:** o par `(VERSAO, fonte)` que a sonda serve é DECLARADO, lido do
> mapa ESTÁTICO. Só é prova quando o mapa descreve os bytes que vão ao ar. Por isso quem monta a
> colagem recalcula o fecho NA REF e recusa quando o mapa não o descreve.

## 1. O furo

- A sonda devolve `FONTE_SHA256[edge]`, que é constante do bundle (`criarRespostaSonda` em
  `_shared/sonda-versao.ts`). Ela não calcula hash do código que está rodando.
- O bot do Lovable (`gpt-engineer-app[bot]`) empurra commits "Changes" direto na `main`, sem PR e
  sem CI. Esses commits editam o corpo da edge e deixam o mapa como estava.
- `pendencias:pacote` e `pendencias:prompt` montam a colagem a partir da `origin/main` e liam o par
  esperado do mapa commitado **sem conferir se esse mapa bate com a fonte**. Uma colagem montada
  numa `main` com commit do bot põe no ar o corpo do bot, prod passa a responder o par canônico e o
  ledger dá **CONFERE**. No caso medido, o corpo do bot fazia `Number(codigoPedido)` no caminho de
  pedidos do Omie (`sync-reprocess`).
- O gate `sonda:fingerprint` do CI não alcança esse caso, porque o bot não passa por CI. O único
  lugar por onde todo deploy passa é o emissor da colagem.

## 2. O desenho

`scripts/lib/mapa-coerente-na-ref.ts` recebe a árvore do **SHA resolvido**, que é a mesma de onde
sai a fatia, e o `ls-tree` desse SHA. Uma edge está **no regime** quando tem `versao.ts` ou quando
o mapa a lista. As edges conferidas são as da leva e as **predecessoras** do `deploy-ordem.json`,
porque o par da predecessora é a prova que libera a dependente. Três regras decidem a recusa, que
sai com **exit 5**, sem pacote, sem colagem e sem SQL da nuvem:

1. **fonte:** o fingerprint do fecho recalculado com a régua do `sonda:fingerprint --write`
   (`fingerprintDaEdge`: `fecharGrafo` + `digerir`, e o `digerir` agora também lê da árvore) tem de
   ser igual ao do mapa. Edge com `versao.ts` que não aparece no mapa também é recusada.
2. **marcador:** edge listada no mapa e **sem** `versao.ts` é recusada.
3. **forma:** o arquivo do mapa tem de ser, byte a byte, o que o `--write` grava para as mesmas
   entradas.

A mensagem de recusa diz o porquê, o `git log` que mostra quem mexeu e o remédio. Edição não pedida
se desfaz com **revert por PR** (e bump). Edição legítima pede um **PR com `sonda:fingerprint -- --write`**.
Edge fora do regime não é conferida e o emissor **diz** isso no stderr.

Mecânica que não responde lança e dá exit 2: inventário que não lista o `index.ts` da própria edge,
mapa ausente ou que parseia vazio com edge instrumentada, import que não resolve.

## 3. Medição (a função nova decidindo sobre o git deste repo)

| | resultado |
|---|---|
| o caso do enunciado | `591cbb9f5` coerente · `1b654757d` recusa `sync-reprocess` (mapa `a88a1175` × fecho `13c44503`) **e** `whatsapp-inbound` (`1cd85745` × `7ecb507e`) · `main` de hoje coerente |
| precisão: 72 commits **humanos** first-parent da `main` que tocam `supabase/functions/` desde 08/2026 (e posteriores ao mapa) | **0 recusas**; o mapa estava na forma canônica em todos |
| recall: 4 commits do **bot** posteriores ao mapa | 3 recusados (`f84d7772e`, `eec8598d7`, `5552991e2`). O 4º (`5c9ddaff2`, 24/09) editou a `whatsapp-inbound` **antes** de ela ter sonda (`versao.ts` nasceu em `b1d69d29b`, 26/09): sem par declarado, não havia o que mentir. Nos commits que tocam edge no regime, **3/3** |

58 commits são anteriores ao mapa e não entram na conta.

## 4. Codex (`gpt-6-astra` high, 189 s): 1 P1 e 3 P2, todos resolvidos aqui ou declarados

- **P1: o mapa carrega código.** O `parsearMapa` só lê as linhas de hash e o mapa fica fora do
  fecho (é a saída). Codex acrescentou ao mapa uma reatribuição de `Number` com as entradas
  intactas, e o `pendencias:prompt` deu exit 0. → Virou a regra 3 (forma byte a byte).
- **P2: tirar o `versao.ts` e levar a sonda para o `index.ts` escapava.** Com o mapa intacto, a edge
  caía "fora do regime". → Virou a regra 2, e o regime passou a incluir "o mapa lista". O
  `foraDoRegime` agora é dito no stderr (antes o comentário prometia isso e o código calava).
- **P2: teste de ramo inalcançável.** O teste de mapa ausente pelo CLI esbarrava antes na
  `fatiaDeDeploy`, que já exige o mapa. → Passou a ser teste da lib.
- **P2: pontos cegos do extrator de imports** (comentário entre `from` e o literal, `import()` com
  template, atributos de import, bare specifier via import map, arquivo com nome de teste
  importado). É **limitação herdada** do `sonda:fingerprint` e não regressão. Codex comparou por AST
  os 241 arquivos de hoje e não achou nenhum caso. Está declarado no cabeçalho da lib; o conserto,
  se vier, é no extrator.
- Aceitos também: teste de predecessora **com ledger** (sem a conferência, a dependente sairia
  liberada com exit 0), recusa na 1ª rodada do `--sql-nuvem` e a linha ambígua do `deploy.md`
  ("stdout vazio" só significa "sem RPC" quando o exit é 0).
- **Onde concordou:** o SHA é único do começo ao fim (sem TOCTOU); a conferência vem antes da medição
  de banco e do `--sql-nuvem`; conferir as predecessoras é o escopo certo; nenhum consumidor
  transforma o exit 5 em sucesso ou em "nada pendente".

## 5. Prova

- `scripts/lib/mapa-coerente-na-ref.test.ts`: repo git **de verdade**, com `init`, um clone "lovable"
  que empurra o commit do bot e um `fetch`. O disco da worktree local fica no commit canônico **de
  propósito**: é o cenário real e é o que deixa vermelho um emissor que leia o disco em vez da ref.
  Cada recusa tem o controle verde no mesmo arquivo.
- `bun run falsificar:mapa-coerente`: 15 sabotagens × 2 locales (`C` e `pt_BR.UTF-8`), com controle
  verde na mesma invocação antes da 1ª sabotagem e vermelho exigido **pela marca do teste dono**,
  que tem de estar ausente no log do controle. Modelo: `falsificar-prompt-escopo.sh`.
  Resultado (2026-09-27, exit 0): `FALSIFICADO: 30/30 sabotagens (15 x 2 locales) viraram vermelho
  pela marca certa; controles verdes; alvos restaurados`.
- Os testes de ordem entre edges do `pendencias-pacote.test.ts` (#2469) montavam o mapa à mão, com
  hash inventado para a `edge-b` sem `versao.ts`. As regras 2 e 3 os recusaram (exit 5), como
  recusariam o mesmo mapa numa ref de verdade. O fixture passou a sair do `renderizarMapa` só com a
  edge instrumentada.

## 6. O que continua descoberto

- **O que já está em prod.** A recusa impede o **próximo** deploy de levar o corpo do bot. Ela não
  autentica o que está no ar. Se alguém deployou uma `main` com commit do bot antes deste gate, o
  par servido continua sem provar os bytes. A regra do `sonda-bump-retorno-ao-canonico.md` segue
  valendo: o revert **bumpa e redeploya**.
- **Deploy feito fora dos emissores.** Colar à mão no Lovable ou deixar o próprio agente do Lovable
  deployar a partir do workspace dele não passa por aqui. A defesa desse lado é a guarda no prompt e
  o sensor pós-envio (`lovable-sensor-edicao`).
- **A régua do fecho** tem os limites do §4 (extrator de imports).
