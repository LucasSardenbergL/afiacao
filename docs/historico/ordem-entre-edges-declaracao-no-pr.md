# A declaração de ordem entre edges no corpo do PR — esquecer o manifesto passa a ficar vermelho

> Continuação de [`ordem-entre-edges-da-mesma-leva.md`](ordem-entre-edges-da-mesma-leva.md) (#2501, issue #2493).
> Lá a ordem entre edges virou ARTEFATO (`supabase/functions/<B>/deploy-ordem.json`) e o pacote passou
> a sair em ondas. Faltava o outro lado, declarado em "O que fica descoberto": quem escreve a ordem só
> na prosa do PR e esquece o manifesto não via vermelho nenhum. No #2469 foi exatamente assim.

## Medido antes de desenhar (2026-09-14)

- **População.** 400 PRs squash da main (2026-08-26 a 09-15, ~20/dia). Mudam o CORPO de ≥2 edges
  (`contaComoCorpo`, só edge com `index.ts` no commit, `_shared/` fora): **16** (4%, ~0,8/dia). O #2469
  está entre eles. Os 16 também tocam `_shared/`. Contando o fan-out de `_shared/`, seriam 51 (13%):
  o triplo de PRs obrigados a declarar, com a mesma **uma** declaração real (#2469) medida no #2501.
- **O corpo muda depois do CI.** Em 150 PRs mergeados (#2313 a #2500), 40 tiveram o corpo editado, e
  **15 (10%) editaram depois da última execução do CI no head e antes do merge**. Em 10 desses houve
  `ready_for_review` depois daquele CI.
- **O caso de origem tinha a prosa desde a criação.** O corpo original do #2469 (00:28:43Z) já trazia
  `## Deploy` com "nesta ordem"; o CI rodou às 00:34:11Z; o merge veio 3,8 dias depois.
- **Draft que vira ready mergeia sobre o verde ANTIGO.** Dos 13 drafts prontos entre os 80 PRs
  mergeados mais recentes, **10 mergearam 7 a 18 s depois do `ready_for_review`, sem nenhum CI depois
  do ready**. Nenhum registra `AutoMergeEnabledEvent`.
- **Merge por comando acontece.** O próprio #2469 foi mergeado pela conta do founder (sessão de agente
  com o token dele) 7 s depois do ready, não pelo `github-actions`.
- **O check do agregador nasce tarde.** O check run de um job com `needs` só é criado quando o job
  entra na fila: o `pr-watch.sh` registra o `validate` do #2472 nascendo 3 s depois do último need.
- **A proteção da main** (leitura, 2026-09-14): clássica, `contexts: ["validate"]` preso ao app 15368
  (GitHub Actions), `strict: false`, `enforce_admins: false`, sem rulesets.

## As três opções pesadas

| opção | veredito | por quê |
|---|---|---|
| (Q) job no `ci.yml` + pré-condição no `auto-merge.yml` | rejeitada | O `ci.yml` só vê o corpo no push. Rodá-lo de novo em `edited`/`ready_for_review` não segura nada: o `validate` verde antigo continua valendo até o novo agregador nascer (~7 min), e o merge sai em 7 a 18 s. Desligar o auto-merge não segura o merge por comando (#2469). Custaria ainda uma entrada nova em `dispensados` da exclusividade, cujo motor sabota arquivo e não expressa "corpo de PR" |
| (L) só o `auto-merge.yml` | rejeitada | Mesmo buraco do merge por comando, e o `pr-watch` não trata vermelho não-obrigatório como desfecho |
| **(A) workflow leve próprio + contexto obrigatório** | **adotada** | Único desenho em que o check nasce NO próprio evento (job sem `needs`) e segura inclusive o `gh pr merge` sem `--admin`. Cada edição do corpo reavalia em segundos. O preço está abaixo |

O precedente contra mexer na proteção (`ci-testes-edge-deno.md`, `ci-validate-timeout-15min.md`)
valia porque ali um step no `validate` dava a MESMA cobertura. Aqui não dá: a mudança de corpo sem push
não chega ao `ci.yml` a tempo.

## A regra

- **Quem precisa declarar.** PR que muda o CORPO de ≥2 edges — `contaComoCorpo`, o predicado do
  `sonda:bump`, contando só edge com `index.ts` no HEAD e a fatia de `FATIAS_EM_SHARED` — ou que toca um
  `deploy-ordem.json`. `_shared/` fica fora pelo número acima (16 → 51).
- **O que vale como declaração.** UMA linha crua, na coluna 1, fora de bloco cercado (`removerCercas`, o
  stripper compartilhado), com esta caixa:

  ```text
  Ordem entre edges: nenhuma
  Ordem entre edges: sync-reprocess → omie-vendas-sync
  ```

  Pares vão separados por `;` ou `,`; `a → b → c` é cadeia; `->` vale como seta; nome entre crases vale.
  Duas linhas reprovam (qual delas vale?), e linha ilegível reprova mesmo fora da população. O que só
  PARECE a declaração — lista, negrito, crase, título, citação, indentação, outra caixa — não declara:
  vira dica na mensagem, com o número da linha.
- **Contra o artefato.** Todo par declarado tem de estar no manifesto de `b` no HEAD — reafirmar par que
  já existe não obriga tocar o manifesto. E todo par que um manifesto GANHA no PR (HEAD − base) tem de
  estar declarado: `nenhuma` não passa com par novo. Manifesto ilegível no HEAD é achado do PR; ilegível
  na base faz todo par dele contar como novo.
- **Exits.** `0` aprovado · `1` achado, com a marca `ORDEM_*` no início da linha · `2` não consegui medir
  (`ORDEM_MEDICAO_FALHOU`: rev que não resolve, `git` que falha, inventário sem edge ou sem um caminho do
  diff, releitura do corpo que falha). O `2` fica vermelho igual: não medir não é estar em ordem.
- **Onde.** `.github/workflows/ordem-entre-edges.yml`, job `ordem-entre-edges`, nos eventos `opened`,
  `synchronize`, `reopened`, `edited` e `ready_for_review`; sem `paths`, sem `if`, concorrência por PR com
  cancelamento. Re-run (`GITHUB_RUN_ATTEMPT > 1`) relê o corpo pela API, porque o payload do re-run é o do
  evento original. Sem `bun install`: o fecho de imports do gate é só builtin e `@/`.

## Ativação: o gate só segura o merge depois do founder

Sem o contexto na proteção, o job vermelho aparece no PR mas não barra o merge — o `pr-watch.sh` o relata
como `AVISO NAO-OBRIGATORIO`. Mudar a proteção é configuração de segurança, e a ordem importa: primeiro o
workflow na main, depois o contexto exigido. Ao contrário, todo PR aberto ficaria esperando um check que
não roda.

```bash
gh api -X PATCH repos/LucasSardenbergL/afiacao/branches/main/protection/required_status_checks --input - <<'JSON'
{"strict": false, "checks": [{"context": "validate", "app_id": 15368}, {"context": "ordem-entre-edges", "app_id": 15368}]}
JSON
gh api repos/LucasSardenbergL/afiacao/branches/main/protection/required_status_checks --jq '{strict, checks}'
```

A verificação tem de mostrar os DOIS contextos presos ao app 15368. PR que já estava aberto antes da
ativação só ganha o check num evento novo: editar o corpo basta.

## Fora do censo e da exclusividade — e por quê

- `exclusividade` mede o fecho de `validate.needs` no `ci.yml` e sabota UM arquivo por defeito. Este gate
  não está nesse fecho, e o defeito que ele pega — corpo de PR sem a linha — não se exprime como sabotagem
  de arquivo. A contribuição exclusiva se prova de outro jeito: nenhum outro gate do repo lê o corpo do PR
  (o #2469 passou por todos), e cada regra tem a sua sabotagem na falsificação abaixo.
- `gates:frescura` inventaria o `ci.yml` e o `settings.json`; os demais workflows entram só como invocadores.
  O censo do `deploy.md` não ganha linha.
- **A lacuna fica nomeada:** a máquina que prova "gate bloqueante tem dente" não enxerga contexto obrigatório
  fora do `ci.yml`. Até ela enxergar, o dente deste gate é o da falsificação de mão.

## Revisão independente: PENDENTE (Caminho B)

O `/codex` (`gpt-6-astra`, reasoning `max`) foi preparado com as medições acima e três opções, mas o
`scripts/codex-async.sh` saiu **75** sem parecer (tokens `?`): cota esgotada até **19/09/2026 13:21**,
com plano declarado `prolite`, o mesmo da conta paga. O limite é real. Pelo `docs/agent/money-path.md` isto segue pelo Caminho B: auto-challenge por escrito mais
falsificação executada, com **`REVISÃO INDEPENDENTE PENDENTE`**. Auto-revisão não substitui o
parecer; o Codex roda retroativo depois do reset.

### Auto-challenge: as oito perguntas que iriam ao Codex

- **Q1 — população.** A fatia de `FATIAS_EM_SHARED` entra, pelo mesmo predicado do `sonda:bump`. Edge nova
  conta, porque está no HEAD. Edge apagada não conta como corpo, mas o manifesto apagado conta como tocado.
  O buraco que sobra é a ordem que nasce só por `_shared/`, aceito pelo número: triplicar a população com a
  mesma declaração real treinaria o `nenhuma` sem pensar, que é o risco da Q2.
- **Q2 — `nenhuma` como carimbo.** É o risco principal, e não tem conserto mecânico: a máquina não lê prosa
  (30 parágrafos, 1 declaração). O que ela pega é a contradição com o ARTEFATO — `nenhuma` com par novo no
  manifesto reprova.
- **Q3 — consistência.** "O manifesto de B no diff" virou "no HEAD": reafirmar par que já existe não obriga
  churn. Retirar um par é PR que toca o manifesto, então exige declaração; qualquer forma válida serve, e o
  motivo da retirada mora no PR, como o #2501 já pedia.
- **Q4 — onde roda.** O que decide é o NASCIMENTO do check. Job sem `needs` ganha check run quando o run
  entra na fila, segundos depois do evento; o `validate` só nasce quando o último need termina. O run
  cancelado por um mais novo não fica como "o mais recente", porque o novo já criou o check dele. Um run
  cancelado À MÃO deixa o contexto cancelado, e isso trava (fail-closed), não aprova. Re-run relê o corpo.
- **Q5 — proteção.** Prender o contexto ao app 15368 impede status forjado por API. O ataque que resta é um
  workflow do próprio PR com job de mesmo nome: o `validate` pega (`[WF_NOME_UNICO_ENTRE_WORKFLOWS]`), mas o
  PR pode editar o teste — o limite de todo gate que mora na árvore do PR. Um sensor de deriva no CI
  exigiria token de admin como segredo; fica o eixo humano, com o comando de verificação acima.
- **Q6 — modelo da máquina.** Fora de `jobsBloqueantes` e do censo, com a justificativa da seção anterior.
  Em (Q), `dispensados` seria a válvula usada para o que ela não é.
- **Q7 — falsificação.** Uma sabotagem por regra do núcleo, por passo da fiação e por invariante do YAML;
  a lista está na seção de falsificação.
- **Q8 — é líquido-positivo?** O custo é ~0,8 PR/dia escrevendo uma linha, e editar o corpo reroda em
  segundos. O benefício é a classe do #2469 ficar vermelha e o manifesto não mudar calado. O que me faria
  não entregar — população de 13%, ou check que não segura merge — não se confirmou; o segundo depende da
  ativação, declarada. Aviso não-bloqueante para "palavra de ordem + `nenhuma`" foi rejeitado: com 29 de
  30 falsos positivos medidos, ensina a ignorar.

## Validado com o caso de origem

- **O #2469 teria ficado vermelho.** No commit dele (`31039c133`, `--base 31039c133^ --head 31039c133`), com o
  corpo original — a prosa "nesta ordem" —, o CLI sai `ORDEM_DECLARACAO_AUSENTE`, exit 1, citando
  `omie-vendas-sync` e `sync-reprocess`. Declarando `sync-reprocess → omie-vendas-sync` sem o manifesto, sai
  `ORDEM_MANIFESTO_AUSENTE`, exit 1, com o JSON a criar.
- **O runner não precisa de `bun install`.** No próprio PR que cria o workflow, o check `ordem-entre-edges`
  rodou no `opened` do draft e decidiu `ORDEM_DECLARADA_NENHUMA` em 9 s: o corpo tem exemplos cercados e uma
  linha real, e só a linha real contou.

## Falsificação

`scripts/falsificar-ordem-entre-edges-declaracao.sh` (`bun run falsificar:ordem-declaracao`), irmão do harness do
#2501: 68 sabotagens em três camadas — 42 no núcleo (gramática da linha, população, julgamento, formato), 13 na
fiação (diff, inventário com controle positivo, manifestos do HEAD e da base, releitura do re-run, exit) e 13 no
YAML e no `package.json` (cada invariante que faria o check exigido aprovar sem julgar, ou travar) — × `LC_ALL=C` e
`pt_BR.UTF-8`, com commit antes, controle verde na mesma invocação e marca ASCII exclusiva do vermelho.

- **1ª rodada: `NAO_FALSIFICADO`, 134/136.** As duas falhas eram a MESMA sabotagem inválida, e o harness a contou
  como falha, não como "o gate não pega": a D08 saiu `0 ocorrencia(s)` nos dois locales. A causa não era locale
  nem decodificação: no Bun, `String.raw` devolve o não-ASCII ESCAPADO — a seta vira o texto `→` —, e o
  trecho nunca casava com o fonte. Os acentos das sabotagens em string comum casaram nos dois locales. Corrigido
  no `1a3b86bb5`, com o porquê no próprio harness.
- **2ª rodada: `FALSIFICADO`, 136/136.** Controle verde nos dois locales e cada sabotagem vermelha pela marca
  certa — 40 da linha e do valor, 12 da população, 28 do julgamento, 4 do formato, 26 da fiação e 26 do YAML e do
  `package.json` (as contagens somam os dois locales). Alvos restaurados ao commit.
- **Duas invariantes do YAML passam sem o arquivo** (`WF_JOB_SEM_IF`, `WF_NOME_UNICO_ENTRE_WORKFLOWS`): são de
  guarda, e o dente delas se prova pelas sabotagens W04, W05 e W12.
- **Camadas redundantes, declaradas em vez de sabotadas:** a lista de status aceitos do `git diff -z` (o
  desalinhamento já lança pela paridade), o controle positivo do inventário da BASE (o do HEAD dispara antes em
  todo caso alcançável) e a recusa explícita de valor vazio (o caminho genérico recusa igual; muda só a mensagem).

## O que fica descoberto, de propósito

- **`nenhuma` que contradiz a prosa passa verde.** O gate não lê prosa, por desenho.
- **Ordem que nasce só por `_shared/`** não entra na população.
- **Os segundos entre editar o corpo e o check novo nascer:** um merge nessa janela usa o veredito anterior.
- **Antes da ativação o gate é aviso.** Depois dela, PR aberto que não recebe evento novo fica esperando.
- **`enforce_admins: false`:** `gh pr merge --admin` passa por cima — e é proibido de rotina pelo CLAUDE.md.
- **Manifesto em pasta que não é edge** (sem `index.ts`) reprova até ser apagado.
- **A linha dentro de comentário HTML multilinha** conta como declaração, embora não apareça no render.
- **O squash não carrega o corpo do PR:** a declaração vale no PR; a ordem que sobrevive ao merge é a do
  manifesto.
