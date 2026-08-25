# O marcador que não acompanha a edge — e por que a lição escrita não segurou

**Classe:** a sonda de versão perde poder discriminatório exatamente no deploy que ela existiria
para provar. Não é bug de código: é **omissão de bump**, e ela produz **falso positivo** de "está
no ar" — que, segundo `.claude/skills/lovable-deploy-verify/SKILL.md`, é estritamente pior que
falso negativo, porque ENCERRA a verificação em vez de fazer continuar.

## O que aconteceu (2026-08-25)

O #1971 alterou `supabase/functions/omie-analytics-sync/index.ts` (removeu a fonte
`customer_canonical_alias` do `fetchCodigoUserMap`) e **não** bumpou o `VERSAO` de `versao.ts`,
parado em `v1.0-sensor-inicial` desde o #1905. Sondar prod com `{"probe":true}` respondia a mesma
string no bundle #1905 e no #1971: provava "≥ #1905" e nada mais.

O detalhe que dá o recado: o **#1970 mergeou 7 minutos antes** (01:24 vs 01:31 UTC) corrigindo a
MESMA classe noutra edge, e escrevendo a lição em três lugares — `docs/agent/deploy.md`
§Canárias, o comentário do `versao.ts`, e o próprio gate que ele instalou. **A regra estava
escrita e mesmo assim não segurou.** O gate do #1970 (`sonda-versao-contrato_test.ts`) não falhou:
ele nunca cobriu isso, e diz isso no próprio comentário — *"ele não força o bump na PRÓXIMA fatia
— nenhum gate de texto sabe se uma mudança de comportamento mereceu marcador novo. A trava real
dessa metade é humana"*. Ele pinça a **REGRESSÃO** (voltar a um valor aposentado), não a omissão.

Lição de método: **regra documentada não é gatilho.** Quando a mesma classe reincide 7 minutos
depois de ser escrita, o que falta não é conhecimento — é um mecanismo que PARE quem omitiu.

## O que o bump tardio recupera — e o que não recupera

