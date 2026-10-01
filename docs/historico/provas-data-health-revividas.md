# As 3 provas de data-health apodrecidas, revividas no corpo vivo do trio

**2026-09-30.** Fatia 1 da revivência registrada em
[provas-db-mortas-fora-do-nucleo.md](provas-db-mortas-fora-do-nucleo.md). As três morreram do mesmo
modo — re-aplicavam a migration da sua fase sobre o `schema-snapshot.sql`, e um re-dump absorveu a
fase:

| prova | como morria | matador |
|---|---|---|
| `test-data-health-familia-ausente.sh` | no setup: `relation "public.omie_clientes" does not exist` (a `20260604150000` de junho referencia a tabela que a Fatia 5 do épico-drop dropou) | `9c9aae173` (#1509, re-dump) |
| `test-familia-ausente-lista-email.sh` | idem | idem |
| `test-data-health-carteira-rebuild.sh` | no A5 "+1 check": esperado 30, veio 25 — o `CREATE OR REPLACE` de julho REVERTIA o compute no banco de teste | `e3d500327` (#1675, re-dump) |

Agora as duas que sobram medem o trio que PRODUÇÃO executa, pelo
[`db/lib/data-health-vivo.sh`](../../db/lib/data-health-vivo.sh), e estão no núcleo (eixo
sensores). A de lista-email foi fundida na de família.

## "Versão viva", medida e não presumida

`md5(pg_get_functiondef())` via `psql-ro` × o banco local (snapshot + MV + ACL de prod + a cadeia
`0918 → 0920a → 0920b → 0922`): **6/6 iguais**, as mesmas de 2026-09-27 — compute `4cc51b…`, watchdog
`9f4cf1…`, heartbeat `2de28c…`, episódio `81af54…`, os 2 helpers de lista `ee9c45…`/`e1dec0…`. E a
7ª, que esta fatia passou a ler: `get_data_health` `ee63a0…`, igual já no snapshot (última
redefinição em 2026-05-27).

Os dois ramos têm, no corpo vivo, exatamente a semântica que as mortas asseveravam:
`vendas_familia_ausente` conta `NULLIF(btrim(familia),'') IS NULL AND COALESCE(ativo,false) AND
account IN ('oben','colacor')`, com breakdown e stale/warning com n>0; `carteira_rebuild` corta em 30h
sobre `max(carteira_assignments.last_synced_at)`, broken com a tabela vazia.

## Família ausente — por que fundir as duas

Semeavam o MESMO catálogo, e o invariante que as une — **o helper lista o que o compute conta** — só se
prova com os dois no mesmo estado. Na prova fundida, cada lado do predicado é sabotado com o outro
verde: as sabotagens do compute (sem `btrim`, sem `NULLIF`, contando inativo, contando `colacor_sc`)
derrubam F4 com o helper em L9=5; as do helper derrubam L9 com o compute em F4=5. A lista que diverge da
contagem manda o founder classificar o produto errado — e nenhuma das duas mortas provava isso dos dois
lados.

**Portado da lista-email** (só ela tinha): o formato `• [conta] descrição (cód. X)`, o cabeçalho, as
exclusões, o cap honesto ("… e mais N"), o "sem cap não anuncia", a ordem por conta e por descrição,
o NULL com n=0, e o e-mail com a lista depois da mensagem original.

**Re-derivado do watchdog vivo, não copiado:** o E2E roda numa rodada COMPLETA (pré-condição: sem ela, o
watchdog engole o erro do compute e o negativo passa por vacuidade), abre o episódio (`fin_alertas`,
1 e-mail), e dispensa com n=0 — e não re-dispara depois de dispensar, porque o anti-flap do
`_data_health_episodio` não re-enfileira e-mail de episódio dispensado há < 2h. Dois asserts novos, que
o watchdog de junho nem tinha como ter: o e-mail **começa** pela mensagem do compute (W5), e o ALERTA
leva só a mensagem, sem a lista volátil (W6).

**O que as mortas tinham de vácuo, consertado ao portar:**

- a ordem (`strpos('[colacor]') < strpos('[oben]')`) passava com a conta AUSENTE — `strpos` devolve 0,
  e `0 < n`. Agora exige `> 0` antes de comparar;
- o anti-cascata (`pg_get_functiondef(watchdog) LIKE '%estoque_reposicao%'`) era verde com o source
  FORA do push: o nome aparece 2× no watchdog vivo, uma delas num COMENTÁRIO. Nem o conserto textual
  do molde tint (código sem comentários, o literal entre aspas) basta: um `/* … */` ou o literal em
  outro ponto do corpo o manteriam verde. Virou EXECUTÁVEL — no seed, `estoque_reposicao` e
  `omie_tipo_produto_oben` ficam degradados, e o assert exige o alerta aberto de cada um (W7/W8, o
  valor `true|1` diz qual das partes caiu), com uma sabotagem para cada. É a única guarda do núcleo
  sobre o `estoque_reposicao` no push.

**Acrescentado:** F7 — sendo check de CONTAGEM, a idade e o esperado saem NULL (ausente ≠ zero: `0`
leria "atualizado agora" no painel), com a sabotagem que os fabrica.

**Não portado, com o porquê:** a contagem total de checks (`= 17`, "os 16 anteriores seguem") — o corpo
cresce toda semana (hoje 30 sources) e a contagem não é invariante de ninguém; o equivalente vivo é
"o ramo aparece 1×" (F1). E os dois patches de setup (`tipo_produto`, `fin_audit_trigger` neutralizado)
eram artefatos do snapshot velho.

## Carteira rebuild — o A5 e a única superfície do ramo

O A5 "+1 check" era invariante da REVISÃO de julho; no corpo vivo virou "o ramo existe exatamente 1×"
(R1) e "os vizinhos seguem, 1× cada" (R2, por `count(*)`: um vizinho DUPLICADO também é quebra — o
watchdog vivo não roda o laço com fonte duplicada), cada um com sabotagem (`ramo_some`,
`vizinho_some`). O corte em 30h agora é sabotado pelos DOIS lados (`limiar_frouxo` derruba o
31h→stale; `limiar_apertado` derruba o 29h→ok — o A3 antigo não tinha sabotagem), a idade é a do
rebuild (R7, `idade_fabricada`), e o incidente de 2026-07-28 volta como sabotagem: `mede_o_scoring` faz
o ramo ler `farmer_client_scores` (o writer errado) e cai nos DOIS sentidos — rebuild fresco com o
scoring parado (R5) e o incidente (R13/R14).

**O scoring é controlado à parte, e não por acaso.** O `INSERT` na carteira dispara
`reconcile_score_owner_from_carteira`, que CRIA a linha do cliente em `farmer_client_scores` com
`calculated_at DEFAULT now()`: na versão anterior desta prova (e na 1ª revivida), o "scoring fresco" do
incidente vinha da própria carteira, e o "dois writers" era encenado por um INSERT só. O veredito não
mudava; a encenação, sim. Agora o `semear` fixa o scoring em 40h por upsert explícito, o R11 exige o
`carteira_scores` stale ANTES do recálculo, e só o S6 (o writer do scoring) o deixa fresco.

**A única superfície do ramo é o app.** `carteira_rebuild` está FORA do `v_sources` do watchdog e do
resumo do heartbeat desde que nasceu — a `20260729160000` só tocou o compute ("acrescenta UM ramo
UNION ALL"), e nenhuma migration seguinte o promoveu. Ele aparece em `get_data_health()` (a RPC que
`useDataHealth` lê para o banner e o badge), que repassa todas as fontes. Por isso a prova vai até lá
(R14), COMO o app a chama — papel `authenticated`, com o ACL de prod reproduzido na lib (medido:
`authenticated` e `service_role` executam, `anon` não) —, com a sabotagem `app_filtra`: a classe "lista
IN esqueceu um source" já calou o `sync_state_saude` no heartbeat por 5 dias. E o R4 guarda o ACL:
`migracao_nova_drop_create` redefine a RPC por `DROP`+`CREATE` (a armadilha do CLAUDE.md — o ACL volta
ao default, EXECUTE a PUBLIC) e o `anon` passa a executar, com a RPC funcionando. Nenhuma sentinela
authz cobre a `get_data_health` hoje. A prova NÃO congela o "fora do push": não há decisão escrita, e
promover a e-mail é pergunta de produto (abaixo).

**`get_data_health` entrou em `DHV_GUARDADAS`.** Sem isso, a próxima migration que a redefinisse
ficaria fora da cadeia dinâmica e a prova seguiria medindo a do snapshot. Provado pelos dois lados: com
ela na lista, `migracao_nova_app_filtra` fica vermelha em R11; tirando-a (contrafactual, só na árvore,
restaurado por `git checkout`), a mesma sabotagem reprova com "a seleção dinâmica NÃO pegou a migration
nova". A cadeia de hoje não muda (nenhuma migration ≥ `20260918200000` redefine `get_data_health`), então
as provas tint não são afetadas.

## Falsificação — medida

Cada sabotagem troca UM trecho do corpo vivo (`dhv_sabotar`: âncora única conferida, md5 tem de
mudar) e declara o assert que TEM de cair e os que têm de seguir verdes; o juiz é byte-idêntico ao do
molde tint.

| prova | modo normal | `--falsificar` em `LC_ALL=C` | em `pt_BR.UTF-8` |
|---|---|---|---|
| família ausente | `PASS=39  FAIL=0` | `SABOTAGENS: 20 vermelhas / 0 falhas` | 20/0 |
| carteira rebuild | `PASS=20  FAIL=0` | `SABOTAGENS: 13 vermelhas / 0 falhas` | 13/0 |

Controle verde na MESMA invocação, antes da 1ª sabotagem, nos dois locales. **Meta-falsificação do
juiz** (cópia temporária com 1 declaração certa e 2 erradas: `limiar_frouxo:R7`, que não vira, e uma
sabotagem inexistente): `SABOTAGENS: 1 vermelhas / 2 falhas`, exit 1 — o juiz tem dente nesta prova.

**Núcleo inteiro** (`bash db/roda-nucleo-ci.sh`, M2 com dezenas de sessões vivas, 54 min): 62 das 63
execuções verdes, as 4 destas provas incluídas (na versão de antes da revisão independente). A 63ª —
`test-positivacao-eligible-consumo --falsificar`, de outro domínio e que não lê nada daqui — reprovou
24/2 porque o PostgreSQL filho **não subiu** em 2 rodadas (`pg_ctl: could not start server`: ela põe o
socket no `/tmp` compartilhado, com TCP, e a porta é disputada com as outras sessões); re-rodada
sozinha, `SABOTAGENS: 26 vermelhas / 0 falhas`. Depois da revisão, as 4 linhas que a lib alcança (as 2
tint + as 2 daqui) pelo runner com manifesto parcial (`MANIFESTO=`): `SQL_PROOF_OK provas=4/4
falsificacoes=4/4 fora_do_ci=0`, 164 s. Custo no M2 das duas novas no modo do CI: 7 s + 57 s e 4 s +
27 s.

## Revisão independente (Caminho B)

O Codex não foi consultado: o `scripts/codex-async.sh` barrou pelo sensor de cota (86% > teto de 85%;
a janela reabre em 03/10 19:11) sem gastar a chamada. No lugar, uma revisão adversarial por subagente
só-leitura, com o mesmo roteiro (vacuidade, sabotagem que não prova o que declara, invariante sem
prova, flakiness, efeito na lib, recibo verde sem prova). Achou 5 — nenhum em vacuidade nem no juiz
(recontou o seed sob cada sabotagem) —, e os 5 entraram:

1. o scoring fresco do incidente vinha do trigger da carteira (acima) → scoring controlado + R11;
2. a idade sem prova nas duas ("ausente ≠ zero") → F7 e R7, com sabotagem cada;
3. o anti-cascata textual (mesmo o do molde) cai com `/* … */` → executável (W7/W8);
4. `get_data_health` só provada como superusuário, sem o ACL → ACL de prod na lib, R14 como
   `authenticated`, R4 + `migracao_nova_drop_create`;
5. R2 com `count(DISTINCT)` aceitava vizinho duplicado → `count(*)`.

Não substitui o Codex; cobre o intervalo. Revisão retroativa quando a cota voltar, se o founder quiser.

## Achados

1. **`carteira_rebuild` não vira e-mail** (pergunta de produto, não bug provado). O incidente de 28/07
   era "Sentinela verde"; o conserto deixou o painel vermelho, mas o vigia que manda e-mail não avalia
   o ramo. Se a carteira congelar de novo, só quem abrir o painel vê. Promover a push é uma linha no
   `v_sources` e outra no heartbeat — decisão do founder.
2. **bash 3.2 + heredoc dentro de `"$(…)"` + `trap … EXIT` sai 0 sem rodar nada** — mordeu na escrita
   desta prova (o `(` aberto do `COALESCE` no heredoc desmonta o parse). Já catalogado
   ([evidencia-positiva-shell.md](evidencia-positiva-shell.md), nº 22); a defesa que funcionou foi o
   recibo `PASS=` que o runner exige, não o exit.

## Lições

- **Fundir provas que semeiam o mesmo estado deixa provar o invariante ENTRE funções.** Duas provas
  separadas asseveravam "o helper usa o mesmo predicado do compute" cada uma do seu lado; só no mesmo
  seed a sabotagem de um lado pode exigir o outro verde.
- **Check dashboard-only tem UMA superfície, e a prova vai até ela.** Parar no compute provava o ramo,
  não o que o founder vê — e a RPC do app é exatamente o tipo de lista que já esqueceu source.
- **Asserção textual sobre corpo de função casa COMENTÁRIO.** O anti-cascata antigo ficaria verde com
  o source fora do push; tirar os comentários de linha não basta (`/* … */`, o literal em outro ponto).
  Quando o seed já produz o efeito, meça o EFEITO.
- **Seed que dispara trigger em OUTRA tabela fabrica a pré-condição do cenário.** O INSERT na carteira
  criava o scoring fresco que o incidente exigia; a prova passava pelo motivo errado. Antes de encenar
  "dois writers", liste os triggers das tabelas semeadas e controle cada writer à parte.
