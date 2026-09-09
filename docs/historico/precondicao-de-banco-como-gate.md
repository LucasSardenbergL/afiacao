# A ordem entre camadas virou gate — e o fixture que inventou o dialeto quase a deixou cega

> **Medido 2026-09-07.** Fecho do buraco que o [#2285](ordem-entre-camadas-do-mesmo-pr.md) nomeou:
> *"a dependência tem de existir como ARTEFATO VERIFICÁVEL, não como parágrafo."*
> Duas lições: uma sobre a **premissa que a medição derrubou**, outra sobre um **teste verde sobre
> um formato que não existe** — esta última transferível para qualquer parser do repo.

## 1. A premissa que a medição derrubou (e por que medir o ANTES não é burocracia)

A frente nasceu de um achado real — **74 migrations custom em 30 dias, ~2,5/dia** — e de uma
proposta plausível: empacotar a leva para reduzir *N colagens do founder para uma*. A linha de base,
medida ANTES de escrever código, disse outra coisa:

| Medida | Valor | O que decide |
|---|---|---|
| Migrations custom em 30 d | 74 (16 dias ativos ⇒ **4,6/dia ativo**) | confirma o volume |
| Migrations **por PR** | **1,16** — 57 de 64 PRs (89%) trazem **exatamente 1** | não há lote a juntar |
| Objetos das 74 migrations presentes em prod | **115/115**, zero faltantes, **inclusive os do próprio dia** | **não existe fila acumulada** |
| PRs com migration que são multi-artefato | **30/64 (47%)** — +edge+front 13 · +edge 6 · +front 11 | **é aqui que dói** |

A fila pendente é ~1. Um "pacote por leva" agruparia **um** item em 89% das levas: o ganho de
colagens que motivou a frente **não existe**. O que existe, e tem incidente medido atrás, é a
**ordem entre artefatos de tipos diferentes** — a edge do #2285 serviu ≥2h25 chamando uma RPC que
não existia.

> **REGRA. A contagem de um artefato não é a contagem do TRABALHO com ele.** 74 migrations/mês
> parecem uma fila; medidas por PR e contra prod, eram 64 entregas de uma migration cada, aplicadas
> no dia. Antes de otimizar um agregado, meça a UNIDADE que o operador realmente manipula — senão
> se constrói o lote que ninguém tinha.

O corolário prático: o `pendencias:pacote` **não concatena migrations**. Além de não haver o que
concatenar, juntar histórico reaplicaria DDL sobre hardening posterior — um `REVOKE`/ACL aplicado
depois some num replay ingênuo, e "idempotente" não quer dizer "seguro para reaplicar".

## 2. O gate: `bun run pendencias:pacote`

O que já existia e **não** foi reimplementado: `pendencias:deploy` (o ledger decide QUEM precisa de
deploy), `pendencias:prompt` (a colagem por leva) e `preflight:rpcs` (QUAIS RPCs uma edge chama,
seguindo imports, com exit 3 quando a lista está furada).

O que faltava era o elo, e ele é pequeno: `preflight:rpcs` **emite** a query de cruzamento com prod
e confia que alguém a rode. No #2285 ninguém rodou — é a mesma prosa executável do cabeçalho da
migration, só que em SQL. O `pendencias:pacote` **roda** (leitura é do agente, via `psql-ro`),
**julga** fail-closed e **recusa emitir a colagem da edge** enquanto prod não tiver as RPCs.

O gate é a **ausência do passo**, não um aviso ao lado dele: quando a pré-condição não está
satisfeita, o passo 2 do pacote não é marcado como pendente — ele **não é escrito**. Um pacote que
traz a colagem junto de uma advertência entrega a tentação com o aviso, e o #2285 já mostrou quem
ganha essa disputa.

Exit: `0` liberada · `1` nada pendente · `2` mecânica · **`3` bloqueado**.

**Quatro eixos fail-closed, nenhum cobrindo o outro:** marcador de fim (saída truncada não é "nada
ausente") · controle positivo do catálogo (zero é ausência de dado) · indireção declarada pelo
extrator (lista furada não libera) · **dialeto** (§3).

Detalhe que muda a AÇÃO, não só o diagnóstico: cada RPC ausente vem com a contagem da **família**
(irmãs de mesmo prefixo). Família povoada ⇒ o domínio existe e falta ESTA migration (aplique-a).
Família **vazia** ⇒ o domínio inteiro não está em prod, ou o nome mudou ⇒ **diagnostique, não
reaplique**. Sem essa distinção, um "ausente" manda reaplicar migration sobre um diagnóstico que
ninguém fez.

## 3. A lição transferível: o fixture que inventou o dialeto

A primeira versão passou **22 testes verdes** e, rodada contra prod, deu as **5 RPCs de
`disparar-pedidos-aprovados` como AUSENTES — estando todas presentes**.

A causa: o parser lia `v1 === 't'`. Mas `t`/`f` é a representação de **exibição** do psql; o
`existe::text` do SQL devolve **`true`/`false`**. O parser e o emissor falavam dialetos diferentes.

O defeito não foi a string. Foi **o teste ter fabricado o formato em vez de medi-lo**:

```ts
// o fixture que validava a si mesmo — nunca esteve na saída de nenhum psql
parsearSondaPrecondicao('rpc|a_um|t|24')
```

> **REGRA. Fixture de parser copia-se de uma saída REAL, nunca se escreve de memória.** Um fixture
> inventado testa que o parser concorda com quem o escreveu — que é a mesma pessoa. Ele fica verde
> exatamente quando o emissor e o parser divergem, porque a divergência está **fora** do teste.
> É a família do *gate textual cego* ([gates-textuais-cegos.md](gates-textuais-cegos.md)) e do
> *sensor que consulta a máquina que vigia*: a asserção e o alvo compartilham o defeito.

Duas coisas salvaram, e vale distinguir qual é desenho e qual é sorte:

- **Desenho:** o fail-closed. O dialeto errado virou *bloqueio* (ausente), não *liberação*. Se a
  comparação fosse `v1 !== 'f'`, o mesmo bug teria dado **tudo presente** e liberado o deploy que o
  gate existe para segurar — o falso verde perfeito, silencioso, na ferramenta de segurança.
- **Não foi teste:** foi a execução contra prod. Nenhum dos 22 testes podia pegar isto.

O conserto, por isso, não foi trocar a string. A sonda passa a **auto-testar o próprio dialeto**:
emite duas linhas cuja resposta é conhecida **antes de perguntar** (`autoteste|presente|SIM` e
`autoteste|ausente|NAO`) e, se o parser não as reproduzir, a leitura inteira é `INCERTA` — inclusive
as linhas que dizem "presente". O eixo 4 nasceu de um defeito real desta lib, e é o único dos quatro
que teria pego a v1.

### A classe reincidiu no MESMO PR, e isso é o dado mais útil aqui

Depois de escrever a regra acima, errei-a de novo — duas vezes, em contratos diferentes:

| # | Onde | Supus | Era |
|---|---|---|---|
| 1 | saída do `psql` | `t` / `f` | `true` / `false` |
| 2 | `Procedencia.sha` do #2362 | sha256 (64 hex) | SHA de **commit**, 7..40 hex |

O segundo caso é mais instrutivo que o primeiro: o contrato estava **escrito, no repo, a uma linha
de `grep`** — e ainda assim eu preenchi o fixture de memória, porque "sha é sha". Nos dois casos o
custo real foi o mesmo e não foi o bug: foi ter que **descobrir por execução** o que estava
disponível por leitura.

> **REGRA (a forma acionável).** Ao preencher um fixture com o formato de OUTRO sistema — saída de
> processo, contrato de lib alheia, payload de API — a fonte é a **medição ou a definição**, nunca a
> memória. Custa um `grep` na validação ou uma execução capturada; a alternativa custa um ciclo
> inteiro de teste-verde-contra-prod-vermelho. E o sinal de alerta é a própria fluência: quanto mais
> "óbvio" o formato parece, menos provável que você o tenha conferido.

Vale notar o que **não** falhou: nas duas vezes a validação do outro lado (o parser fail-closed; a
checagem de procedência do #2362) recusou a entrada errada em vez de aceitá-la. Contrato que valida
a própria entrada é o que transforma esta classe de erro em um vermelho barato.

## 4. Como isto foi provado (e falsificado)

- **Núcleo puro:** 36 testes. Falsificação com **controle verde na mesma invocação, abortando antes
  do primeiro `sed`**: 6 sabotagens (um eixo por vez), **6/6 vermelhas**, verde de volta ao
  restaurar. Uma sabotagem inócua foi detectada como tal pelo próprio laço (`cmp -s`) em vez de
  contar como aprovação — que é o modo pelo qual uma falsificação vira teatro.
- **Dialeto, ponta a ponta contra prod:** a sonda gerada, rodada no `psql-ro`, com **controle nos
  dois sentidos na mesma medição** — `reposicao_claim_disparo` → presente (família 24) e um nome
  inventado (`funcao_que_nao_existe_xyz`) → ausente (família 0); catálogo com 479 funções.
- **Gate contra prod:** com a edge sabotada para chamar uma RPC inexistente → **rc=3**, a RPC
  culpada nomeada, a ação por família correta e **a colagem ausente do arquivo**; restaurada →
  **rc=0** de volta, zero diff residual.

## 5. O que este gate NÃO cobre (declarado, não deduzido)

- **Só RPC literal.** Chamada por indireção não é lida — o extrator declara, e o eixo 3 converte a
  declaração em `INCERTA`. Cobertura medida: **31 das 96 edges (32%) chamam `.rpc(`**.
- **Só função.** Coluna, tabela, policy e enum que a edge assuma **não** são medidos. A edge do
  #2285 dependia de 2 colunas *e* de 2 funções; este gate teria pego pelas funções, mas não é o
  mesmo que cobrir colunas. Gatilho de reentrada: o primeiro incidente cuja pré-condição seja
  **coluna** e não função.
- **Não cobre secrets nem o frontend.** A ordem canônica é secrets → DDL → edges → frontend; o
  pacote mede o elo **DDL→edge** e ordena o resto sem medi-lo. Dizer que ordena não é dizer que mede.
- **Não decide deploy.** Quem decide é o ledger; este script só responde "PODE AGORA?".
- **Só existência, não ASSINATURA.** A sonda casa `pg_proc.proname`: ela responde *"foi criada?"* e
  é cega para *"foi alterada?"*. Uma RPC antiga de mesmo nome com contrato incompatível conta como
  presente e o gate libera — o erro sai em runtime, com a cara do #2285, só que depois do deploy.
  Declarado e **não** corrigido por precisão > recall: conferir assinatura exige extrair a
  ESPERADA do call-site (`db.rpc(nome, { a, b })`), um segundo extrator cujo modo de falha é o
  **bloqueio falso** — e um gate de deploy que bloqueia sem razão ensina o operador a contorná-lo.
  Gatilho de reentrada: o primeiro incidente em que a RPC **existia** e a edge quebrou por
  contrato (assinatura, tipo de retorno, overload ambíguo).

## 6. O buraco que o gate tinha na PRÓPRIA procedência (2026-09-08, achado pelo Codex)

O gate nasceu com as duas metades lendo **fontes diferentes**, e o furo é o defeito que ele existe
para impedir, reencenado pela ferramenta:

| Metade | Lia de | Por quê |
|---|---|---|
| a **fatia** da colagem (`fatiaDeDeploy`) | `origin/main`, via `git show` | deliberado, medido no #2123: **o Lovable deploya a MAIN**, não este checkout |
| a **descoberta das RPCs** (`coletarDaEdge`) | o **working tree**, via `existsSync`/`readFileSync` | herdado do `preflight:rpcs`, onde ler o disco é a resposta certa |

Numa worktree atrasada — o normal aqui, com ~30 em paralelo — a edge da main chama uma RPC que este
checkout desconhece. O gate então lia o `index.ts` **velho**, media em prod só as RPCs **velhas**
(que existem), respondia `✅ pré-condição de banco satisfeita` e **emitia a colagem**. Nenhum eixo
fail-closed disparava: os quatro vigiam a MEDIÇÃO, e aqui o defeito estava na **pergunta**.

Na sessão que achou isto o worktree estava **4 commits atrás** da `origin/main` e o pacote foi
emitido assim mesmo — não houve dano só porque nenhuma das 4 mudanças tocava as RPCs da leva.
Sorte, como no #2285; não desenho.

> **REGRA. Num gate, a fonte que RESPONDE e a fonte que a pergunta MEDE têm de ser a mesma — e a
> procedência é ARGUMENTO, nunca default.** `coletarDaEdge(edge, arvore, raiz)` passou a exigir a
> árvore: sem default de disco, todo chamador declara de onde sua resposta vale e o **typecheck**
> cobra quem não declarar. A classe é mais larga que este gate: quando um verificador aceita
> `raiz = process.cwd()` para ler o que outra metade lê de uma ref, o desacordo é silencioso e só
> aparece na worktree atrasada de outra pessoa.

**Falsificação** (controle verde na mesma invocação, uma camada por vez): montado o caso em que o
disco tem o `index.ts` **sem** a RPC e `origin/main` tem **com**, e a RPC não está em prod. Contra o
código anterior: **`0` — liberado**, que é o bug. Com a correção: **`3` — bloqueado**, a RPC nova
nomeada no pacote e a colagem ausente. Os controles (disco e ref concordam ⇒ `0`; a RPC nova **já**
em prod ⇒ `0`; edge fora da ref ⇒ `2`) ficaram verdes nas duas rodadas — sem eles, um gate que
bloqueasse SEMPRE passaria pelo teste principal.
