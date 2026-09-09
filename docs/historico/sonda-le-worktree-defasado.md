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