Bumpar depois **não devolve a discriminação perdida**. Quem sondar e receber o valor velho segue
sem saber se o bundle é o do #1905 ou o do #1971. O que o bump reata é só o sentido **positivo**:
o valor NOVO na resposta prova que o bundle inclui a entrega e, por ancestralidade, o #1971. O
falso NEGATIVO (marcador velho num bundle que já tem o #1971) sobrevive até o próximo deploy — e
é o lado certo da assimetria, porque faz continuar verificando.

Corolário prático: o bump é barato quando **pega carona num deploy que já era obrigatório**
(o #1971 precisa de deploy de qualquer jeito). Bumpar uma edge cujo fix já está em prod há dias
cria **deploy no-op** só para alinhar o marcador — custo real, já que deploy de edge é MANUAL.

## Auditoria das 32 edges instrumentadas (2026-08-25)

Critério: último commit que tocou `<edge>/index.ts` mais NOVO que o último que alterou a linha
`VERSAO = "…"`. Resultado — 4 sinalizadas, das quais **3 genuínas**:

| edge | commit da mudança | veredito |
|---|---|---|
| `omie-analytics-sync` | #1971 (883080edb) | **genuíno** — corrigido aqui |
| `enviar-pedido-portal-sayerlack` | 8ee8afa15 (203 linhas) | **genuíno** — bumpado depois, `v1.1-pos-login-no-envio` |
| `sayerlack-captura-precos` | 8ee8afa15 (85 linhas) | **genuíno** — bumpado depois, `v1.1-pos-login-na-captura` |
| `disparar-pedidos-aprovados` | dc67b4261 | falso positivo — só encanamento da sonda |

⚠️ As 5 edges que a suspeita inicial apontava (`fin-cashflow-engine`, `omie-cliente`,
`omie-nfe-webhook`, `omie-sync-estoque`, `omie-sync-nfes-recebidas`) estão **todas limpas**. A
busca por intuição errou o alvo nos dois sentidos — achou onde não havia e não achou onde havia.
Vale a medição, não o palpite.

⚠️ **Escopo desta auditoria: só marcadores de SONDA.** Existem edges cuja prova de deploy é
**canária versionada**, não sonda — o `contrato` delas (`VERIFICAVEL_POR_CANARIA` no teste de
contrato, e a tabela de `docs/agent/deploy.md`) é um marcador com exatamente a mesma classe de
falha, e **não foi auditado aqui**. Que a classe é real ali também está provado: o #1974 (97194df1b)
bumpou o `contrato` da `omie-vendas-sync` de `identidade-fail-closed-v1` para
`identidade-a2-client-to-user-v2` justamente porque o marcador velho não nomeava mais a fatia que
a canária verifica. Auditar os `contrato` pelo mesmo critério é o próximo passo natural.
**→ FEITO em 2026-08-25; o resultado está na última seção deste documento.**

## O bump do #1974 no ar — a tese deste doc exercitada ponta a ponta (2026-08-25, 02:5x UTC)

O parágrafo acima usa o #1974 como prova de que a classe existe nas canárias. Ele fechou, e o
fecho vale registrar porque é a tese deste documento funcionando: **o bump foi o que tornou o
deploy verificável.**

O #1974 mergeou às **02:15:13 UTC**. Deploy de edge no Lovable é manual, então nesse instante a
`main` andou e a produção não — e a única coisa capaz de expor a diferença era o marcador. Deploy
pedido pelo chat do Lovable (com `assinatura-a2.ts`, arquivo NOVO: só o `index.ts` derrubaria o
boot por import inexistente) e sondado logo depois pela rota `identidade_probe`:

| campo | lido no `request_id` 59734 |
|---|---|
| `status_code` | 200 |
| `canary` | `true` |
| `contrato` | **`identidade-a2-client-to-user-v2`** |
| `ok` | `true` |
| `casos_vermelhos` | vazio (9 fixtures, todas verdes) |

Os **cinco** campos que a §Canárias do `deploy.md` exige, não só o `ok`.

**A identidade se resolve pelo `contrato`, sem o campo `edge`.** A canária da `omie-vendas-sync` não
emite `edge` — o discriminante do #1789, que separou as 10 sondas da oitava leva, não existe aqui.
Ele não fez falta porque a string `identidade-a2-client-to-user-v2` aparece em UM arquivo só
(`omie-vendas-sync/index.ts`) e **nasceu no próprio #1974**: `git grep` no commit pai devolve zero.
Nenhuma outra edge e nenhum bundle anterior conseguem produzi-la, então ler essa string já é o
veredito. É o mesmo critério do `edge` por outro caminho — **unicidade provada**, não presumida.

E é exatamente o que o marcador congelado destrói: mantido em `identidade-fail-closed-v1`, o probe
responderia a MESMA string antes e depois do deploy, e a verificação teria dado verde sem provar
nada — o modo de falha que este documento nomeia. O bump não foi consequência da fatia; foi o
pré-requisito de conseguir enxergá-la no ar.

## Se for instalar gate: o desenho que sobreviveu à 2ª opinião (Codex, xhigh)

Medido neste repo (30 dias, 414 commits): **68** tocam alguma edge instrumentada (~16%) e **55**
tocam `supabase/functions/_shared/` (~13%).

Duas formas óbvias, e as duas têm furo:

- **Gate por diff** (`index.ts` mexido sem `versao.ts`). Precisa de `fetch-depth: 0` — o CI usa
  `actions/checkout@v5` sem ele (clone raso). Não é cego no `push` como parecia: o payload traz
  `before`/`after`, então o caminho do Lovable É diffável. Continua cego no **cron** (evento sem
  base) e, por ser gate de transição, **não descobre omissão antiga** — some se um push posterior
  não relacionado passar. E precisa exigir que o **valor de `VERSAO` mudou**: "tocou o arquivo"
  é satisfeito por edição de comentário.
- **Gate por estado** (pin de hash conferido no teste de contrato). Vale em todo evento e não é
  lavado por push posterior. Mas tem furo **indecidível**: regravar só o hash mantendo o `VERSAO`
  produz um estado byte-a-byte idêntico ao legítimo — nenhum predicado sem histórico separa os
  dois. E o pin central de 32 linhas vira hotspot de merge com ~30 worktrees em paralelo.

**A forma que resolve os dois é mudar a PROPRIEDADE, não o verificador:** tornar a identidade
SERVIDA função do conteúdo. A sonda passa a responder `versao` **e** `fonte_sha256`; o CI
recalcula o fingerprint. Aí quem regravar só o hash não cria buraco — a resposta da sonda mudou,
logo a discriminação foi preservada. O `VERSAO` humano vira o slug que NOMEIA a fatia; o
fingerprint vira o discriminador que não depende de disciplina.

Desenho, se for feito:

1. `fingerprint.ts` por edge, contendo **só** `FONTE_SHA256` — e o hash exclui apenas esse
   arquivo, **nunca o `versao.ts` inteiro** (ele carrega `EFEITO` e a fábrica de resposta, que são
   comportamento).
2. Hash sobre o **grafo local transitivo** a partir do `index.ts` — incluindo `_shared/`, helpers
   e config. Isso resolve o que parecia inviável: o fan-out de `_shared/` (um toque em
   `_shared/auth.ts` mexe em ~30 edges) só é insuportável se um humano bumpar 30 arquivos à mão.
   Com o CI **regenerando**, o fan-out é de graça — e é CORRETO: os 30 bundles mudaram mesmo.
3. Hash determinístico: caminho relativo + tamanho + bytes, ordenação estável.
4. Testes de **calibração** (falsificação): mexer em `index.ts`, em helper local, em dependência
   `_shared/`, renomear e deletar **têm** de mudar o hash; mexer em teste, não.

⚠️ **Chame de fingerprint da FONTE, não de hash do bundle.** Não há `deno.lock` versionado e há
range aberto (`npm:@supabase/supabase-js@2`), então a mesma fonte pode resolver dependência externa
diferente. O fingerprint identifica o que ESTÁ NO REPO, não o artefato servido.

⚠️ **Nenhuma das formas prova atomicidade do deploy manual.** Se o deploy misturar `versao.ts` novo
com `index.ts` velho, a sonda mente verde — e um `FONTE_SHA256` gravado como constante mente junto,
porque ele também é fonte. Só hash calculado em RUNTIME fecharia isso, e a edge não lê a própria
fonte em Deno Deploy. Fica como limite conhecido, não como promessa.

⚠️ **Custo a aceitar de olhos abertos:** com o fingerprint no grafo transitivo, um toque em
`_shared/` marca ~30 edges como desatualizadas até cada uma ser redeployada à mão. É verdade, não
ruído — mas é volume de alarme, e deploy de edge aqui é MANUAL.

## A forma 1 foi INSTALADA, com os dois furos do Codex fechados (2026-08-25)

`scripts/sonda-versao-bump-gate.ts` (`bun run sonda:bump`, no job `validate`, só em
`pull_request`) é o **gate por diff** da seção acima, com as duas objeções concretas do Codex já
resolvidas: o checkout do `validate` passou a carregar `fetch-depth: 0`, e o gate compara o
**valor literal** de `VERSAO` extraído dos dois lados — não "o arquivo foi tocado", que edição de
comentário satisfaz. É o par que faltava do gate do #1970: aquele barra a REGRESSÃO (voltar a um
valor aposentado), este barra a **OMISSÃO**, e nenhum predicado sobre o estado ATUAL do repo
alcança a segunda, porque "mudou" só existe contra uma base.

**Corpo servido** — a régua — exclui `*_test.ts` (o bundle é byte-idêntico com o teste mudado), o
próprio `versao.ts` (é o marcador, e é quase todo prosa: o commit que deu `respostaSonda` às 16
edges teria exigido 16 bumps de uma vez) e o que não sobrevive ao `removerComentarios`
compartilhado — comentário e reindentação não pedem marcador.

**Medição, com o próprio gate decidindo** (414 fatias da `main` até 2026-08-25): **26** tocam uma
das 32 edges instrumentadas e **6** reprovariam.

| fatia | edge | veredito |
|---|---|---|
| e70bfa050 (#1938) | `analyze-unified-order` | o controle positivo |
| 883080edb (#1971) · 81f9a111c · d8cf07152 | `omie-analytics-sync` | genuínos |
| 8ee8afa15 | `enviar-pedido-portal-sayerlack` + `sayerlack-captura-precos` | genuínos |
| dc67b4261 | `disparar-pedidos-aprovados` | **fronteira** — ver abaixo |

⚠️ **Reconciliação com o "68" da seção anterior:** lá o denominador são os **94** diretórios de
edge do repo; aqui são as **32** instrumentadas, que é o universo onde este gate pode agir. Na
mesma janela, 72 fatias tocam alguma das 94 e 54 tocam `_shared/` (a seção reporta 55). Perguntas
diferentes, não medições em conflito.

⚠️ **A auditoria acima marca `dc67b4261` como falso positivo ("só encanamento da sonda") e o gate
o reprova.** A divergência é de JULGAMENTO, não defeito: aquela fatia trocou `respostaSonda()` por
`respostaSonda(VERSAO)` e a mensagem do 400 ambíguo por `erroSondaAmbigua(…)` — duas mudanças
**observáveis em produção**, ainda que dentro do encanamento da própria sonda. Nenhum gate separa
"mudou o fluxo real" de "mudou o encanamento" sem análise semântica, e a assimetria manda para que
lado errar: um marcador a mais custa uma linha, um deploy inverificável de money-path custa o que
este documento inteiro descreve.

**`_shared/` fica de fora, e isso confirma o argumento da seção anterior em número:** das mesmas
fatias, 31 tocam `_shared/*.ts` não-teste e cobri-las produziria **290 pares (edge, fatia)** em 25
delas — ~12 marcadores por PR. É exatamente o "só é insuportável se um humano bumpar 30 arquivos à
mão": com bump humano, inviável; com o CI **regenerando** um fingerprint, de graça. Ou seja, a
medição não enfraquece o desenho do `FONTE_SHA256` — ela o sustenta.

**Este gate não dispensa o fingerprint, e não é o mesmo remédio.** Ele cobre a disciplina do slug
humano na janela do PR; o fingerprint cobriria a discriminação em produção sem depender de
disciplina nenhuma, além do fan-out de `_shared/`. Se o `FONTE_SHA256` for feito, este gate
continua útil (o slug segue sendo o que NOMEIA a fatia para quem lê a resposta) mas deixa de ser a
única rede.

**Limites conhecidos, herdados da forma 1 e declarados aqui em vez de descobertos depois:** só
`pull_request` — o `push` do Lovable **é** diffável pelo `before`/`after` do payload e ficou de
fora por escolha, porque na `main` o merge já aconteceu e reprovar ali produz vermelho sem ação
possível a não ser um deploy no-op só para alinhar marcador (o custo que a seção "o que o bump
tardio recupera" já nomeia); o `schedule` é estruturalmente cego (evento sem base); e omissão
ANTIGA não é descoberta — o gate é de transição. É **fail-CLOSED**: sem base determinável ou sem
`VERSAO` legível, reprova.

## A METADE de `_shared/` fechada por fingerprint SERVIDO (2026-08-25)

O gate acima diz, no próprio cabeçalho, o que não alcança: `_shared/` fica **fora** dele de
propósito, e a razão é medida — cobri-lo daria 290 pares edge×fatia em 25 fatias, **~12 bumps À
MÃO por PR**. A conclusão está certa; o buraco continua aberto. Mudança de comportamento pode
chegar inteira por `_shared/` sem tocar `index.ts` nem `versao.ts`: foi o que o `8ee8afa15` fez,
trazendo metade da reescrita do pós-login Sayerlack via `_shared/sayerlack-pos-login.ts`.

`scripts/sonda-fingerprint.ts` (`bun run sonda:fingerprint`) fecha isso pela via que o Codex
apontou — **mudar a propriedade, não o verificador**. Para cada edge instrumentada, SHA-256 sobre
o **fecho transitivo dos imports locais** a partir do `index.ts`, `_shared/` incluso; o mapa vai
em `_shared/sonda-fingerprints.ts` e é **servido** por `criarRespostaSonda` no campo `fonte`.

Três propriedades que o gate por diff não tem:

1. **O fan-out deixa de custar disciplina.** Os ~12 bumps por PR eram inviáveis porque um HUMANO
   os escrevia. O CI **regenera** — e o fan-out é CORRETO: os 12 bundles mudaram mesmo. Medido ao
   vivo: um `echo` em `_shared/auth.ts` fez o gate sinalizar **27 edges**.
2. **Roda em TODO evento.** É gate de ESTADO, não de diff: não precisa de base ref, então cobre o
   `push` do Lovable e o cron da `main` — e descobre desvio ANTIGO, não só o da fatia.
3. **Servir é o que fecha o furo indecidível.** Um fingerprint só no repo é escrituração: com
   `VERSAO=X` em prod e o repo dizendo X↔F1 enquanto o HEAD está em F2, não dá para saber se prod
   tem F1 ou F2 — os dois estados respondem idêntico. Quem discrimina é a RESPOSTA mudar. É também
   por isso que regravar só o hash deixa de ser exploit: a resposta muda junto, logo a
   discriminação foi preservada.

**Calibração** (`scripts/sonda-fingerprint.test.ts`, 14 casos): mexer em `index.ts`, em helper
local, **em dependência `_shared/`**, renomear (bytes idênticos) e deletar (fail-closed, lança)
TÊM de mover o hash; mexer em `*_test.ts` **não** pode. O mapa gerado fica fora do próprio fecho —
senão gravá-lo mudaria o hash (ponto-fixo), provado por caso dedicado e por `--write` idempotente.

⚠️ **Par de controle no teste da resposta.** O teste que pina a forma usa edge FICTÍCIA, então
exercita o ramo `?? "nao-mapeada"`. Sem um segundo caso sobre edge REAL, o `fonte` de todas elas
poderia ser o literal do fallback e a suíte seguiria verde — o gate mediria o fallback e passaria
por garantia que não dá. O par exige SHA-256 de 64 hex numa edge real.

⚠️ **Limites que ficam, e são para dizer, não para esconder:** é fingerprint da **FONTE**, não
hash do bundle (não há `deno.lock` versionado e há range aberto `npm:@supabase/supabase-js@2`,
então a mesma fonte pode resolver dependência externa diferente); e ele **não prova atomicidade**
do deploy manual — deploy que misture `_shared/` novo com `index.ts` velho faz o mapa (que é fonte
também) mentir junto. Só hash calculado em RUNTIME fecharia isso, e a edge não lê a própria fonte
em Deno Deploy.

⚠️ **Custo aceito:** o `fonte` de cada edge só muda em prod no PRÓXIMO deploy dela. Depois de um
toque em `_shared/`, as ~30 edges passam a reportar fonte diferente da `main` até serem
redeployadas — é VERDADE (elas rodam código velho), mas é volume de alarme, e deploy de edge aqui
é manual. Quem sonda deve ler `fonte` como "de que fonte este bundle foi buildado", não como
"pendência a zerar".
## O escopo que ficou aberto: auditoria dos 7 `contrato` de CANÁRIA (2026-08-25)

A ⚠️ "Escopo desta auditoria" acima fecha aqui. Critério idêntico ao das sondas, adaptado: para
cada canária, o commit que definiu o `contrato` atual, e depois **os commits que alteraram os
símbolos que a fixture EXERCITA** — não "tocou o diretório", que confunde vizinhança com
comportamento.

**Resultado: nenhum dos 7 contratos está congelado.** O caso que motivou a auditoria (#1974,
`omie-vendas-sync`) era genuíno e já estava corrigido; a classe não reincidiu nos outros seis.

| canária (edge · rota) | `contrato` atual | commit que o definiu | fatias que entraram depois | congelado? | bump proposto |
|---|---|---|---|---|---|
| `analyze-unified-order` · card de Governança | `praticado-vence-omie-v1` | 49f824abd (2026-08-23) | e70bfa050 (#1938, `searchCustomer` STRING) · e2a4acc2c (corpo tipado) | **não** — `mergeCustomerPrices` intocado; as duas fatias são de prompt/corpo e a SONDA (`v1.1-corpo-tipado`) as cobre | — |
| `omie-vendas-sync` · `identidade_probe` | `identidade-a2-client-to-user-v2` | 97194df1b (#1974) | nenhuma | **não** — caso de referência, já corrigido | — (feito no #1974) |
| `omie-analytics-sync` · `doc_ambiguo_probe` | `doc-ambiguo-fail-closed-v1` | d8cf07152 (2026-08-23) | 81f9a111c (#1991) · 883080edb · c63820508 (#1992) | **não** — `docsComCodigoAmbiguoNoOmie` intocado | — |
| `omie-analytics-sync` · `transferencia_probe` | `transferencia-codigo-fail-closed-v1` | 81f9a111c (#1991) | 883080edb · c63820508 (#1992) | **não** — `classificarLoteProof` intocado | — |
| `carteira-rebuild` · `?canary=1` | `trava-saida-v1` | 56f9f58b3 (2026-07-20) | f6561b0b2 (4 guards de paginação) · 5f5523df9 (import) | **não** pelo critério — mas ver "o furo que a auditoria achou" | `trava-saida-e-guards-paginacao-v2`, **na próxima fatia** — não agora (ver abaixo) |
| `generate-tactical-plan` · `{"canary":true}` | `v1.1-paginacao-eof-e-cursor` (campo `versao`) | 7f1198cf0 (2026-08-24) | nenhuma | **não** | — |
| `omie-financeiro` · `paginacao_probe` | `paginacao-guards-v1` | dba6593fa (2026-07-29) | 2eb237532 (`Deno.serve`) · 5b8501144 (sonda) | **não** — `desfechoVarreduraReversa`/`fingerprintPagina`/`listaOmie` intocados; a sonda cobre as duas fatias por ancestralidade | — |

⚠️ **`git log -L :função:arquivo` produziu um falso positivo, e por pouco não virou veredito.** Ele
apontou o `81f9a111c` como tendo alterado `docsComCodigoAmbiguoNoOmie` — a tabela-verdade da
`doc_ambiguo_probe`. Não alterou: o commit ADICIONA um bloco MIRROR novo logo após o `MIRROR-END`
da função, e o `-L` seguiu o **hunk header**, que nomeia a função ENCLOSING por proximidade, não
por alteração. `-G'function <nome>'` restrito ao `index.ts` separa os dois. A lição da auditoria
das sondas se repete um nível abaixo: ali era a intuição que errava o alvo, aqui é a ferramenta.

### O furo que a auditoria achou não é um contrato parado — é a falta de gate

O resultado limpo esconde uma assimetria de mecanismo, e a seção anterior (o fingerprint SERVIDO
do #1998) **aumentou** essa assimetria em vez de fechá-la — medido, não suposto:

| das 6 edges com canária | tem sonda (`versao.ts`) | entra no mapa de `_shared/sonda-fingerprints.ts` |
|---|---|---|
| `analyze-unified-order` · `omie-analytics-sync` · `generate-tactical-plan` · `omie-financeiro` | sim | **sim** (4 das 32) |
| `omie-vendas-sync` · `carteira-rebuild` | **não** | **não** |

As duas de fora são exatamente aquelas cuja ÚNICA prova de deploy é a canária. As outras quatro
têm canária **e** sonda, e agora ganharam de brinde um discriminador que não depende de disciplina
nenhuma — o `fonte` servido muda sozinho quando a fonte muda. Ou seja: o mecanismo novo foi
para quem já tinha duas provas, e não alcançou quem tem uma só. Não é crítica ao #1998 (ele
resolve outro problema, e o declara); é onde o próximo esforço rende.

Depois do #1993, **omissão** de bump tem gate para SONDA e não tem para CANÁRIA: `scripts/sonda-versao-bump-gate.ts` pula toda edge sem
`versao.ts` (`if (fonteHead === null) continue`), e o teste de contrato pega só a REGRESSÃO. As
duas canárias **sem sonda** — `carteira-rebuild` e `omie-vendas-sync` — ficam fora de tudo: o
gate substituto que o comentário do script cita (`nenhuma edge que serve o paginate.ts fica SEM
prova de deploy`) não alcança a `carteira-rebuild`, que não importa o `paginate.ts`.

O caso concreto: o `f6561b0b2` instalou 4 guards money-path na `carteira-rebuild` — `data == null`
sem `error` passa a `failLease` em vez de encerrar o laço com a carteira TRUNCADA — e o
`trava-saida-v1` é de 8 dias antes. A canária responde a mesma string com ou sem os guards. **Não
bumpamos**, e a razão é a deste documento: o fix está em prod há semanas, bump tardio não devolve
discriminação perdida, e o bump agora compraria um deploy no-op sem responder nada que já não
esteja respondido. O bump certo é o da PRÓXIMA fatia dela — e é justamente esse que ninguém
lembra, porque nenhum gate cobra.

**O desenho que já resolve isso está no repo, na `generate-tactical-plan`:** ela serve o marcador
da canária no campo `versao`, o MESMO símbolo da sonda. Sendo o mesmo símbolo, a canária herda o
gate do `sonda:bump` de graça. Custo de copiar: a resposta passa a ter `versao` no lugar de
`contrato`, e a §Canárias do `deploy.md` manda exigir o campo `contrato` — quem verificar pelo
nome errado lê `undefined` e reprova canária sadia. Por isso a tabela de lá agora marca o campo.

### Achados colaterais — e o único bump que esta auditoria produziu

1. **Uma 7ª canária existia fora da tabela.** A `transferencia_probe` (#1991) nasceu versionada e
   correta e ficou 1 dia invisível para quem verifica deploy, porque a tabela do `deploy.md` é a
   lista que o verificador lê. Ela também torna o par (edge, canária) **1:N** — "a canária da
   `omie-analytics-sync`" virou ambíguo, e a `action` é quem desempata.

2. **Duas afirmações no repo diziam que a `doc_ambiguo_probe` é "NÃO-versionada"** (no `versao.ts`
   da edge e no teste de contrato), e ela é versionada desde d8cf07152. Ambas eram o ARGUMENTO
   para instrumentar a edge com sonda. O argumento sobrevive, mas por outra razão — e a diferença
   é exatamente a tese deste documento: a canária não é cega por FALTA de marcador, é cega porque
   o marcador dela está parado enquanto a edge andou três fatias. Corrigidas.

3. **A sonda da `omie-analytics-sync` congelou pela TERCEIRA vez** — e este é o bump efetivo que a
   auditoria produziu (`v1.1-mapa-codigo-sem-alias` → `v1.2-produtos-teto-500-e-partial-honesto`).
   O #1992 (c63820508) trocou o teto de páginas de `products` (10 → 500), consolidou o
   `updateSyncState` que gravava `status:"complete"` INCONDICIONALMENTE no que grava
   `complete ? "complete" : "partial"`, e tirou o `syncProducts` do full sync. Passou porque o
   gate do #1993 **mergeou depois dele** (`git merge-base --is-ancestor d79fb41d7 c63820508` →
   não): gate de transição não enxerga omissão antiga, como ele mesmo declara. Achado rodando o
   gate **para trás** — `--base c63820508^ --head c63820508`, exit 1 —, que é uma varredura que
   vale repetir a cada instalação de gate de transição: ele nasce cego para todo o passado.

⚠️ **O congelamento cobrou o preço DENTRO desta auditoria, não em tese.** Para decidir se o bump
pegava carona num deploy pendente ou criava um no-op, precisei responder "o #1992 já está no ar?".
Não consegui: o dado de prod é ambíguo (`sync_state` de `products/colacor_vendas` diz `complete`,
4297, `last_page` 43 — e 43 > 10 **não** prova travessia, porque o bundle velho gravava `last_page`
com o total DECLARADO pelo Omie) e a sonda responde a mesma string tendo o #1992 subido ou não.
Foi a pergunta que o marcador existe para responder, feita no momento exato para o qual ele existe,
e a resposta foi silêncio. Isso desempata o custo do "deploy no-op" que este documento adverte: o
deploy desta edge não é no-op, ele **compra a resposta que hoje não existe**.

## O débito que o gate por diff NÃO vê — auditado com o próprio gate (2026-08-25)

O gate aceita `--base`/`--head`, então uma fatia histórica pode ser julgada pela régua real:
`bun scripts/sonda-versao-bump-gate.ts --base <c>^ --head <c>`. Método: para cada uma das 32
edges instrumentadas, achar o último commit que mudou o **valor** de `VERSAO`
(`git log -G'^export const VERSAO'` — **`-S` não serve**: ele conta ocorrências da string, e
mudar só o valor mantém a contagem, dando falso negativo), e rodar o gate em cada fatia posterior.

⚠️ **A primeira passada FABRICOU VEREDITO, e a armadilha é de shell — não do gate.** O laço era
`for c in $fatias`, com `$fatias` sendo a saída multi-linha do `git log`. **O `zsh` não faz
word-splitting em expansão não-citada**: o laço rodou UMA vez com o blob inteiro como revisão, o
`git rev-parse` recusou, o gate reprovou fail-CLOSED ("não consegui determinar a BASE") e o
`grep` por `✗ <edge>:` não casou — o que foi contabilizado como **limpo**. Saíam 21 edges limpas
e 1 reprovação, com ar de medição. O conserto tem duas partes e as duas importam: iterar por
LINHA (`while IFS= read -r`) e **exigir o `✓` positivo** para classificar como limpa. "O gate
reprovou" e "o gate recusou medir" são estados diferentes que produzem o MESMO `exit 1` — quem
lê só o código de saída não os distingue, e ausência de `✗` é ausência de dado.

Resultado com a régua real — 32 edges, 12 fatias pós-bump, **10 limpas, 2 reprovam, 0 indeterminadas**:

| edge | fatia | marcador congelado | o que a fatia mudou |
|---|---|---|---|
| `disparar-pedidos-aprovados` | `dc67b4261` (14/08) | `v1.1-marco-causal` | encanamento da sonda: `respostaSonda()` → `respostaSonda(VERSAO)` e a mensagem do 400 ambíguo |
| `omie-analytics-sync` | `c63820508` (#1992) | `v1.1-mapa-codigo-sem-alias` | `MAX_PAGINAS_PRODUTOS` 10 → 500 (truncava 27% do catálogo, todo dia) |

⚠️ **As duas edges Sayerlack não estão congeladas** — foram bumpadas em `6776341f7` para
`v1.1-pos-login-no-envio` e `v1.1-pos-login-na-captura`. Uma medição por `git log` **sem** o
stripper de comentários as acusa; a régua real, não.

⚠️ **O `#1992` escapou do gate por 7 minutos** (mergeou 00:46:13, o gate `#1993` às 00:53:04).
É a mesma distância do `#1970`→`#1971` que abriu este documento. O limite "gate de transição não
descobre omissão antiga" não é teórico: ele nasceu com um caso dentro.

### A decisão: NENHUMA das duas é bumpada

O corolário deste documento manda o bump pegar carona num deploy **já obrigatório**. Nas duas, ele
não pega:

- **`omie-analytics-sync` — o fix JÁ ESTÁ EM PRODUÇÃO, provado por DADO, não pela sonda.** A sonda
  é justamente quem não consegue responder: em 2026-08-25 09:59:35 UTC (`request_id` 59941) prod
  respondeu `{"ok":true,"probe":true,"versao":"v1.1-mapa-codigo-sem-alias","edge":"omie-analytics-sync"}`
  — o MESMO marcador da `main`, compatível com o deploy tendo ou não acontecido. Quem desempatou
  foi o sensor de dados: `sync_state` de `products` está `complete` com `total_synced = 4297` às
  06:17:58 UTC. Com `maxPages = 10` e `registros_por_pagina: 100` o teto é 1.000 e o `complete`
  seria impossível — o run é pós-fix. Bumpar agora só criaria **deploy no-op**, e o bump tardio
  não devolve a discriminação perdida.
- **`disparar-pedidos-aprovados` — a fatia tem 11 dias e a discriminação já existe de graça, por
  FORMA.** A mudança é encanamento da própria sonda. E o `ad43dd625` (18/08, **posterior** a
  `dc67b4261`) passou a emitir o campo `edge` na resposta: um probe que devolva
  `"edge":"disparar-pedidos-aprovados"` prova bundle ≥ 18/08, logo ≥ `dc67b4261`. **A forma da
  resposta domina o valor do marcador nessa transição** — bumpar compraria um deploy manual da
  edge de money-path mais cara do repo para provar o que a resposta já prova.

As duas se curam sozinhas na próxima fatia real, porque o gate agora está lá para exigir.

## O `FONTE_SHA256` por LEDGER: o desenho que PERDEU para "servir" (2026-08-25)

⚠️ **Esta seção nasceu meio obsoleta, e COMO isso aconteceu é a lição mais cara dela.** Ela
registra uma avaliação independente do desdobramento, conduzida em paralelo — e, enquanto corria,
a seção "A METADE de `_shared/` fechada por fingerprint SERVIDO" acima **entregou o mecanismo**,
com escopo maior e desenho melhor. A checagem de coordenação que eu fiz antes do PR procurou
colisão nos MEUS arquivos (`git grep montarEstado origin/main`) e **não pelo ARTEFATO da tarefa**
— que é precisamente o eixo que o `CLAUDE.md` manda conferir ("a tarefa pode já estar ENTREGUE na
main sem colidir com arquivo seu") e o único que teria pego isto. Buscar o próprio símbolo é
buscar colisão, não duplicação.

O que a avaliação apurou, e que continua valendo como registro do caminho NÃO tomado:

O contra a fechar era: *sem histórico, nada impede regravar a impressão sem bumpar o `VERSAO`* —
os dois estados finais são internamente consistentes, logo indecidíveis por qualquer predicado
sobre o estado atual do repo. O desenho que eu levei ao Codex (`gpt-5.6-sol`, `xhigh`) fechava
isso com um **ledger append-only** no próprio `versao.ts` (pares `{versao, sha256}`) e duas
metades: sem-estado (impressão bate com a última entrada · `VERSAO` é o da última · **`versao` é
ÚNICO no ledger**) e com-diff (o ledger da base é PREFIXO do do HEAD). A unicidade é o fecho: quem
regrava sem bumpar apenda uma segunda entrada com o slug que já está lá, e "um marcador nomeia UMA
impressão" é decidível sem histórico nenhum.

**E mesmo assim perde para o que foi entregue, por uma razão só e ela é decisiva:** o ledger fecha
o furo no CI; **servir o fingerprint fecha o furo na PRODUÇÃO**. Regravar o hash deixa de ser
exploit não porque um fiscal reclama, mas porque a resposta da sonda muda junto — a discriminação
foi preservada, que é a propriedade que se queria desde o começo. É o "mudar a PROPRIEDADE, não o
verificador" da seção de desenho, e eu o havia subestimado ao me concentrar na variante guardada.

O que o Codex acrescentou e sobrevive à entrega:

1. **A fuga que o ledger NÃO alcança é acidental, não sabotagem:** um `push` direto (o sync
   bidirecional do Lovable é exatamente isso) muda o corpo e regrava a impressão; a metade
   sem-estado passa e a com-diff **não roda**, porque o gate de diff é `pull_request`. Fechar isso
   pedia dar base ao diff no `push` (`github.event.before`), não carregar estado no arquivo.
   "Mudou" exige uma base — o ledger era uma tentativa de fingir que tinha uma.
2. **Duas entradas novas na mesma fatia driblam a metade sem-estado:** prefixo, unicidade e
   impressão atual passam com a PENÚLTIMA entrada falsa. Exigiria "no máximo uma entrada nova por
   edge por transição" — mais superfície ainda.
3. **Bootstrap não é histórico.** A primeira entrada só abençoa o corpo atual sob um slug que pode
   estar congelado há fatias — nas duas edges auditadas acima seria literalmente isso. Chamar
   aquilo de `HISTORICO_FONTE` venderia o que não se sabe.
4. **Nome:** com `_shared/` de fora, a impressão não seria do bundle nem do "corpo servido" — o
   fecho transitivo do desenho entregue é justamente o que torna o nome honesto.

## Os dois falsos-verdes que o `#1993` embarcou — e que valiam mais que o mecanismo novo

A 2ª opinião apontou dois, e os dois são REAIS. Estavam ambos FORA do núcleo puro, que tinha 23
testes verdes e não os alcançava — a moral é que gate se testa também na fronteira de I/O.

1. **O status do `git diff` era descartado** (`const { saida } = git(args)`). Comando que falha
   devolve saída vazia → "nenhuma edge tocada" → imprime o `✓`. MEDIDO: a MESMA fatia que reprova
   (`--base e70bfa050^ --head e70bfa050` → `rc=1`) devolvia **`rc=0` com o `✓`** trocando o
   `--head` por rev inexistente — porque o `--head` entrava CRU no comando, sem nunca ser
   resolvido. Um gate cujo cabeçalho promete fail-CLOSED aprovava por cegueira.
2. **`versao.ts` ausente no HEAD era `continue` silencioso.** Apagar o marcador junto com a
   mudança de corpo DESINSTRUMENTA a edge e o gate aplaudia. Quem separa os dois casos é a BASE:
   edge que nunca teve marcador segue isenta (`versaoBase === null`); edge que TINHA e perdeu vira
   `marcador-ilegivel`.

Corrigidos com o seam `montarEstado(tocados, base, head, ler)`, que torna a fronteira de I/O
testável sem git. **Os dois se cobriam** — tirar um deixava o outro segurando o teste —, então a
suíte ganhou um assert por furo, e a falsificação virou contrato executável em
`scripts/mutcheck.d/sonda-versao-bump-gate.mut` (9 mutações, 8 PEGA, controle+ ✓): falsificação
que só roda à mão é ausência de dado.
