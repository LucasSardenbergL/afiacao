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
