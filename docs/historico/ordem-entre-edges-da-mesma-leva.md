# A ordem ENTRE edges da mesma leva — o pacote juntou o que o PR mandava separar (#2469)

> Irmão de [`ordem-entre-camadas-do-mesmo-pr.md`](ordem-entre-camadas-do-mesmo-pr.md) (#2285): lá a ordem
> que faltava era banco → edge; aqui é edge → edge. Mesma lição, um andar ao lado — **a dependência
> tem de existir como ARTEFATO VERIFICÁVEL, não como parágrafo**.

## O que aconteceu (2026-09-14, ~20:20Z)

O deploy de edge pela sessão é `pendencias:deploy --json` → `pendencias:pacote -` → o **Passo 2** do
pacote vai verbatim para `mcp__lovable__send_message`. Na leva do #2469 (merge `31039c133`, money-path:
o total do pedido deixou de ser BRUTO e passou a LÍQUIDO), o pacote `2a52229c0e39` gerou **uma**
mensagem — *"Edit the following **two** existing edge functions … Deploy all of them"* — listando
`omie-vendas-sync` e depois `sync-reprocess`, sem ordem nenhuma entre elas.

O corpo do PR exigia o contrário, em prosa: *"2 edges, pelo MCP, nesta ordem: `sync-reprocess` →
`omie-vendas-sync`. Na ordem inversa, o reprocess velho reescreveria de volta para bruto os pedidos
novos da janela dele."* Não houve dano só porque OUTRA sessão leu o PR e mandou `sync-reprocess`
sozinha, antes. **Sorte, não processo:** uma sessão que seguisse o `/fecho` ao pé da letra colaria as
duas juntas.

