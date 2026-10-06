# A onda que ninguém declarou — o aviso que faltava depois do gate (#2469, continuação de #2501/#2507)

> **Regra que sai daqui:** escolher o SINAL de um aviso antes de medir se ele dispararia no incidente
> que o motivou é teatro. Mede-se primeiro; se o sinal fica calado no caso real, ele não serve — e o
> aviso honesto é o que afirma só o que dá para afirmar sem adivinhar.

## O que aconteceu (2026-10-06)

A sessão recebeu a tarefa de impor ordem ENTRE edges da mesma leva no `pendencias:pacote` — o defeito
do #2469, em que o pacote listava `omie-vendas-sync` antes de `sync-reprocess` numa mensagem só,
contra a ordem que o corpo do PR exigia em prosa.

O protocolo de anti-colisão do `CLAUDE.md` (§Multi-sessão: procurar o ARTEFATO, não o título do PR)
achou a entrega já na `main`, em dois PRs:

- **#2501** — `scripts/lib/ordem-entre-edges.ts`, manifesto `supabase/functions/<B>/deploy-ordem.json`,
  pacote emitido em ONDAS, sucessora retida até a predecessora estar provada no ledger.
- **#2507** — `bun run ordem:declaracao` + workflow `ordem-entre-edges.yml`: esquecer o manifesto
  num PR que muda ≥2 edges fica vermelho.

A issue #2491 da descrição da tarefa é duplicata da #2493, que o #2501 fechou. Ela ficou aberta pela
falha conhecida da #2322 (o auto-merge registra o vínculo e não fecha a issue) — não por pendência.

**O que de fato faltava** era o caso espelho do que o gate cobre: a leva em que NINGUÉM declarou
nada. O #2469 não foi uma declaração errada; foi a AUSÊNCIA de declaração sobre duas edges que o
pacote juntou numa colagem — e o gerador seguiu calado.

## Medido antes de desenhar

| Medição | Resultado | Como |
|---|---|---|
| Manifestos no repo | **zero** `deploy-ordem.json` | `find supabase/functions -name deploy-ordem.json` |
| RPCs em comum entre as 2 edges do #2469 | **interseção vazia** | `coletarDaEdge` do repo: `criar_pedidos_com_itens` et al. contra `reconciliar_pedidos_omie` |
| Contexto exigido na proteção da `main` | só `validate` | `gh api .../branches/main/protection` |

