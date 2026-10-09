# A sonda lia a fonte da verdade — do worktree DEFASADO

> Alvo: `scripts/sonda-versao-sql.ts` (`bun run sonda:sql`). Receita vigente:
> `docs/agent/deploy.md` §"Sondar VÁRIAS edges numa tacada (leva inteira)".
> Medido em 2026-09-05, numa verificação real de deploy.

## O defeito

O gerador do SQL de sondagem existe **porque transcrever `esperado(edge, versao_esperada,
fonte_esperada)` na unha produz veredito falso**. O cabeçalho dele diz isso com todas as letras:
"marcador digitado errado produz VEREDITO FALSO — 'BUNDLE VELHO' numa edge que está no ar (e o
desfecho é redeployar edge de money-path à toa)". Por isso ele lê o `versao.ts` de cada edge e o
`_shared/sonda-fingerprints.ts` **do repo**, em vez da memória do operador.

O buraco: **"o repo" pode ser um checkout velho.** O gerador lê o disco do worktree onde o agente
está; o Lovable deploya a **`main`**; e o veredito compara o que está NO AR contra o que o disco diz.

Em 2026-09-05 o worktree estava em `21e900155`, dois merges atrás de `origin/main`. Verificando
`enviar-pedido-portal-sayerlack`, o gerador emitiu:

```
versao_esperada = v1.5-custo-portal-rpc-cas       # o que ESTE disco tinha
```

A main já estava em `v1.7-enviado-igual-aprovado` — #2194 e #2198 tinham mergeado. A edge no ar
respondeu `v1.7`. O veredito comparado teria sido `v1.7 ≠ v1.5` ⇒ **"BUNDLE VELHO SERVINDO" numa
edge recém-deployada**. Falso NEGATIVO de money-path, cujo desfecho é redeployar à toa e desconfiar
de um deploy correto.