Na main não havia noção de ordem entre edges — nem em `scripts/pendencias-pacote.ts`, nem em
`docs/agent/deploy.md`. O gate de ordem que existia é banco → edge (#2285, #2369, #2428, #2439).

## Medido antes de desenhar

- **A prosa é canal ruim.** 400 PRs mergeados: 28 com seção `## Deploy`; 3 citando ≥2 edges nela;
  **1** declarando ordem entre edges (o próprio #2469). No corpo inteiro: 94 citam ≥2 edges e 30 têm
  parágrafo com ≥2 edges + palavra de ordem (`ordem`/`antes`/`depois`/`→`/`first`) — **1 verdadeiro
  em 30**. O resto é tabela de edges, ou ordem banco → edge escrita fora de `## Deploy` (#2405, #2427).
- **Uma mensagem não ordena nada.** O agente do Lovable deploya do sandbox
  (`supabase--deploy_edge_functions`); nenhuma garantia de sequência nem de prova entre as edges da
  mesma mensagem. Numerar as seções não muda isso.
- **O caso real já terminou.** No ledger, às ~21h UTC, `sync-reprocess` e `omie-vendas-sync` estavam
  `CONFERE` na v1.7, atestadas pelo cron havia 0,34 h. Por isso esta entrega **não** cria manifesto
  para o #2469: sem inércia (abaixo), ele imporia uma ordem obsoleta a todo deploy futuro da
  `omie-vendas-sync`.

## As três opções pesadas

| opção | veredito | por quê |
|---|---|---|
| (a) ler os PRs desde o `fonte` atestado e parar quando `## Deploy` declara ordem | **rejeitada como fonte** | precisão 1/30; cega à ordem escrita fora do cabeçalho; `gh` vira dependência na hora do deploy; o corpo muda depois do merge |
| (b) ordem declarada num arquivo versionado junto da edge | **adotada** | offline, lido do MESMO commit que a fatia, validável no CI |
| (c) uma mensagem por edge, com aviso de que o gerador não sabe a ordem | **rejeitada como gate** | mensagens em ordem ARBITRÁRIA erram igual a uma só, e o aviso é recado. Dela ficou só o mecanismo: **onda = mensagem** |

## O desenho entregue

- **Manifesto** `supabase/functions/<B>/deploy-ordem.json` junto da edge DEPENDENTE:
  `{"formato":"deploy-ordem/1","depoisDe":[{"edge":"<A>","motivo":"…","pr":N}]}`. Parse estrito
  (chave desconhecida lança). Fica fora do fecho de imports, então não muda o `fonte` nem pede bump —
  `.json` não conta para o `sonda:bump` (`EXT_CORPO`) e o gate do repo prova que nenhum fecho o importa.
- **Planejador** `scripts/lib/ordem-entre-edges.ts` (puro). B só é LIBERADA quando cada predecessora A
  está **provada**: o par `(versao, fonte)` observado de A no ledger é o par da REF@sha do pacote (mapa
  commitado + `versao.ts`, pelos mesmos leitores do ledger), e a observação tem idade REAL — idade no
  ledger + idade do JSON — entre `ASSENTAR_MIN` (10 min) e `FRESCOR_MAX_H` (6 h). **Estar na leva não
  prova nada.** A na leva ⇒ B `ADIADA` (sai na próxima execução); A sem prova e fora da leva ⇒ B
  `BLOQUEADA` (exige ação). Leva por nome, JSON sem `geradoEm` ou com mais de 30 min ⇒ bloqueia.
  Ciclo ⇒ mecânica.
- **Ondas no pacote.** A colagem traz só as liberadas; as retidas aparecem numa seção própria, **sem
  colagem**; o Publish some enquanto houver retida; a pós-condição separa a prova da ONDA da prova da
  ENTREGA. Exits: `0` integral · `1` nada · `2` mecânica · `3` nenhuma colagem · **`4` onda parcial**.
  O SHA do pacote passa a incluir regras, par exigido e partição — só quando há regra, então a leva sem
  manifesto mantém o SHA de sempre.
- **Inventário que prova ausência.** `arvoreDaRef().ler()` devolve `null` para "não está no commit" e
  para "o git falhou". Para arquivo opcional isso se leria "sem ordem". O manifesto sai de um `ls-tree`
  que tem de responder e de listar o `index.ts` de cada edge pedida; manifesto listado e ilegível é exit 2.
- **O outro emissor.** `pendencias:prompt` também montava colagem; agora recusa (exit 3) a leva com
  manifesto e aponta o pacote, e passou a ler a árvore pelo sha resolvido (#2428).
- **`geradoEm`** entrou no `pendencias:deploy --json` (campo aditivo): sem ele a idade de uma prova é
  relativa a um instante desconhecido.

## O parecer do Codex, e o que mudou por ele

`gpt-6-astra` · reasoning `max` · 403 s · 108.724 tokens, sobre a proposta inicial (que tinha inércia
por VERSAO e prova por `CONFERE` + `fonte`). Achados e destino:

| achado | severidade | destino |
|---|---|---|
| inércia por VERSAO libera B `INCOERENTE` (VERSAO nova, `fonte` velho) | P1 | **retirada**: a declaração vale até um PR a retirar |
| a "dupla chave" aceitava prova de 31 dias; o JSON não diz o sha medido | P1 | prova refeita contra a REF@sha, par completo, janela de idade real e `geradoEm` |
| `ler()` → `null` ambíguo transforma falha de git em "sem ordem" | P1 | inventário por `ls-tree` com controle positivo |
| `pendencias:prompt` emitia colagem sem gate | P1 | recusa com exit 3 |
| sonda nova de A não prova que a invocação velha terminou | P1 | assentamento de 10 min (> 400 s de wall-clock pago, [limites do Supabase](https://supabase.com/docs/guides/functions/limits)); o resto é residual declarado |
| exigências podem se perder entre releases | P2 | manifesto cumulativo, sem escopo de versão; retirada só por PR |
| onda não é entrega; Publish depois de "Active" | P2 | Publish some com retida; pós-condição da onda |
| tripwire de prosa: no CI do PR, lendo o corpo (evento `edited` incluso) | Q4 | **não nesta entrega** — vira PR próprio (a lacuna de autoria abaixo) |
| exit `4` para onda parcial; SHA com regras, SHA alvo e partição | Q6 | exit `4` adotado; SHA com regras, par exigido e partição, mas **sem** o sha do commit: a identidade do pacote segue sendo de CONTEÚDO (#2362) |
| serialização entre sessões, reversão posterior, deploy manual | Q7 | residuais do runtime, abaixo |

## O que fica descoberto (de propósito)

- **Ordem escrita só em prosa não é declaração.** A máquina não lê o corpo do PR. Quem escreve a
  seção de deploy com ordem entre edges tem de commitar o manifesto — e o tripwire que tornaria o
  esquecimento vermelho (Q4 do Codex) é entrega separada.
- **Reversão de A depois de B subir**, deploy manual fora do pacote, invocação que se re-agenda além
  do assentamento e corrida entre sessões são controles de runtime/executor: um gerador de markdown não
  os garante. O "RE-MEÇA antes de enviar" do `/fecho` segue sendo a mitigação da corrida.
- **Worktree com o GERADOR velho** (código anterior a esta entrega) ainda emite a colagem única. O
  Passo 3 do `/fecho` sincroniza (`git checkout --detach origin/main`) antes de medir.

## Falsificação

_(preenchida após a execução do `scripts/falsificar-ordem-entre-edges.sh`)_
