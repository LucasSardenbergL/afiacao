# Isentar do `sonda:bump` o revert de edição do bot — desenhada, medida e REJEITADA

> 2026-09-27. Regra candidata (§6 de [agente-lovable-conserta-o-que-nao-pediram.md](agente-lovable-conserta-o-que-nao-pediram.md)):
> não cobrar bump de `VERSAO` do PR que devolve uma edge aos bytes de antes dos commits "Changes"
> do bot, para o ledger não fabricar DIVERGE_P1 e não pedir o redeploy que serve de isca. A regra
> foi implementada e medida: precisão 100% e recall 4/4. **Mesmo assim, não entrou.** O bump é o que
> força o redeploy, e é esse redeploy que devolve a certeza sobre o que prod roda depois da janela do
> bot. Regra que fica: **quando fonte e mapa divergem, o par `(versao, fonte)` que a sonda devolve é
> DECLARADO e não prova quais bytes rodam. Isenção que se apoia nele perde a única prova de verdade
> que existe: termos deployado nós mesmos.**

## 1. O desenho (o que foi implementado e medido)

Só o achado `sem-bump` concorre (`versaoBase == versaoHead == X`, com o corpo mudado). A isenção
vale se:

- **(a) canônico:** `C_X` é o commit que INTRODUZIU X, ou seja, o mais velho da corrida contígua de
  X em `git log --first-parent <base> -- <edge>/versao.ts`. O corpo COMPLETO do HEAD (todos os
  arquivos, com a régua do gate: `removerComentarios`, sem indentação e sem linha em branco, mais
  `FATIAS_EM_SHARED`) tem de ser igual ao de `C_X`. Um ancestral mais velho que a corrida não conta:
  o corpo da v1.0 restaurado sob a v1.1 é mudança real.
- **(b) só o bot mudou:** todo commit em `C_X..base` que alterou esse corpo tem autor
  `gpt-engineer-app[bot]`, e existe ao menos um. Commit humano sob X (pré-gate, `--admin`)
  provavelmente foi deployado.
- Não há janela de N commits ou N dias: o limite estrutural é a corrida de X. A caminhada tem teto,
  e estourar o teto significa "não provei", o que cobra o bump (fail-closed).

**Medição (o próprio gate decidindo):**

| | resultado |
|---|---|
| recall: os 2 reverts reais refeitos **sem** bump (commit sintético, `77c73e1cc` e `804affa4a`) | 4/4 pares edge×revert isentos, cada um com o canônico e os intrusos certos (`f84d7772e`/`eec8598d7`; `5552991e2`) |
| precisão: 116 fatias first-parent da `main` que tocam `supabase/functions/` desde `02fdad342` | 14 reprovadas antes → **14 depois**, com 0 isenção indevida; os commits do bot seguem reprovados |

O patch não entrou no repo. A descrição acima basta para refazê-lo se a §4 mudar.

## 2. Por que foi rejeitada (Codex, `gpt-6-astra` high, 165 s: **REPROVA**)

A rede de segurança que eu tinha proposto era falsa. Eu supunha que um corpo do bot deployado
apareceria como `INCOERENTE` no ledger, porque o bot nunca regenera o mapa e o par dele nunca
entraria na `main`. Só que a sonda **não** calcula o hash do código que está rodando: ela devolve
`FONTE_SHA256[edge]`, o valor ESTÁTICO do mapa compilado no bundle (`criarRespostaSonda`, em
`_shared/sonda-versao.ts`). O Codex recalculou o fecho da `sync-reprocess`:

| commit | VERSAO | mapa commitado | fecho recalculado |
|---|---|---|---|
| `591cbb9f5` | v1.9 | `a88a1175…` | `a88a1175…` |
| `1b654757d` (bot) | v1.9 | `a88a1175…` | **`13c44503…`** |

Se o corpo do bot tivesse sido deployado, prod responderia `(v1.9, a88a1175…)`, que é exatamente o
par canônico. Depois do revert isento, o ledger daria **CONFERE**, sem sequer passar pelo
`parCoerente`, com prod rodando `Number(codigoPedido)` no caminho de pedidos do Omie.

A cegueira não nasce da isenção. Durante a janela do bot o ledger **já** está cego: a `main` fica
com mapa defasado e prod responde o par canônico. Hoje quem desfaz essa cegueira é o redeploy que o
bump força depois do revert. A isenção trocaria "cego por algumas horas e depois consertado" por
"cego até a próxima mudança da edge". Nenhuma combinação de autor, git e mapa separa estes dois
mundos: "prod roda A e diz F_A" e "prod roda B e diz F_A".

Outros furos que o Codex apontou e que qualquer versão futura tem de tratar:

- o merge "Lovable update" do bot pode trazer mudança humana pelo 2º pai, e o `--first-parent`
  atribui ao bot;
- `normalizarFonte` dá `trim()` DENTRO de template literal. O gate atual já tem essa limitação, mas
  a isenção passaria a usar essa igualdade como prova POSITIVA de retorno;
- o retorno só normalizado (com comentário a mais ou com o `versao.ts` reescrito) muda o `fonte`
  mesmo assim e cai em P2.

## 3. O que a sessão mediu no caminho

- **Prod** (ledger, 18:40Z): `sync-reprocess` e `whatsapp-inbound` serviam `a88a1175…` e
  `1cd85745…` às 16:49–16:51Z, o mapa de `591cbb9f5`. Entre `591cbb9f5` e a `main`, a única
  diferença eram os dois `versao.ts` e o mapa. Com os bytes restaurados, `sonda:bump` e
  `sonda:fingerprint` davam exit 0 **sem isenção nenhuma**: o follow-up nunca precisou da regra.
- **O follow-up perdeu o objeto:** às 18:36–18:37Z outra sessão deployou as duas edges em
  v1.10/v1.2 (`list_messages`: 21 hashes conferidos, um `deploy_edge_functions` com as duas edges,
  e o fecho "No files were edited."; o typecheck da `whatsapp-inbound` foi só **reportado**). É o
  2º turno com o `blocoDeEscopo` do #2596 e zero edição, o que dá n=2 a favor da guarda no prompt.
- **Furo real, fora do escopo deste doc:** o `pendencias:pacote` lê o par esperado do mapa commitado
  e não confere se o mapa bate com a fonte da ref. Um pacote montado de uma `main` com commit do bot
  embarcaria o corpo do bot, e a sonda diria o par canônico. Esse é o canal por onde o contraexemplo
  da §2 aconteceria.

## 4. O que reabriria a regra

A isenção só volta a fazer sentido com uma prova, de fora do par autodeclarado, de que o corpo do bot
**não** foi deployado na janela. O `list_messages` do Lovable tem essa prova (a ordem das tool calls
do turno e os deploys seguintes), mas o CI não alcança o MCP, e uma declaração versionada no PR
seria disciplina, não gate. Enquanto isso, o revert de edição do bot **bumpa e redeploya**. Com a
guarda no prompt e o sensor pós-envio, esse redeploy deixou de ser isca (n=2).