A segunda linha matou o desenho que parecia óbvio. A tentação era avisar quando duas edges da leva
escrevem o mesmo domínio, usando sinal que o pacote **já colhe** (`agruparAlvos`: RPC → edges). Medido:
as duas edges do incidente não compartilham RPC nenhuma — a sobreposição está DENTRO do SQL
(`reconciliar_pedidos_omie` e `criar_pedidos_com_itens` escrevem o mesmo pedido). Um aviso por "RPC
compartilhada" teria ficado **calado no próprio #2469**: a máquina que não dispara no seu incidente
fundador é teatro (classe da issue #2398).

Ler o SQL das RPCs para saber as tabelas escritas seria extrator novo sobre money-path. Fica fora,
declarado abaixo.

## A decisão: AVISAR — nem recusar, nem seguir

- **Seguir calado** é o defeito. No #2469 ninguém foi perguntado.
- **Recusar** (exit ≠ 0) com zero manifesto no repo recusaria **toda** leva: 100% de falso-positivo no
  estado atual. Gate que recusa tudo é gate desligado, e o silêncio volta pela porta da frente.
- **Avisar** afirma só o que se afirma sem adivinhar: *nesta colagem saem 2+ edges e a ordem entre elas
  não está determinada por manifesto nenhum*. Pode não haver dependência — o pacote diz isso também.

O aviso sai nos **dois** lugares: no pacote (markdown que o operador lê antes de colar) e no stderr de
quem roda o comando. Não muda exit code.

`ondaSemOrdemDeclarada` (em `scripts/lib/ordem-entre-edges.ts`) decide: `< 2` liberadas → cala (colagem
de uma edge não tem ordem para errar); **todo** par da onda com regra → cala; senão nomeia a onda
inteira. Meia-ordem não é ordem: com 3+ edges, um par declarado deixa as outras relações abertas, e
regra cuja outra ponta está retida ou já no ar não determina nada entre as que saem juntas agora.

### Por que o gate do #2507 não cobre isto

Ele pergunta **por PR**; a leva do pacote vem do **ledger** e pode juntar edges de PRs distintos — caso
em que ninguém foi perguntado sobre aquele par. E `Ordem entre edges: nenhuma` é autodeclaração sobre
o PR, não sobre a leva que o ledger monta depois.

## O que fica descoberto (de propósito)

- **Risco por tabela/domínio.** Saber que duas edges disputam o mesmo registro exige ler o SQL das RPCs
  (ou o corpo das migrations) — extrator novo, money-path. O aviso nomeia a onda; quem decide se há
  dependência é quem escreveu as edges.
- **Contexto `ordem-entre-edges` não exigido na proteção da `main`** (medido acima): o gate do #2507
  é AVISO, não bloqueio, até o founder ligar o required check. Nenhum teste do repo prende isso — é
  configuração do GitHub.
- **Cobertura de eixo, não dente novo:** `[ORDEM_PAR_REAL_2469]` entrou como controle positivo com o
  par real (a predecessora `sync-reprocess` é a ÚLTIMA no alfabeto, então "ordem" e "alfabeto" ficam
  separados — todos os fixtures anteriores usavam `edge-a` → `edge-b`, colineares). Ele NÃO tem
  sabotagem exclusiva: tentei instanciar o mutante "libera a primeira alfabética" e ele morre em
  testes que já existiam, porque o planejador não decide por nome. Fica como teste de eixo.

## Falsificação

5 sabotagens novas em `scripts/falsificar-ordem-entre-edges.sh` (S26–S30), uma camada por vez, com o
controle verde na MESMA invocação por locale antes do 1º `replace`:

| ID | Alvo | Defeito instalado | Marca que tem de pintar |
|---|---|---|---|
| S26 | lib | colagem de UMA edge passa a avisar | `[ONDA_MUDA_UMA_EDGE_CALA]` |
| S27 | lib | regra com ponta fora da onda passa a determinar | `[ONDA_MUDA_REGRA_DE_FORA_NAO_CONTA]` |
| S28 | lib | meia-ordem passa por ordem | `[ONDA_MUDA_COBERTURA_PARCIAL_NOMEIA_A_ONDA]` |
| S29 | montador | o pacote volta a calar | `[PACOTE_ONDA_MUDA_AVISA]` |
| S30 | CLI | o terminal volta a calar | `[PACOTE_CLI_ONDA_MUDA_AVISA]` |

### Os dois mutantes que SOBREVIVERAM à 1ª rodada (56/60) — e o que cada um ensinou

A 1ª rodada saiu `NAO_FALSIFICADO`. Nenhum dos dois verdes foi descartado:

- **S26 era mutante EQUIVALENTE.** A guarda `if (onda.length < 2) return []` não tinha como pintar
  vermelho: com 0 ou 1 edge o contador de pares já dá `0`, e `0 === 0` cala pelo outro caminho. A
  camada era **redundante** — saiu do código, e a sabotagem passou a mirar o contador de pares.
  A regra do `CLAUDE.md` ("a que fica VERDE é redundante ou inalcançada") cobrou aqui, na prática.
- **S24 era verde-falso PRÉ-EXISTENTE, e a prova veio por medição, não por dedução.** Com o teste do
  `HEAD~1` e a sabotagem instalada: **47/47 verde**. Causa: `[PACOTE_INVENTARIO_CEGO_MECANICA]` casava
  só `exit 2`, e a MESMA frase ("não lista o index.ts de") sai de DUAS camadas —
  `lerManifestosDaRef` (1c) e `mapa-coerente-na-ref` (1d). Desligada a 1c, a 1d lançava texto
  idêntico: exit igual, mensagem igual, teste verde. **Dois lugares com a mesma mensagem tiram o
  dente de qualquer asserção por texto** — o dente passou a ser o rótulo de QUEM converteu em exit 2
  (`a ordem entre edges não pôde ser julgada`), que é o que separa 1c de 1d.

### Armadilha de ferramenta

`heavy bun run falsificar:ordem-edges` **deadlocka**: o script pede o slot do `heavy` por dentro e
entra na fila atrás de si mesmo. Fica parado para sempre, e "ainda rodando" parece progresso — a
classe do `evidencia-positiva-shell.md`, versão fila. A forma certa está na própria mensagem de fila:
`heavy env FALSIF_DENTRO_DO_HEAVY=1 bash scripts/falsificar-ordem-entre-edges.sh`.

## Validação

| O que | Resultado |
|---|---|
| `bun run typecheck` | **0** |
| `bun run lint` | **0 erros** (75 warnings pré-existentes) |
| `bun run lint:shell` | **0 achados** em 485 arquivos |
| suíte dos 4 arquivos tocados | verde (47 · 28 · 48) |
| `bun run test` (completo) | 10838 passed / **9 failed** — as 9 rodadas ISOLADAS passam (48/48 e 17/17, exit 0): contenção de CPU/RAM com ~30 sessões Claude vivas, não o diff |
| falsificação `falsificar:ordem-edges` | 1ª rodada `NAO_FALSIFICADO` 56/60 → corrigidas as duas camadas → 2ª rodada **`FALSIFICADO`: 60/60** (30 × 2 locales) pela marca certa, controles verdes, alvos restaurados |
