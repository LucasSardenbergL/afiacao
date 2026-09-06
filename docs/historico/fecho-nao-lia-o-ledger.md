# O `/fecho` pedia chip para edge já atestada — a prova durável existia e ele não a lia

> 2026-09-06. O Passo 3 do `/fecho` (`.claude/skills/fecho/scripts/edges-pendentes.sh`) classificava
> como `SEM_PROVA` toda edge sem sonda na **janela viva** de `net._http_response` (`pg_net.ttl` = 6 h)
> e abria chip. O ledger `public.deploy_atestacoes` — criado no #2199 exatamente para guardar essa
> prova além da janela — não era consultado: `grep -c 'deploy_atestacoes\|pendencias-deploy'` no
> script devolvia **0**. Desfecho: o script passou a perguntar ao ledger pelo
> `bun run pendencias:deploy --json`, e a falsificação do próprio harness, que era **vazia**, virou
> real. Regra que fica: **quem apaga pendência tem de consultar TODA fonte de prova durável que
> existe — e ausência de uma fonte que existe é ausência FABRICADA, não fail-closed.**

## 1. O defeito, no eixo do tempo

As duas metades do sistema mediam a mesma coisa com memórias diferentes:

| instrumento | fonte | memória |
|---|---|---|
| `pendencias:deploy` (#2199) | ledger `deploy_atestacoes` ∪ janela viva | até o `fonte` da main mudar |
| Passo 3 do `/fecho` | só a janela viva de `net._http_response` | **6 h** (TTL do pg_net) |

O percurso do custo: edge mergeada na janela do fecho, deployada e atestada há mais de 6 h → o
Passo 3 não vê linha nenhuma → `SEM_PROVA` → chip → o founder clica → a sessão nova roda
`pendencias:deploy` e descobre que já estava `✅ confere`. **Cada chip falso custa uma sessão.** E
o custo não para aí: com fan-out (um chip por sessão que fecha na mesma janela), a fila de chips
iguais enterra o chip que importava — exatamente o custo que o Passo 3 existe para cortar — e o
remédio que ele imprime (`bun run sonda:sql`) convida a **sondar de novo** o que já foi provado.
Em edge cara com bundle pré-sensor, isso não é ruído: o bundle velho ignora `probe` e a sonda vira
**uma execução do fluxo real por colagem** (`process-recurring-orders` cria `orders` e avança
`next_order_date`).

Medido em prod no dia (`bun scripts/pendencias-deploy.ts`): **46 das 54** edges mapeadas tinham
atestação no ledger, 8 nunca atestadas. As 46 eram exatamente a prova que o Passo 3 jogava fora
sempre que a última resposta tinha mais de 6 h.

## 2. O que entrou

- **`pendencias-deploy.ts --json`** — a MESMA varredura, serializada. Não se duplicou a matriz
  `(versao, fonte)` em SQL no shell: quem julga continua sendo o CLI, que já resolve
  `DIVERGE_P1/P2`, `INCOERENTE`, `NUNCA_ATESTADA` e lê o esperado de `origin/main`. O contrato é a
  marca de formato `pendencias-deploy/1` (`FORMATO_JSON`), e flag desconhecida sai **exit 3** em vez
  de cair no relatório humano — um consumidor que digitou `--jsn` leria texto como se fosse dado.
- **`edges-pendentes.sh` consulta o ledger** — e só onde há o que perguntar: edge **no mapa** e
  **sem resposta na janela viva**. Quem respondeu na janela é julgado por ela (evidência mais
  fresca; o `ledger ∪ janela` do CLI não pode ter nada mais novo).

| veredito do ledger | classificação no Passo 3 | chip? |
|---|---|---|
| `CONFERE` **e** `fonte` observado == mapa da REF | `LEDGER_CONFERE` | **não** |
| `CONFERE` com `fonte` ≠ mapa da REF | `LEDGER_DISCORDA` | sim |
| `DIVERGE_P1/P2` · `INCOERENTE` · `SEM_MAPA_NO_BUNDLE` | `LEDGER_DIVERGE` | sim, **PROVADO** e fora do DISPARE |
| `NUNCA_ATESTADA` · `SEM_FONTE_NO_ECO` · sem veredito | `SEM_PROVA` + diagnóstico na linha | sim |
| não consultado (7 avarias) | `LEDGER_NAO_CONSULTADO` + `SEM_PROVA` | sim |

Três decisões que valem além deste script:

1. **DUPLA CHAVE.** `CONFERE` do CLI não basta: o `fonte` que ele observou tem de ser igual ao
   `esperado` que o *próprio* Passo 3 leu do mapa da REF. Sensor que lê só o rótulo de outra
   máquina herda todo defeito dela — `gates-textuais-cegos.md`, "≥1 eixo POR FORA". A 2ª chave é
   esse eixo, e ela pega main que andou entre as duas leituras, REF apontada para outro lugar, e
   CLI mentindo.
2. **`LEDGER_DIVERGE` não entra no DISPARE.** Pendência provada não se sonda antes do deploy: a
   sonda não confirmaria nada e, no bundle pré-sensor, executa o fluxo real. A ordem é **deploy
   antes, sonda depois** — a mesma assimetria do `--caro` do `sonda:sql`.
3. **Fail-CLOSED com resposta POSITIVA.** Sete avarias testadas uma a uma — exit 0 com stdout
   vazio, saída que não é JSON, JSON de outro contrato, vereditos ilegíveis, exit 2, exit 3, exit
   127 (bun ausente). Todas viram `LEDGER_NAO_CONSULTADO` e a edge segue pendente **como antes de o
   ledger existir**. `command -v` não bastaria: presente-porém-quebrado esvazia o guard igual
   (`sonda-ausente-em-script-que-apaga.md`). E a mecânica do banco tem **precedência**: com o
   `psql-ro` reprovado o ledger nem é consultado, senão o fail-closed seria contornado pela porta
   lateral do mesmo wrapper.

## 3. O que a falsificação deste script ensinou (e o encontro com o #2219)

Ao escrever as sabotagens do ledger, um experimento simples derrubou a confiança no harness:
**duas sabotagens NO-OP** (trocar um travessão por um hífen dentro de um comentário) saíram
*"suite vermelha nos 2 locales"*, e a cópia **idêntica**, sem `sed` nenhum, já reprovava **8
casos**. A causa: `sabota()` escrevia a cópia em `$tmp` raso, e o alvo deriva o caminho do binário
auxiliar de `$0` — em `/var/folders/…` o `scripts/edges-afetadas.ts` some, os casos `--desde` caem
em exit 2, e as sabotagens assinavam vermelho por motivo alheio.

**O mesmo defeito foi diagnosticado e corrigido em paralelo pelo #2219**, que mergeou horas antes
desta entrega e generalizou a lição para os cinco arneses do `test:falsificacao`
([falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md)): cada um ganhou um
**CONTROLE** que roda a suíte com a sabotagem trocada por NADA e **aborta** se ela não estiver
verde. A correção mecânica dele — árvore-espelho em `$tmp` com a mesma profundidade do alvo e
symlink para o `scripts/` real — foi mantida no rebase; a minha (cópia ao lado do alvo) foi
descartada. Duas sessões chegando ao mesmo furo pelo mesmo caminho é o sinal de que a classe é
real, não um acidente: **falsificação sem linha de base prova que o teste REAGE, não que ele
estava certo antes de reagir.**

O que **esta** entrega acrescenta ao mesmo tema é um segundo caso da classe, este dentro da saída
do script: a **legenda do rodapé repetia os marcadores** (`DESATUALIZADA / PRE_SONDA_FONTE / …`).
A suíte julga o veredito procurando a marca na saída (`tem 'NO_AR'`), e marca que aparece também
no rodapé **casa em toda execução** — 12 casos novos passaram assim antes de a legenda ser
reescrita em palavras. É a sentinela NÃO-EXCLUSIVA do `verify-frontend.sh` em forma de legenda: a
string está lá, e por isso não prova nada. Regra que fica: **legenda de saída não repete o token
que o teste procura.**

## 4. Evidência

**Ponta a ponta contra prod, mesma edge, os dois scripts** (`dispatch-notifications`, última
atestação **8,99 h** atrás — fora da janela de 6 h):

| versão | saída | exit |
|---|---|---|
| HEAD (antes) | `SEM_PROVA … SONDA_ANONIMA` + `🎫 abra chip para: dispatch-notifications` | 1 |
| esta entrega | `LEDGER_CONFERE … fonte f29d8d0a… bate com a main (visto há 8.99 h via sonda)` | 0 |

E o lado que NÃO pode ser absolvido, na mesma rodada: `monthly-report` (ledger `NUNCA_ATESTADA`)
segue `SEM_PROVA` + chip, agora com o motivo na linha — `· ledger: NUNCA_ATESTADA (nunca vista em
prod — a 1a sonda e humana)`. O `--json` do CLI devolveu **54 vereditos** com a marca
`pendencias-deploy/1` e stdout limpo (só o JSON).


- `bash scripts/test-fecho-edges-pendentes.sh` — verde nos 2 locales (`C` e `pt_BR.UTF-8`), com 12
  casos novos de ledger: absolve com dupla chave, recusa `CONFERE` de fonte errada, mantém
  `NUNCA_ATESTADA` como chip, 7 avarias em fail-closed, `LEDGER_DIVERGE` fora do DISPARE, janela
  viva vencendo o ledger, edge fora do mapa não absolvida, e precedência da mecânica do banco.
- `--falsificar` — **33 sabotagens vermelhas** (24 antigas + 9 do ledger, uma camada por vez:
  dupla chave, marca de formato, exit anômalo, precedência da mecânica, janela viva vencendo, edge
  fora do mapa, divergência caindo no ramo genérico, invocação sem `--json`, diagnóstico sumindo),
  com o CONTROLE do #2219 verde antes da 1ª sabotagem.
- `bun run test` — o contrato `--json` pelas duas pontas: `lerArgs`, exit 3 na flag desconhecida,
  serialização com a marca e os campos, `NUNCA_ATESTADA` com `null` (ausente ≠ zero), e a
  **paridade textual** entre a marca do `.ts` e a que o shell exige.
- `shellcheck` limpo nos dois scripts · `bun run docs:indice docs:links docs:citacoes`.

## 5. O custo no CI, medido

O arnês do fecho ficou mais caro nas duas dimensões: **+9 sabotagens** (24 → 33) e uma suíte **~36%
mais longa** (12 casos novos + o caminho do ledger exercitado nos casos antigos). O número é de
**CPU** (`user+sys`), não de relógio: na M2 do founder, com ~22 sessões vivas, o mesmo comando
varia 3× entre execuções e uma medição de wall-clock chegou a dizer que a suíte SEM os casos novos
era mais lenta que a completa.

| medida | antes (origin/main) | depois |
|---|---|---|
| CPU de uma passada da suíte (2 locales) | 16,7 s | 22,7 s |
| sabotagens | 24 | 33 |
| projeção do passo `Falsificação` no runner | 125 s (medido) | ~230 s |
| projeção do job `validate` (teto 15 min) | 671 s (medido) | ~780 s |

Duas otimizações entraram por causa disso, e nenhuma reduz cobertura: o `jq` passou de **duas**
invocações para **uma** (a marca sai na 1ª linha, os vereditos nas seguintes), e a leitura dos
vereditos ficou **estrita** — `.vereditos[]` sem o `?`, para que `{"formato": ok, "vereditos":
"nao-e-lista"}` falhe em vez de virar "zero vereditos", que sairia como o estado LEGÍTIMO "sem
veredito para esta edge" e esconderia o payload corrompido.

A margem contra o teto de 15 min encolheu de ~230 s para ~120 s. É folga real, mas quem acrescentar
sabotagem a este arnês daqui em diante deve medir o passo, não presumir.

## 6. Limites nomeados

- O ledger prova a **última atestação**, não o estado instantâneo: um rollback pelo Lovable depois
  da atestação não é visto por ninguém (limite já registrado em
  [`deploy-redundante-ledger-e-cron-de-sonda.md`](deploy-redundante-ledger-e-cron-de-sonda.md)). Por
  isso a idade sai impressa na linha do `LEDGER_CONFERE`.
- `fonte` continua sendo identidade **autorrelatada da fonte**, não hash do bundle.
- O eval que EXECUTA o SQL
  (`.claude/skills/lovable-deploy-verify/evals/edges-pendentes-sql-eval.sh`) mede a janela viva; o
  ledger entra lá como **indisponível de propósito**, para provar que o fail-closed não mudou o
  comportamento anterior. Quem mede o ledger é a suíte de forma, com stub.