**Só não saiu errado por acidente.** O request tinha 37 min e a janela padrão é 20, então o veredito
caiu em `INDETERMINADO` pelo guard temporal (#2079) antes de chegar à comparação. Sincronizando com
`git merge --ff-only origin/main` e repetindo com `--janela=120`, saiu `DEPLOY CONFIRMADO`.
Um acidente de temporização foi o que separou o sistema de um veredito falso — não o desenho.

## A classe: a proteção não se aplicava a SI PRÓPRIA

O eixo já estava nomeado neste mesmo domínio. `docs/agent/deploy.md` registra, desde o #2123, que
**"o `<sha>` do PR nomeado é a pergunta ERRADA — o Lovable deploya a main"** para o *closure* de
deploy. O gerador aplicava esse eixo ao objeto que ele julga (a edge no ar) e **não a si próprio**
(a fonte de onde tira o esperado).

Forma geral, que vale além deste script:

> **Ler a fonte da verdade "do repo" só é melhor que a memória do operador se o repo estiver na
> versão que a produção serve.** Um script que substitui digitação por leitura de arquivo trocou
> um eixo de erro (transcrição) por outro (defasagem) — e o segundo é pior, porque é silencioso:
> ninguém *sente* que o worktree está atrasado, enquanto um typo às vezes salta aos olhos.

É irmã da classe **"fatia de deploy envelhece"** (`fatia-de-deploy-envelhece.md`): lá o bloco de
sonda já entregue ao founder envelhecia porque a main andava; aqui é o bloco sendo GERADO que já
nasce velho. Mesmo relógio, dois pontos da linha.

## O fix

`conferirSincronia`, fail-CLOSED, **antes de emitir SQL**:

1. `git fetch origin main`;
2. compara, byte a byte, a **fatia que vira o `esperado(...)`** — o `versao.ts` de cada edge PEDIDA
   e o `_shared/sonda-fingerprints.ts` — entre o working tree e `origin/main`;
3. divergiu, ou **não existe** em `origin/main` (bump que ainda não mergeou) ⇒ **aborta**, nomeando
   os arquivos e entregando `git fetch origin && git merge --ff-only origin/main`.

Nada de SQL parcial e nada de warning: pela mesma razão que o gerador já derruba a leva inteira
quando uma edge está sem `versao.ts` ou fora do mapa. Um aviso que se lê e ignora devolve o veredito
falso de 2026-09-05 com uma linha de texto por cima.

**A fatia é fechada de propósito.** `supabase/config.toml` fica de fora: o `project_ref` decide
PARA ONDE a sonda vai, e um ref velho falha ALTO (404 do gateway) — não vira "bundle velho". Só
entra no guard o que vira **veredito comparado**.

### Por que o `git fetch` é do SCRIPT, e não um recado no doc

Comparar contra a `origin/main` **que está em disco** é o mesmo defeito um nível acima: o
remote-tracking ref também é um retrato, e um worktree sincronizado com um `origin/main` de três
dias atrás reproduz o falso negativo inteiro. "Sincronize antes de MEDIR" (CLAUDE.md) só vale se a
sincronização for parte da **medição** — recado em doc não é gatilho (`sonda-marcador-congelado.md`
mediu isso: a regra documentada foi violada 7 minutos depois de ser escrita).

Medido antes de decidir, em 2026-09-05, neste repo:

| operação | custo |
|---|---|
| `git fetch origin main` | **0,89 s** |
| `git show origin/main:<arquivo>` | **0,03 s** |

Barato demais para valer um recado. E — também medido, rebaixando `refs/remotes/origin/main` à mão
e vendo o fetch restaurá-lo — **`git fetch origin main` ATUALIZA `refs/remotes/origin/main`**, então
a ref que a comparação lê é a mesma que o comando de correção usaria. (Se não atualizasse, o guard
estaria comparando contra o retrato velho enquanto *achava* que tinha sincronizado.)

### A decisão sobre "não consigo consultar a `origin/main`"

Ausência de dado não é aprovação — mas travar o gerador offline podia custar mais que o defeito.
O que decidiu, medindo em vez de supor:

- **Sem rede, o veredito é inalcançável de qualquer jeito.** O disparo é `net.http_post` contra o
  Supabase e a leitura é `psql-ro` contra a prod. O único uso real do gerador offline é preparar o
  texto para colar depois. O custo de travar é, portanto, pequeno — mas não zero.
- **A escada é `--sem-rede`, explícita, e ela NÃO desliga o guard**: pula **só o `fetch`**. A
  comparação continua acontecendo, contra a `origin/main` que está em disco. Divergência achada
  contra um ref velho é **dado positivo** de defasagem e aborta igual; o que a flag admite é o
  inverso — *bater* contra um retrato velho não prova sincronia.
- Por isso o caminho degradado **imprime a idade do ref**, no stderr **e no topo do SQL** como
  comentário `--`. O stderr some; o SQL é o artefato que sobrevive, colado num chat ou num PR.
  (Verificado executando: o SQL com o comentário roda no `psql-ro`, marcador de fim presente,
  zero `ERROR`.)
- **`origin/main` que não existe aborta mesmo com `--sem-rede`**: não há com o que comparar. A flag
  diz "sem rede", não "sem guard".

Distinguir os dois níveis de degradação foi o ponto: a alternativa preguiçosa — uma flag que pula o
guard inteiro — teria devolvido exatamente o defeito para quem digitasse a flag por hábito.

### `DependenciasCli.git` é OBRIGATÓRIO

O guard mora no `main()` (a fronteira que EMITE; `gerarSqlDaLeva` só monta a string, e é assim que
os *evals* da skill `lovable-deploy-verify` continuam podendo gerar SQL contra uma raiz sintética).
O `git` entra por injeção, e o campo é **obrigatório no tipo**: opcional-com-default sumiria em
silêncio para quem esquecesse de passá-lo, e **um guard que some é fail-OPEN**. Com o campo
obrigatório, o compilador cobra — e cobrou: os 3 testes que já chamavam `main` pararam de compilar.

A leva é resolvida **antes** do guard porque as duas falhas competem pelo mesmo texto e a da leva é
mais específica: uma edge sem `versao.ts` deve ouvir "sem sensor", não "não existe em origin/main".

## A prova (executando, e falsificada)

**Ponta a ponta, com o `git` de verdade:**

| cenário | resultado |
|---|---|
| worktree sincronizado | `exit 0`, 7.385 bytes de SQL, `v1.7-enviado-igual-aprovado` no `esperado` |
| `versao.ts` rebaixado ao conteúdo de `21e900155` | `exit 1`, **0 bytes** de SQL, erro nomeando o arquivo e o `git merge --ff-only` |
| `--sem-rede` | `exit 0`, SQL com o aviso no topo; executado no `psql-ro` (marcador de fim, 0 `ERROR`) |

**Falsificação** — 8 mutações novas em `scripts/mutcheck.d/sonda-versao-sql.mut`, todas exigidas
`PEGA`: guard desligado no `main`; divergência virando warning; comparação de conteúdo invertida;
bump não-mergeado deixando de contar; a fatia perdendo o mapa de fingerprints; o `fetch` sumindo
(comparar contra retrato velho por padrão); `fetch` que falha degradando em vez de abortar; e
`--sem-rede` passando a valer sempre (o guard virando opt-in).

Limite **conhecido** da medição, registrado no próprio `.mut`: o `r.status ?? 127` do `gitReal`
(spawn morto por sinal/timeout ⇒ fail-CLOSED) não tem mutação — `git` fora de repo devolve 128 e não
`null`, e forjar um spawn morto viraria teste do Node, não do guard. É limite nomeado, não
cobertura silenciosa.

---

## Epílogo (2026-09-09): a fatia certa não é uma LISTA — é o que o resolvedor LEU

O guard acima nasceu com a fatia escrita à mão: `fatiaDaVerdade(edges)` devolvia os `versao.ts` das
edges pedidas mais o mapa de fingerprints. Uma lista mantida **à parte da lógica de leitura** que
ela existe para vigiar. Enquanto os dois lados concordarem, funciona; e nada obriga os dois lados a
concordar. No modo `--canaria` eles já discordavam nos **dois sentidos** — medido com a CLI real:

- **sobrava** o mapa: o modo canária não o lê (`grep -c -i fingerprint` em ~20 KB de SQL emitido por
  quatro canárias deu **0**). Conferir arquivo que não participa do resultado não fecha veredito
  falso nenhum — só produz bloqueio, e um bloqueio de rotina, porque o `sonda:fingerprint` exige
  regravar esse mapa a cada mudança em `_shared/`;
- **faltava** o `index.ts`, de onde o `contrato: "..."` da canária de fato sai. Um `contrato:`
  alterado e não mergeado saía no SQL como marcador esperado e o guard não notava: `exit 0`, 9 545
  bytes, o marcador FABRICADO dentro. A canária no ar responde o contrato antigo, o veredito sai
  `CANARIA DE OUTRA FATIA`, e isso **se lê como deploy pendente** — o falso de 2026-09-05 de volta,
  pela porta que ninguém vigiava.

O eixo dos dois erros é o mesmo, e é o que vale guardar:

> **Fatia de guard tem de ser DERIVADA da leitura que ela vigia, nunca uma lista paralela.** Quem
> resolve o marcador é quem sabe de que arquivos ele saiu — então é ele que declara a fatia
> (`proveniencia`), no mesmo gesto em que resolve. Lista à parte erra nos dois sentidos ao mesmo
> tempo, e os dois são invisíveis: a sobra se lê como CI chato, a falta se lê como deploy pendente.

E o teste que "cobria" isso passava por **acidente**: o espelho de `origin/main` divergia por
*substring* do nome da edge, então pegava o `versao.ts` — que, para uma canária de
`campoMarcador: 'contrato'`, não alimenta o `esperado(...)`. Divergência no arquivo irrelevante,
cegueira no que decide. **Teste de fatia tem de nomear o caminho EXATO**; casar por substring aprova
a fatia errada com a mesma cor de verde.

### A metade que o Codex viu: conferir a SEGUNDA leitura não é conferir

O gerador lia os arquivos e o guard lia de **novo**. Duas leituras são duas medições: o
`esperado(...)` sai da primeira e a aprovação vem da segunda, e nada as obriga a concordar. A
correção é a proveniência carregar os **bytes**, e `conferirSincronia` receber as fontes **sem a
raiz** — não tem como reler, e quem garante isso é o compilador, não um comentário.

Daí duas portas novas, as duas do tipo *ausente ≠ zero*: **fatia vazia aborta** (não ter conferido
nada não é ter conferido e aprovado — fecha o modo futuro que esqueça de declarar proveniência) e
**o mesmo arquivo lido com bytes diferentes na mesma execução aborta** (a corrida acontecendo;
escolher qual leitura vale é escolher qual metade do veredito é a verdadeira).

Mesma doutrina do #2427, achado no mesmo dia noutro gate: *procedência vira argumento obrigatório*.

### E a sonda do próprio laço de falsificação mentiu primeiro

A primeira rodada do laço abortou sozinha (`exit 8`) e essa é a parte que vale contar: o controle
media "testes verdes" contando linhas com `✓`, e o reporter agrega o arquivo numa linha só —
devolveu **1** onde havia **177**. O laço recusou em vez de aprovar com dado ruim, e a sonda passou
a ler o número que a suíte reporta. Um controle que mede errado para BAIXO só custa uma rodada; se
medisse errado para cima, teria avalizado sete sabotagens sem rodar nenhuma.

Fechado em #2435 (issue #2414). O #2422 tinha atacado só a sobra — comparando o mapa por entrada,
mas mantendo o modo canária conferindo um arquivo que ele não lê — e foi fechado sem mergear.

## Recorrência (2026-09-10): o guard da allowlist no `pendencias:deploy` — e o remédio era um UPDATE

O `pendencias:deploy` nasceu em volta desta lição (`REF_MAIN`: "o instrumento lê a ref, não a
árvore"). A seção do cron de sonda, que veio depois, reintroduziu o disco por um `import`:
`SONDA_CRON_ALVOS` era a allowlist que decidia "intruso". Num worktree 10 commits atrás,
`omie-desconto-backfill` estava na main e ativa no banco (migration da onda 5 aplicada), mas não no
disco. Saída: exit 2, stdout vazio, e o remédio pronto para colar —
`UPDATE public.deploy_sonda_alvos SET ativo = false WHERE edge IN ('omie-desconto-backfill')`.
Desfaria uma migration aplicada e tiraria do cron uma edge provada.

**Por que escapou:** `git show` tem cara de I/O; um `import { CONST }` tem cara de código. A
varredura por "leitura do repo" procura `readFileSync`/`git show` e não enxerga o import de DADO.
Num sensor que julga contra a ref, **todo import de dado do repo é uma segunda fonte de verdade.**

**A torção nova — o remédio impresso é escrita por procuração.** O sensor não apaga nada, mas entrega
ao humano o SQL que apaga, e a causa mais frequente (worktree defasado, ~30 no repo) recebia o
remédio mais destrutivo. Vale para o remédio o padrão de [script que apaga](sonda-ausente-em-script-que-apaga.md):
o destrutivo só sai quando a evidência vem da AUTORIDADE (a ref); o disco só NOMEIA a defasagem.
O espelho estava no mesmo lugar: o aviso "falta o INSERT" também vinha do disco, e com o worktree
ADIANTADO mandava ativar edge que a main não aprovou.

**O fix:** a allowlist é lida de `origin/main` pela AST do TS — regex não serve, porque o arquivo
cita o slug num comentário, e um regex aprovaria por comentário. Forma desconhecida, texto truncado
ou array vazio → `ALLOWLIST_ILEGIVEL` (exit 2): uma lista MENOR que a real reproduz o incidente por
outro caminho. O remédio passa a ser por ramo: `ALVO_SEM_APROVACAO` (fora da ref e do disco →
UPDATE); `ALVO_SO_NO_WORKTREE` (fora da ref, dentro do disco → exit 2 sem UPDATE — sincronizar
desempata entre remoção na main e entrega não mergeada); `ALLOWLIST_DEFASADA` (só aviso, com N
commits atrás/M à frente).

**A prova:** reproduzido contra prod, read-only, com a allowlist velha no disco — antes: exit 2 +
UPDATE; depois: exit 0 (o mesmo veredito do controle com o disco em dia), zero UPDATE, aviso
nomeando a defasagem. Falsificação versionada em `scripts/mutcheck.d/pendencias-deploy-allowlist-ref.mut`
(uma mutação por camada). O irmão desta classe no `sonda:sql` — o `guardEfeitoLegado` também lê a
allowlist do disco, e ali o furo é fail-OPEN (edge aprovada escapa da recusa do POST legado) — ficou
como tarefa separada.

## Recorrência, parte 2: o irmão no `sonda:sql` — e ali o furo era fail-OPEN

A tarefa separada que a seção acima deixou nomeada. O `guardEfeitoLegado` RECUSA o bloco LEGADO do
`sonda:sql` — `POST {"probe":true}` direto na edge, que num bundle pré-sensor executa o FLUXO REAL
(medido: `monthly-report` chegou ao Resend; `calculate-scores` fez 11 escritas) — para as edges que
já têm o caminho seguro, o relé por `OPTIONS`. A lista dessas edges vinha do `import` de
`SONDA_CRON_ALVOS` na **borda da CLI**.

**A direção do furo é a pior das duas.** No `pendencias:deploy` o disco defasado produzia um remédio
destrutivo que o humano ainda podia recusar; aqui a proteção **sumia calada**: num worktree atrás da
main, `omie-desconto-backfill` (que a main já tinha posto no relé, e que ESCREVE) não estava no
disco, o guard não recusava, e o bloco saía igual ao de uma edge sem caminho seguro. Fail-OPEN no
caso mais comum do repo.

**Por que escapou aos testes:** o `guardEfeitoLegado` era testado SOZINHO, com uma lista fixa
(`const RELE = [...]`), e **nenhum teste chamava o `main` com a allowlist**. O defeito não estava na
função testada — estava na FIAÇÃO entre a borda e ela, que é justamente o que o teste unitário de
uma função pura não alcança. Lição que generaliza: *função pura verde + borda não testada = guard
decorativo*; quem escolhe a FONTE é a borda, e é dela que o teste tem de partir.

**O fix** (`lerAllowlistDoRele`, `scripts/sonda-versao-sql.ts`):

- a allowlist passa a ser lida **na ref**, dentro do `main`; a borda injeta só o PARSER. A injeção
  continua existindo pela restrição real do arquivo — o eval da skill `lovable-deploy-verify` COPIA
  `sonda-versao-sql.ts` + `sonda-fingerprint.ts` para um diretório temporário, e um import de topo
  para `supabase/functions/` (ou para `scripts/lib/`, que puxa o `typescript`) fez 7 cenários do eval
  devolverem `SQL_VAZIO`. O tipo vem por `import type`, que a transpilação apaga — verificado
  carregando o módulo copiado para um `mktemp -d` com só os dois arquivos;
- `git show` que falha, ou texto que o parser não lê, é **mecânica** (`ALLOWLIST_ILEGIVEL`, nada
  emitido). Lista vazia desligaria a recusa para TODAS as edges — é o mesmo "ausente ≠ zero" do
  #2464, pela porta oposta;
- `DependenciasCli.allowlist` é **obrigatório no tipo**, pelo motivo que o `git` já carregava:
  opcional valia "nenhuma" (`?? []`), e um guard que some em quem esquece de passá-lo é fail-OPEN.
  O compilador cobra — e cobrou, nos 12 pontos de chamada da suíte;
- **um `git fetch` por execução** (`umFetchPorExecucao`, hoje `umaMedicaoDaRefPorExecucao` — ver o
  Epílogo 3, que mostrou que o fetch único cobria metade): a ref tem dois leitores no modo sonda (a
  allowlist, que decide a recusa, e a fatia do `esperado(...)`), e dois fetches seriam duas MEDIÇÕES
  — a main pode andar entre elas, e a recusa julgaria uma ref enquanto o veredito julga outra;
- a recusa vem **antes** da comparação da fatia: ela não depende do disco (o relé não lê este
  worktree), então um worktree defasado não deve adiar a resposta certa. Consequência medida na
  suíte: um teste do guard de sincronia que usava `copilot-analyze` passou a sair RECUSADO antes de
  medir o que dizia medir — reancorado numa edge FORA da allowlist, com o porquê escrito no teste.

**Disco ≠ ref: nomear, não decidir.** A assimetria entre os dois sensores é real e vale registrar:
no `pendencias:deploy` a lista MENOR é a perigosa (gera UPDATE), aqui a lista menor é a que afrouxa
a recusa — a direção segura seria a UNIÃO. Mesmo assim quem julga é só a ref, por uma razão de
produto: edge aprovada só no worktree não tem relé no ar (a migration que a ativa no banco pode nem
ter sido aplicada), e recusar mandaria o operador para um relé que não responde. O que o disco faz é
NOMEAR a divergência (`ALLOWLIST_DEFASADA` + N commits atrás/à frente), e o aviso sobe para o topo
do SQL quando a divergência mudou o que foi emitido — o stderr some, o SQL colado num chat sobrevive.

### A varredura (passo 2 do `/matar-classe`) e o gate

Assinatura usada: *o script consulta uma ref como autoridade* **e** *obtém dado versionado do
working tree* (import de dado, `readFileSync`, `cat`/`grep` em shell) **e** *esse dado alimenta uma
decisão sem ser conferido contra a ref*. Calibrada nos dois pré-fix (casou) e no pós-fix do #2464
(não casou). 78 arquivos do escopo tocam ref; os afetados foram três, e os dois novos viraram chip:

| site | dado do disco | o que sai errado |
|---|---|---|
| `sonda-versao-sql.ts` (este PR) | `SONDA_CRON_ALVOS` | recusa do bloco legado desaparece |
| `scripts/heavy-install.sh --status` | `sha_de scripts/heavy.sh` | instalado == disco ≠ main ⇒ "EM VOO" + exit 0: o vigia cala e o heavy defasado fica — ✅ **#2861** |
| `lovable-deploy-verify/SKILL.md` §bloco bash | `grep ... index.ts` do disco | closure de deploy com 5 arquivos onde a main tem 7 (o próprio doc mediu isso) — ✅ **#2858** |

**Desfecho dos dois chips.** O `SKILL.md` fechou em **#2858**: o bloco do closure passa a ler a ref
(`git show origin/main:<path> | grep -oE "from ['\"]…"`), com a escada nomeada na 1ª linha (o canônico
é `pendencias:prompt`, que já lê a ref); o comando do import NOVO passou a casar aspas SIMPLES —
só-duplas perdia 1 de 3 imports **até lendo a ref**; e a forma contra o disco ficou UMA vez, DEPOIS
da certa, rotulada `❌ RASCUNHO LOCAL — não vale para pedir deploy`. Medido em repo-fixture:
`REF=3 DISCO=1 REGEX_SO_DUPLAS_NA_REF=2`. O `heavy-install.sh --status` fechou em **#2861** — seção abaixo —, e com
isso a varredura não tem mais site aberto.

**E a classe tem uma variante em INSTRUÇÃO, não só em código: o resíduo de ORDEM.** No `SKILL.md` a
correção **já existia** — no MESMO arquivo, ~45 linhas depois do comando errado, num 🔴 que mandava
ler a ref. Não bastou: o bloco antigo não estava marcado como errado, e quem lê de cima para baixo
(ou recorta só aquele passo) usa o primeiro comando que encontra. Num doc, *saber* não é *ensinar*:
a lição só vale onde o leitor vai PARAR. Remédio nas duas pontas — o comando certo vem PRIMEIRO, e
a forma errada, se ficar, fica **rotulada** como errada, nunca nua. Corolário para a varredura: num
doc, procurar a lição não acusa nada (ela costuma estar lá); o que acusa é **comando errado sem
rótulo**, e a distância até a correção é o tamanho do furo.

Já-correto, por conferirem contra a ref ou julgarem disco × disco: `pendencias-deploy.ts` (o disco só
nomeia), `sonda-cron-prova.ts`, `edges-afetadas.ts` (lê um `git archive`), `edges-pendentes.sh`,
`pendencias-pacote.ts`, `monitor-deploy.sh`, `pr-duplicata-guard.sh`, `wt-preflight-migration.ts`.

### O 2º site fechado: `heavy-install.sh --status` — aqui o furo era o ramo SILÊNCIO (2026-10-08)

O `--status` comparava o `heavy` instalado com `origin/main:scripts/heavy.sh` (a ref, certo) e, quando
divergia, comparava com o `scripts/heavy.sh` **do working tree** para decidir se era mudança em voo.
Igual ⇒ `"heavy EM VOO"` + **exit 0**. Só que **"instalado == disco ≠ main" tem duas causas opostas**:
disco **à frente** (alguém rodou `--daqui`; exit 0 é certo) e disco **atrás** (worktree defasado cujo
`heavy.sh` é velho e cujo `heavy` instalado veio dali) — e esse segundo é **exatamente o caso que o
instalador existe para pegar**: em 2026-07-20, 32 das 39 worktrees carregavam o `heavy.sh` pré-#1459.
Como o `vigia-worktree.sh` trata exit 0 como silêncio, o worktree atrasado **nunca ouvia nada** e o
semáforo velho ficava instalado indefinidamente. **Direção do furo:** a pior — o mesmo ramo mudo do
irmão no `sonda:sql`, mas num sensor cujo ÚNICO leitor é um hook que só fala em exit ≠ 0.

**O fix** (`direcao_do_disco`, `scripts/heavy-install.sh`) desempata pelo **git, não por heurística de
texto**: o blob do `heavy.sh` do disco está na HISTÓRIA de `origin/main` para esse path? Está ⇒
`ATRAS` ⇒ **`heavy DEFASADO`** + exit 1 (o vigia FALA, e a mensagem nomeia o commit da main que
introduziu a versão do disco); não está ⇒ `A_FRENTE` ⇒ EM VOO + exit 0, preservado para o `--daqui`
legítimo. Um `git log --no-abbrev --raw` dá os blobs old+new de todas as revisões do path em **um
fork** — medido 0,33s com 6.535 commits, dentro do teto de 3s que o hook aplica, por isso não há um
`rev-parse` por commit.

**O controle é POSITIVO, não `command -v`** (`sonda-ausente-em-script-que-apaga.md`): a enumeração tem
de **conter o blob da ponta** de `origin/main` — o objeto que o script acabou de comparar. `git` que
não responde, ref ilegível, história vazia ou enumeração que não se contém caem em **exit 3**
("não consegui verificar"), **nunca** em `A_FRENTE` — porque `A_FRENTE` é o ramo mudo, e mandar
ausência de dado para o ramo mudo é o defeito outra vez, pela porta de trás.

**A armadilha que a suíte pegou** (e que vale para qualquer sensor que leia a ref em shell):
`git log -- <pathspec>` é relativo ao **CWD**, e `git -C "$here"` põe o CWD em `scripts/` —
`-- scripts/heavy.sh` ali vira `scripts/scripts/heavy.sh` e a enumeração sai **vazia**. A sintaxe
`rev:path` do `git show` logo acima no mesmo arquivo **não** tem esse problema (é sempre relativa à
raiz), e foi ler as duas como "mesmo caminho" que quebrou. Remédio: pathspec `:(top)`. Sem o controle
positivo isso teria saído como `A_FRENTE` — silêncio — em vez do exit 3 que denunciou.

**Provado** em `scripts/test-heavy-install.sh` (casos 13-16, macOS-only como o resto da família
`heavy`): disco atrás ⇒ rc **1** (o código que o vigia transforma em aviso) + marca `DEFASADO` e
**não** `EM VOO`; disco à frente ⇒ rc 0 + `EM VOO`; `git log` emudecido ⇒ rc 3; e história
**não-vazia sem o blob da ponta** ⇒ rc 3, que é o eixo que o caso do `log` mudo não alcança.
Falsificado via `mutcheck` (baseline-check verde na MESMA invocação, abortando antes do 1º `sed`) nos
dois locales, **6/6 pegas**, `controle+` ✓: marca do `case`, `exit 1`→`0`, `DEFASADO`→`DIVERGENTE`,
`-n`→`-z` na direção, controle da ponta desligado e perda do `:(top)`. O contrato de mutação **não**
foi versionado em `scripts/mutcheck.d/`: o job `mutation-check` roda em `ubuntu-latest` e esta suíte
está em `hooks-suites-baseline.ts` como macOS-only (`stat -f %i` é BSD), então o mutcheck abortaria
lá por baseline vermelha culpando o "harness/ambiente" — mensagem que aponta para o lugar errado.
**Limite nomeado:** o guard de lista vazia (`[ -n "$pares" ]`) **sobreviveu** à mutação exploratória
— o controle da ponta pega o mesmo caso. Ele fica por clareza do fluxo, não por poder de detecção.

As mutações ficam AQUI, e não num `.mut` fora do versionamento, porque falsificação que só existe
na transcrição de uma sessão não se reproduz. Salve como `.mut`, aponte `@src`/`@test` e rode:

```
# @src: scripts/heavy-install.sh      @test: scripts/test-heavy-install.sh
# @test_cmd: bash                     @compile_cmd: bash -n
PEGA | ATRAS deixa de ser reconhecido no case | s{"ATRAS \$commit_disco"}{"ATRASX"}
PEGA | DEFASADO sai 0 (vigia volta a calar)   | s{^            exit 1$}{            exit 0}
PEGA | marca DEFASADO vira DIVERGENTE         | s{heavy DEFASADO}{heavy DIVERGENTE}
PEGA | direcao invertida (-n vira -z)         | s{if \[ -n "\$commit_disco" \]}{if [ -z "\$commit_disco" ]}
PEGA | controle positivo da ponta desligado   | s{\[ "\$achou_ponta" = 1 \]}{[ 1 = 1 ]}
PEGA | pathspec perde o :(top)                | s{':\(top\)scripts/heavy.sh'}{scripts/heavy.sh}
?    | guard de lista vazia de pares          | s{\[ -n "\$pares" \] \|\|}{[ 1 = 1 ] ||}
```

```bash
MUTCHECK_TEST_CMD=bash MUTCHECK_COMPILE_CMD='bash -n' \
  bash scripts/mutcheck.sh scripts/heavy-install.sh scripts/test-heavy-install.sh <arquivo.mut>
```

**O gate** é `scripts/gate-allowlist-sonda-da-ref.test.ts`: varre `scripts/`, `db/` e `.claude/` e
RECUSA importador novo de `_shared/sonda-cron-alvos` (o dado do disco) fora de uma lista fechada com
justificativa escrita — hoje `pendencias-deploy.ts` ("só nomeia") e `sonda-cron-prova.ts` ("disco ×
disco"). Em shell, recusa menção ao arquivo fora de um `git show`. Mede o CÓDIGO pelo stripper
compartilhado (`removerComentarios`/`removerComentariosShell`), porque a própria lição está escrita
em comentário nesses arquivos e o texto cru ficaria vermelho pela PROSA.

Falsificado nos dois locales (`LC_ALL=C` e `pt_BR.UTF-8`), com controle verde na MESMA invocação e
abortando antes do 1º `sed` se o controle não estivesse verde: import novo num script não listado →
vermelho em `IMPORTADORES_PERMITIDOS`; leitura em shell → vermelho em "working tree em shell";
permitido que deixa de importar → vermelho em "vira lista morta". E o detector tem CONTROLE
versionado dentro do próprio gate: ele casa os três formatos de import e NÃO casa o caminho usado
como dado (`ARQ_ALLOWLIST`), que é o que a lib faz.

**Limite conhecido, nomeado em vez de escondido:** o gate cobre ESTA allowlist, não todo dado
versionado. Um sensor novo que importe outra constante do repo para julgar contra a ref continua
passando; para esse eixo o que existe é a varredura do `/matar-classe` e esta página.

## Epílogo 2 (2026-10-08): a fatia certa podia ser MENOR que o arquivo

O #2435 ensinou que a fatia tem de ser **derivada da leitura** que ela vigia. Sobrou um resíduo no
lado espelhado: no modo SONDA a proveniência registrava o `_shared/sonda-fingerprints.ts`
**inteiro**, e o `esperado(...)` de uma edge consome só a **entrada dela**. O arquivo é a unidade
que o `git show` conhece; não era a unidade que o marcador consumia.

Medido na CLI real, contra a `origin/main` do dia, com a sabotagem conferida nos dois lados:

| sondando `omie-sync`, com a entrada de … sabotada | antes | depois |
|---|---|---|
| `whatsapp-send-template` (edge que ninguém pediu) | `exit 1`, 0 bytes | `exit 0`, **SQL idêntico byte-a-byte** |
| `omie-sync-estoque` (vizinha PREFIXADA) | `exit 1`, 0 bytes | `exit 0`, idêntico |
| `omie-sync` (a própria) | `exit 1` | `exit 1`, nomeando `entrada "omie-sync"` |

O veredito saía igual com ou sem a divergência — bloqueio pelo bloqueio, e de ROTINA, porque
`sonda:fingerprint -- --write` regrava esse mapa a cada mudança em `_shared/` (fingerprint
TRANSITIVO) e há ~30 worktrees. O CI nunca pagou: desde o #2425 a prova chama a função pura, e o
guard só roda no `main()`. Quem pagava era o operador.

> **Fatia de guard tem a granularidade do que o marcador CONSOME, não a do arquivo.** Quando as
> duas divergem, a comparação ganha uma **projeção declarada por quem resolve** — e o guard aplica
> a MESMA projeção nos dois lados, sem saber o que está recortando.

### Projetar abre três fail-OPENs, e o parecer Codex achou os três

1. **Gramática própria = segunda fonte da verdade.** A 1ª versão de `entradaDoMapa` ancorava o
   espaço com `[ \t]*`; `parsearMapa` usa `\s*`, que atravessa `\n`. Com a chave repetida e o valor
   na linha de baixo, o parser resolvia pela ÚLTIMA (`bbb…`) e a projeção só via a PRIMEIRA
   (`aaa…`): o guard comparava `aaa` dos dois lados e **aprovava**, com o SQL levando `bbb`. O fix
   não é alinhar as duas regex — é **delegar ao dono do formato**. Fatia que não é lida pelo mesmo
   leitor não é a fatia. (De lambuja, casar o nome exato passa a ser por INDEXAÇÃO, não por padrão:
   `omie-sync` é prefixo de OITO chaves reais do mapa.)
2. **Deduplicar OBRIGAÇÃO por chave.** Duas projeções de rótulo igual e alvo diferente: a 2ª era
   descartada e o guard aprovava a divergência que só ela veria. Rótulo é diagnóstico, não
   identidade — `toString()` de callback também não é. O que se deduplica com segurança é
   **trabalho** (o `git show`, por caminho), nunca dever.
3. **`show` pelo NOME do ramo.** Um `git fetch` de outra worktree move a `origin/main` no meio da
   conferência e cada arquivo vem de um commit diferente: aprova-se uma **combinação que nunca
   existiu num commit só**. O `sha` já era resolvido ali — só não mandava nas leituras.

E a porta da corrida (#2435) exigiu cuidado: ela continua julgada sobre os bytes **inteiros**, antes
de qualquer descarte. Guardar só o recorte na fonte a encolheria — duas leituras que diferem FORA do
recorte voltariam a passar.

### A sabotagem de um dígito que era no-op

A primeira medição deste epílogo deu `exit 0` onde devia dar 1, e a causa não era o código: o
`perl -pe 's/("omie-sync": ")[0-9a-f]/${1}0/` troca o 1º dígito do hash por `0`, e o hash de
`omie-sync` **começa com `0`**. Sabotagem inerte, medição verde sobre nada — a mesma classe de
`--falsificar` que não rodou a suíte. Sabotar por amostra de UM caractere depende do valor que lá
está: troque a fatia INTEIRA e **compare o arquivo antes/depois**, abortando se não mudou.

Resíduo conhecido, registrado no próprio teste: o `show` da allowlist do relé (#2856) ainda saía pelo
NOME do ramo — fechado no Epílogo 3.

## Epílogo 3 (2026-10-08, #2871): o guard AO LADO lia pelo NOME — e o fetch único cobria METADE do eixo

O resíduo que o Epílogo 2 deixou escrito no próprio teste (`expect(foraDaFatia.map(alvo))
.toEqual([kit.ARQ_ALLOWLIST])`). Ele valia o conserto por si: a allowlist do relé não é diagnóstico,
é o guard que decide se o bloco LEGADO (POST direto na edge, que num bundle velho roda o FLUXO
REAL) sai liberado — e, lida de um commit enquanto a fatia vem de outro, o dano tem as DUAS
direções: redeploy à toa de edge money-path, ou POST direto numa edge que já tinha o caminho seguro.

**O que a medição acrescentou ao pedido.** Passar o `sha` para `lerAllowlistDoRele` — o retorno de
`buscarRefDeployada` era DESCARTADO no `main`, uma linha antes — fechou o limite registrado, e o
teste do Epílogo 2 ficou verde. Mas o teste NOVO, que faz o `rev-parse` ANDAR entre os leitores,
seguiu vermelho mostrando `['1111111111aaaa', '2222222222bbbb']`: `conferirSincronia` resolve o SEU
próprio `rev-parse`, então a allowlist saía do 1º commit e a fatia do 2º. O pedido estava certo e
era insuficiente — **a combinação inexistente mudou de endereço em vez de desaparecer**.

A causa é o que `umFetchPorExecucao` prometia e não entregava: o memo do `fetch` impede que ESTE
processo mova a ref, **nunca que outro mova**. `refs/remotes/origin/main` é COMPARTILHADO por todas
as worktrees do repo — com ~30 em paralelo, o `git fetch` de uma sessão vizinha reescreve a ref no
meio desta execução. O fix é o memo cobrindo também o `rev-parse` (`umaMedicaoDaRefPorExecucao`):
**uma medição da ref por execução**, estrutural no transporte, e não disciplina de cada chamador —
quem adicionar um terceiro leitor da ref já nasce no mesmo commit, sem precisar saber disso.

**A lição que generaliza:** *invariante declarada em comentário não é invariante medida*. O comentário
de `buscarRefDeployada` afirmava, desde 2026-09-10, que "os dois leem a mesma ref depois do mesmo
fetch" — e o `fetch` único era prova de **uma** das duas metades. Quando o eixo é "a fonte pode se
mover no meio", o teste tem de **MOVER a fonte**: o falso que devolve sempre o mesmo sha deixa as
duas resoluções indistinguíveis, e qualquer número de leitores passa.

**Cobertura:** o `foraDaFatia` virou `foraDaConta` com `toEqual([])` — todo `show` da execução, a
allowlist inclusa, sai do commit resolvido, e leitor NOVO da ref chega como vermelho em vez de
entrar em silêncio. 2 mutações no `.mut` do par (a allowlist de volta ao NOME; o `rev-parse` fora do
memo), as duas observadas VERMELHAS antes do fix — porque foram, literalmente, os dois estados
intermediários desta entrega. E 3 mutações do `-allowlist-ref.mut` tiveram de ser REANCORADAS: elas
apontavam para linhas que este diff mudou, e `--seco` é o gate que pega isso em ~1s.

### A reancoragem que AFROUXOU o predicado (regressão medida, #2878)

O `--seco` aprovou as 3 mutações reancoradas — e **uma delas deixou de ser PEGA**. Quem mediu foi o
`mutation-check` do CI: `ref lida do HEAD (a copia commitada do disco) ⚠ SOBREVIVE ← DIVERGE`,
`controle+ ✗ (16/17)`, e a main ficou vermelha até o #2878.

A causa foi o helper `indiceDoShowDaAllowlist`. Ele casava o alvo por IGUALDADE
(`origin/main:<arq>`); como o alvo passou a ser `<sha>:<arq>`, trocaram-no por
`endsWith(':<arq>')` — que casa `HEAD:<arq>` também. Com o `git` fabricado respondendo a QUALQUER
prefixo, a mutação lia a allowlist do HEAD e **nada** ficava vermelho.

Três lições, nenhuma sobre a sonda:

1. **`--seco` e `mutation-check` medem coisas DIFERENTES, e o barato não cobre o caro.** "Cirúrgico"
   (casa, e casa UMA linha) não é "PEGO". Reancorar padrão depois de refactor é exatamente a hora
   em que o par precisa da rodada CHEIA — e o `--seco` verde deu a sensação de validação completa,
   com o `sumário: ... 0 problema(s)` ao lado da frase "cobertura NÃO medida".
2. **Trocar igualdade por `endsWith`/`includes` é AFROUXAR o predicado, não reancorar.** O que mudou
   era justamente o PREFIXO; o conserto honesto é ancorar no prefixo NOVO (o sha que o falso
   resolve), nunca deixar de olhar para ele. Irmã da regra do `word-split-guard` (#2864): o
   predicado tem de casar a COISA que mudou.
3. **O fail-OPEN morava no FALSO — e é lá que o #2878 consertou.** Um `git` fabricado que responde a
   qualquer `<ref>:` responde também às refs ERRADAS, e com ele TODA mutação de proveniência
   sobrevive: falso permissivo é **teto de cobertura**, que nenhum teste do arquivo consegue furar.
   O espelho passou a responder só a `${SHA_DA_MAIN}:`, e ler de outra ref cai no "não existe".

E o desfecho que fecha o laço: o auto-merge mergeou **45 s ANTES** de o `mutation-check` terminar
(02:45:29 × 02:46:14). O gate que pegaria isso existia e rodou — só não é requerido para o merge.
Quem mexe em `.mut` não pode ler "o PR mergeou" como "os contratos de mutação passaram": são
eventos independentes, e o segundo chega depois.
