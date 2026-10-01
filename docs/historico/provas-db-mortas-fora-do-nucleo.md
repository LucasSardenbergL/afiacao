# Provas `db/` fora do núcleo mortas na `main` — as 261, rodadas uma a uma

**2026-09-28.** O #2636 achou `db/test-pendencias-deploy-eco-passivo.sh` morto havia 22 dias na
`main`: saía 1 antes do primeiro assert, e ninguém via, porque o CI roda só as 45 provas de
`db/nucleo-ci.txt`. Aqui as outras **261** foram rodadas, uma a uma, contra a `main` (`f3dbf0d46`).
Resultado: **12 apodrecidas** (8 mortas antes do 1º assert, 4 vermelhas por assert), **nenhuma
regressão de produção** por trás delas, e **9 das 12 com a mesma causa** — a prova carrega o
`schema-snapshot.sql` e re-aplica a migration da sua fase, e um re-dump do snapshot a mata. Um único
re-dump (`9c9aae173`, #1509) matou 7.

## Passo 0 — instância única ou classe?

**Classe.** O eco-passivo era a 3ª ocorrência registrada: 5 dos 8 harnesses de data-health já
tinham apodrecido em 2026-08-14 ([sync.md](../agent/sync.md), "dependem do `schema-snapshot.sql`"),
e 2 provas tint em 2026-09-27 ([provas-tint-apodrecidas.md](provas-tint-apodrecidas.md)). Cada vez
mediu só o seu domínio (8 harnesses de data-health, 19 tint, os 4 afetados do #2636) — nenhuma rodou
as outras. A assinatura é de COMPORTAMENTO, não de texto — "a prova sai ≠0 antes
do 1º assert, ou um assert cai por deriva do alvo" — então a varredura foi EXECUTAR, não `grep`.

## O método

- **Lista:** `db/test-*.sh` menos as linhas de `db/nucleo-ci.txt` = 306 − 45 = 261.
- **Execução:** sequencial (M2 8GB, ~40 sessões vivas), `PGPORT_TEST` único por prova (59101–59361,
  pulando porta com socket/lock em `/tmp` ou TCP escutando); prova de porta fixa só rodava com a
  porta livre (senão falaria com o Postgres de outra sessão); teto de 420 s (`gtimeout -k 20`); após
  cada uma, `git status` (árvore suja = registra e restaura) e caça de postmaster órfão (os args citam
  a porta da rodada). Um log por prova em `logs/provas-db-mortas/` (gitignorado), com o exit e a
  última linha num `_resumo.tsv`. Recibo: `FIM-DA-VARREDURA rodadas=261 esperado=261` — **zero teto,
  zero órfão, zero árvore suja**, 27 min de execução somada (a mais lenta, 95 s).
- **Classificação:** VERDE = exit 0 com recibo legível · VERMELHA-POR-ASSERT = a suíte rodou e um
  assert caiu · MORTA = saiu antes do 1º assert · SEM-RECIBO = exit 0 sem dizer o que provou. 1ª
  passada mecânica (contagem com 0 falhas, ou frase final com asserts nomeados acima); as 21 que não
  casaram nenhum formato foram lidas à mão (recibos `N ok · 0 falhas` que a regex não pegou,
  `NOTICE … OK` de prova *fail-fast*, `VEREDITO:` com `exit $FAIL`). As linhas "skip/pulado/ignorado"
  das verdes eram todas o próprio comportamento asseverado ou NOTICE do Postgres — nenhuma seção pulada.
- **Matador:** para cada apodrecida, EXECUTANDO a prova num worktree descartável — pontas conferidas
  antes (`suspeito~1` sem a assinatura, `suspeito` com ela) e `git bisect run --first-parent` onde não
  havia suspeito. O juiz do bisect é a **assinatura exata da morte** no log, nunca "saiu ≠0": a
  `melhorias-rpcs` morria por OUTRO motivo antes da assinatura de hoje, e só o controle viu.

## O resultado

| veredito | provas |
|---|---|
| VERDE | **248** (182 por contagem · 45 por frase com asserts nomeados · 21 conferidas à mão) |
| MORTA (antes do 1º assert) | **8** |
| VERMELHA-POR-ASSERT | **4** |
| SEM-RECIBO | **0** |
| fora da classe: exige insumo externo por desenho | 1 — `reparo-passivo-coerencia` (`FIXTURE=` com dados reais de prod, não versionado; prova de ocasião do reparo de 2026-09-08) |

Sinal: **12/261 = 4,6%** apodrecidas (a estimativa de "1 em 4" vinha de uma amostra de 4). Nenhuma
morte por "import de módulo TS que mudou" (o modo do eco-passivo): só 9 das 261 importam código vivo,
todas verdes.

## As 12 apodrecidas — causa, matador (medido) e decisão

| prova | veredito | o que a matou (medido executando) | desde | dias | decisão |
|---|---|---|---|---|---|
| `fornecedores-classificacao` | MORTA no seed: `unique farmer_client_scores_customer_unique` | `1c05aa8e3` "Dumped schema" (bisect) | 06-25 | 95 | **revivida** (2026-10-01, [fatia 2b](provas-carteira-revividas.md)) |
| `reposicao-demanda-insumos-bom` | VERMELHA (fail-fast em H1: `obtido=''`) | `7bf5c4637` #1315 (bisect): a allowlist de CFOP no SQL sob teste; o PR atualizou a prova IRMÃ (`reposicao-religamento`), não esta | 07-12 | 78 | reviver |
| `data-health-estoque-marcador` | MORTA no setup: `relation "public.omie_clientes" does not exist` | `9c9aae173` #1509, re-dump (controle) | 07-21 | 69 | **aposentada** |
| `data-health-familia-ausente` | MORTA no setup (idem) | `9c9aae173` (controle) | 07-21 | 69 | **revivida** (2026-09-30, [fatia 1](provas-data-health-revividas.md)) |
| `familia-ausente-lista-email` | MORTA no setup (idem) | `9c9aae173` (controle) | 07-21 | 69 | **fundida** na `data-health-familia-ausente` ([fatia 1](provas-data-health-revividas.md)) |
| `melhorias-rpcs` | MORTA: em 07-21 no 1º assert (o corpo de junho da RPC chama `carteira_visivel_para(uuid, uuid)`, que o fu7 moveu para o schema privado); desde `39ec9e31e` (08-28), já no seed (CHECK `cluster_segment`) | `9c9aae173` (bisect) | 07-21 | 69 | **revivida** (2026-10-01, [fatia 2b](provas-carteira-revividas.md)) |
| `whatsapp-hsm` | MORTA no setup: `policy "wt_staff_read" … already exists` | `9c9aae173` (controle) | 07-21 | 69 | **revivida** (2026-09-30, [fatia 2](provas-canal-revividas.md)) |
| `whatsapp-funil` | MORTA no setup (idem) | `9c9aae173` (controle) | 07-21 | 69 | **revivida e vermelha**: achou o funil quebrado para o staff em prod ([fatia 2](provas-canal-revividas.md)) |
| `whatsapp-proposta` | MORTA no setup (idem) | **nasceu morta**: no próprio merge (`250754cdf`) já morria sobre o snapshot de 07-21 | 08-06 | 53 | **revivida** (2026-09-30, [fatia 2](provas-canal-revividas.md)) |
| `data-health-carteira-rebuild` | VERMELHA: A5 "+1 check" esperado 30, veio 25 | `e3d500327` #1675, re-dump (bisect) | 08-06 | 53 | **revivida** (2026-09-30, [fatia 1](provas-data-health-revividas.md)) |
| `preco-tier` | VERMELHA: P12/P13/F6 `veio [SET]` (a medição voltou vazia) | o **calendário**: seed com `order_date_kpi = '2026-06-15'` contra `current_date - 90` | 09-14 | 14 | reviver |
| `authz-funcoes-falsificacao` | VERMELHA: F1 (×3) e F4 | F4: `6b66ca867` #2334; F1: `096b36807` (controles) | 09-07 · 09-27 | 21 · 1 | **revivida** |

**Nenhuma é regressão de produção** — conferido em prod (psql-ro) onde o sintoma podia sê-lo: o
`_data_health_compute` vivo tem o ramo `carteira_rebuild` com o corte de 30 h, e os de
`estoque_reposicao` e `vendas_familia_ausente` (este com a semântica exata que as mortas asseveram);
a `v_sku_demanda_efetiva` viva tem a explosão de BOM **e** a allowlist de CFOP; `omie_clientes` não
existe mais em prod (dropada na Fatia 5 do épico-drop, [database.md](../agent/database.md)); e o gate
de authz está certo nas duas sabotagens (abaixo).

## Os modos de morte, medidos

1. **Re-dump do snapshot (9 de 12).** A prova carrega o `schema-snapshot.sql` e re-aplica a migration
   da sua fase. Enquanto o snapshot é anterior à migration, funciona; o re-dump que a ABSORVE mata a
   prova de quatro jeitos, todos medidos aqui: DDL não-idempotente (`CREATE POLICY` → as 3 whatsapp);
   objeto que a migration velha referencia e prod já dropou ou moveu (`omie_clientes` → as 3 de
   data-health de junho; `carteira_visivel_para`, para o schema privado → melhorias); constraint ou
   trigger novo que rejeita o seed (fornecedores; a melhorias de novo, em 08-28); e corpo mais novo
   que a migration velha REVERTE (carteira-rebuild: 29 → 25 checks). O commit matador não toca prova
   nenhuma — é manutenção de DR —, e 3 re-dumps mataram as 9 (um 4º, `39ec9e31e`, matou de novo a
   melhorias).
2. **PR que muda o SQL sob teste e atualiza só a prova irmã (1).** O #1315 mudou
   `db/reposicao-demanda-insumos-bom.sql` e consertou `test-reposicao-religamento.sh`; a prova do
   próprio arquivo (que também carrega o snapshot) caiu no dia seguinte ao nascimento e ficou 78 dias
   assim. A irmã segue provando o agregado da explosão (A2: 2,7 L), o guard de CFOP (C1/C2, com a
   SAB1) e a graduação (D1); ficou sem prova executável o que só esta tinha, linha a linha: explosão
   sem fan-out (H1/H2), `valor` NULL em vez de zero (J), a unidade do insumo (K) e a venda direta
   preservada (L).
3. **Calendário (1).** Data literal no seed + janela móvel no SQL. Morre sem commit nenhum.
4. **O alvo da sabotagem evoluiu (1 prova, 2 sabotagens).** F4 editava um trecho de
   `scripts/lib/authz-funcoes.ts` exigindo `count == 1`; a Parte F (#2334) duplicou o trecho, e a
   mensagem dizia "não encontrou". F1 tirava o REVOKE da âncora de julho; a `20260927172443` re-fecha
   a função com `CREATE OR REPLACE` + `REVOKE … FROM PUBLIC, anon`, então o estado FINAL segue
   fechado — o gate estava certo em ficar verde, e a sabotagem virou vácuo.

E o dado que dá o tamanho do risco: das 261, **48 carregam o snapshot e 42 re-aplicam migration
anterior ao último re-dump (2026-09-05)** — as 9 do modo 1 estão entre elas; **33 verdes estão
armadas para o próximo**. No núcleo são 11 no mesmo padrão, mas lá o re-dump que as matar fica
vermelho no próprio PR.

## Decisões por prova

- **`data-health-estoque-marcador` — aposentada neste PR.** Provava a v2 do check `estoque_reposicao`
  (marcadores `sync_state`), que prod **abandonou em 2026-07-02**: a
  `20260702212000_data_health_estoque_reposicao_fonte_dado.sql` registra que a v2 ficou `broken`
  permanente porque os marcadores nunca existiram em prod, e causou 17 dias de surdez do Sentinela.
  Reviver seria re-provar um desenho rejeitado. A sucessora, `test-data-health-estoque-fonte-dado.sh`
  (v3, verde, 4 falsificações), prova o que roda. A morta não tinha sabotagem nenhuma; nada a portar.
- **`authz-funcoes-falsificacao` — revivida neste PR** (eixo 1, o de maior dano). F4 ancora na
  assinatura de `auditGrantsFuncoes`; F1 tira o REVOKE da âncora **e** de cada re-fecho posterior,
  que é DECLARADO — um re-fecho novo reprova com "PREMISSA DO F1 MUDOU", em vez de virar
  "FALHA … exit=0", que se lê como furo no gate; sabotagem que não aplica falha com nome próprio e não
  roda o `espera`; F4 e F5 declaram o `describe` que TEM de cair (medido: com o detector desligado, 31
  linhas `authz-funcoes.test.ts > auditGrantsFuncoes`; com a allowlist aberta, a
  `AUTHZ_FUNCOES_FECHADAS — sanidade do contrato > nenhuma entrada permite anon`) — "vitest saiu 1"
  aceitava qualquer quebra. **E aceitou ao vivo:** o 1º controle da versão revivida esperou mais de
  30 min pela vaga do `heavy` (1 slot nesta máquina; até 18 processos `heavy` vivos na hora), e ele saiu 1 com
  `heavy: timeout … abortando` **sem rodar o vitest**. O juiz antigo teria impresso "OK F4 — detector
  desligado derruba os testes"; o novo reprovou (`codigo=0`) e passou a imprimir a linha que explica.
  A varredura do #2636 tinha classificado este harness como já-correto.
  Meta-falsificação (C e pt_BR; nas cópias, o vitest vira a saída REAL medida de cada sabotagem, para
  não enfileirar 16 vezes no `heavy`): **10/10 nos dois locales** — controle com 0 falhas; M1 (um
  re-fecho NÃO declarado depois da âncora) → "PREMISSA DO F1 MUDOU" e só o F1 falha; M2 (a âncora do
  F4 duplicada, o que a Parte F fez) → "casou 2 vez(es)" e só o F4; M3 (o `heavy` desistindo da fila,
  saída real) → só o F4, `codigo=0`; M3′ (a mesma, com o juiz antigo) → `OK F4`: o furo reproduzido,
  e a marca é a camada que o pega. Árvore limpa ao fim. Com o vitest de verdade: F1–F3c verdes no
  controle real; F4 e F5 medidos à mão (rc=1 e a marca presente).
- **As outras 10 — reviver, apontando para o alvo de HOJE**, em fases por domínio (abaixo, com dono):
  - data-health (`familia-ausente`, `familia-ausente-lista-email`, `carteira-rebuild`): montar o
    trio vivo por `db/lib/data-health-vivo.sh`. As especificações seguem valendo em prod e o destino
    não tem prova nem falsificação executável — o núcleo só tem o T12 textual ("o watchdog chama o
    helper"). Os asserts de
    push E2E precisam ser re-derivados do watchdog vivo (episódio + anti-flap), não copiados;
  - canal (`whatsapp-hsm`, `-funil`, `-proposta`): as migrations de 07-13 já estão no snapshot e
    nenhuma posterior redefine os objetos; parar de re-aplicar o que o snapshot absorveu — o INSERT de
    templates da `010000` é dado, não schema, e tem de continuar entrando. Templates, log idempotente,
    funil e proposta não têm outra prova; a irmã `whatsapp-pendentes` (verde, falsificação ×2) cobre
    só a RPC de pendentes;
  - carteira e canal Melhorias (`fornecedores-classificacao`, `melhorias-rpcs`): seed compatível com
    o trigger/CHECK de hoje; e a `melhoria_clientes_por_produto` foi redefinida duas vezes depois da
    migration que a prova re-aplica (`20260718150000`, `20260905225613`) — medir o corpo vivo. O corpo
    vivo dela é exercitado, cada um no seu eixo, por `preco-ausente-nao-e-zero` (núcleo) e
    `fu7-helpers-schema-privado`; guards, RLS de itens/mensagens e `melhoria_produtos_relacionados`, e
    as 4 funções de fornecedores, só as mortas provavam;
  - money-path (`reposicao-demanda-insumos-bom`, `preco-tier`): CFOP da allowlist no seed do bloco H
    (a exclusão da 6202 já é provada, com sabotagem, na irmã `reposicao-religamento`); datas relativas
    ao relógio; e o `medir_abaixo_piso_tier`/`get_ultimos_precos_cliente` que a prova mede são os de
    07-04, redefinidos em `20260718190000` e `20260927172443` — a borda do dia do corpo vivo é provada
    no núcleo (`hoje-sp-sessao-utc-precos-piso`), a política de tier (P1–P13, gates N, sabotagens F)
    só na morta.
  Toda revivida que carregar o snapshot **entra no núcleo** — é regra desde 2026-09-27
  ([database.md](../agent/database.md), "Prova que carrega o `schema-snapshot.sql` entra no núcleo"):
  revivê-la fora do CI é marcar a próxima morte.
- **`reparo-passivo-coerencia` — mantida**, fora da classe: é a prova de ocasião do reparo de
  2026-09-08 e roda, por desenho, sobre um extrato de prod que não se versiona. Todo sensor abaixo a
  declara como exceção, com este motivo.

## O sensor — proposta (o custo de CI/RAM é decisão do founder)

**2ª opinião: NÃO consultada.** O `scripts/codex-async.sh` barrou pelo sensor de cota (86% > teto de
85%; a janela reabre em 03/10) sem gastar a chamada — Caminho B, registrado aqui e no PR.

Julgadas pela régua: pega os 4 modos, e em quanto tempo? · o vermelho cai em quem pode agir? ·
tem falha aberta? · custo recorrente e único? · ruído por ambiente?

| opção | modos | quem vê | custo | risco |
|---|---|---|---|---|
| **A. rodada semanal no CI**, não-bloqueante, com ledger commitado (verde · morta-conhecida com dono) e Issue só na TRANSIÇÃO | os 4, em ≤ 7 dias | uma Issue, não o autor do matador | ~15–25 min/rodada (estimado; 27 min na M2 em swap) ≈ 60–100 min/mês; único: shim do Homebrew no ubuntu (257/261 fixam o PGBIN do Homebrew; várias chamam `brew --prefix`) | cron desligado após 60 dias sem atividade; ledger com "morta conhecida" eterna (exigir dono + prazo); a 1ª rodada no ubuntu MEDE o ruído de ambiente |
| B. gatilho: PR/push que toca `schema-snapshot.sql`/`stubs-supabase.sql` roda as provas acopladas | só o modo 1 (9/12), no commit matador | o autor do re-dump (DR, às vezes urgente — não deve bloquear) | só nos commits que tocam o snapshot (13 desde junho) | não pega calendário, PR em SQL sob teste, nem gate |
| C. gate textual (vitest lendo fonte): prova acoplada ao snapshot não re-aplica migration anterior ao último re-dump, com baseline ratchet dos 42 atuais | previne o modo 1 em prova NOVA | o autor da prova, no PR | ~0 | não detecta morte das existentes |
| D. rodada local periódica (launchd) | os 4 | o founder | 27 min de M2 8GB por rodada; laptop dorme | falha aberta silenciosa |
| E. promover ao núcleo | os 4, no PR matador (calendário: no `schedule` diário) | o autor do matador | ~segundos por prova por PR | seletivo por desenho (o núcleo é curado por eixo de dano) |

**Recomendação:** **E** para toda revivida acoplada ao snapshot (a regra já existe; é o que faz a
morte cair no PR que a causa) + **A semanal** como o sensor das outras ~250 + **C** como prevenção
de custo zero. B fica redundante com A + E. Nada de A foi comitado: sem a decisão do custo, o
runner desta varredura segue em `logs/` (gitignorado), e a primeira entrega de A é medir o ruído do
ubuntu numa rodada manual (`workflow_dispatch`).

## A classe vizinha, medida e não erradicada: versão coberta ≠ versão entregue

Aplicar uma migration cujo objeto (função/view) uma migration POSTERIOR redefiniu mede um corpo que
prod não roda — mesmo quando a prova fica verde. Heurística textual (nome de função/view por
`CREATE [OR REPLACE] FUNCTION|VIEW`): **91 das 261 e 20 das 45 do núcleo** fazem isso (27 e 10
acopladas ao snapshot). É a oitava da família "o HARNESS mente" ([money-path.md](../agent/money-path.md));
a morte é o sintoma barulhento, e o verde que mede corpo velho é o silencioso. Não erradicada aqui:
a heurística tem falso positivo (redefinição semanticamente igual, migration aplicada só pela tabela)
e cada site pede leitura.

## Lições

- **O matador de prova fora do CI não toca a prova.** 9 das 12 morreram por re-dump de DR — commit
  que ninguém associaria a elas. Revisar o diff do PR não acha a morte; só executar acha.
- **Morrer no seed é morrer antes do 1º assert:** 2 das 8 mortas passaram pelo setup inteiro e
  caíram na hora de semear o cenário. "O schema subiu" não é sinal de prova viva.
- **Uma prova pode nascer morta na `main`** (`whatsapp-proposta`): rodada no branch, mergeada sobre
  um snapshot que o branch não tinha.
- **Bisect por "saiu ≠0" fabrica matador.** A `melhorias-rpcs` morreu duas vezes (07-21 e 08-28, com
  assinaturas diferentes); o juiz tem de ser a assinatura exata, e a ponta boa tem de ser MEDIDA boa.
- **"Saiu 1" também é o que o SEMÁFORO devolve quando desiste.** Juiz de falsificação que aceita
  qualquer exit≠0 aprova a sabotagem que nem chegou a ser julgada — aqui, o `heavy` estourando a fila.
- **Sabotagem que não aplica tem de falhar com nome próprio.** Rodar o juiz sobre o código íntegro
  imprime "FALHA … exit=0 (esperado 1)" — que se lê como furo no gate, e ninguém investiga o que
  parece conhecido.

## A lista inteira — as 248 verdes

`<prova>` = `db/test-<prova>.sh`; logs em `logs/provas-db-mortas/` do worktree da varredura.

`a2-cmc-view` · `acoes-execucoes` · `alerta-pedido-minimo` · `analytics-outbox` · `analytics-outbox-perda` · `analytics-outbox-trigger` · `aplicar-snapshot-pendente` · `apply-score-updates-shs` · `aprovar-pedido-guard` · `assoc-escritor-unico` · `assoc-rules-segmento` · `atp-gate-pedido-fase2` · `atp-reconciliacao-fase3` · `atp-reserva-estoque-fase1` · `atp-reserva-estoque-fase1-1` · `audit-anon-dml-bypass` · `audit-claude-ro-hardening` · `audit-deriva-corpo-prod` · `audit-grants-tabelas-fechadas` · `audit-rls-prod` · `authz-cap-compras-escrever` · `authz-cap-compras-ler-alertas-fu4h` · `authz-cap-compras-ler-pos-candidatos` · `authz-capability-matrix` · `authz-custo-fu4f-fase1` · `authz-custo-fu4f-fase2` · `authz-custo-fu4f-fase2-regua` · `authz-custo-fu4f-fase3-ranking` · `authz-custo-fu4f-fase3-recommend` · `authz-custo-fu4f-fase3-scrub` · `authz-estimar-estoque-omie` · `authz-fecho-execute-registrado` · `authz-pedido-compra-item` · `authz-preco-omie-products` · `authz-private-execute-fecho` · `authz-reescrita-falsificacao` · `authz-sales-orders-split-escrita` · `auto-aprovacao-piloto` · `auto-aprovacao-v2` · `b-cleanup-dups-oben` · `b-renamespace-orfaos` · `backfill_kb_documents_product_code` · `calculate-scores-lease` · `cancelamento-pos-disparo` · `cap-carteira-escrever-master-only` · `captura-authz-gate-custo` · `captura-corpo-vivo-aplicar-promocoes` · `carteira-margem-faixa-motivo-gate` · `carteira-membership-ledger` · `carteira-rebuild-lease` · `carteira-saude-eligible-efeito` · `carteira-vendedor-oben-account-safe` · `carteira-visivel-eligible` · `ciclo-registro` · `city-norm-paridade` · `claim-full-sync` · `claim-nfe-efetivacao-lock` · `claim-nfe-efetivacao-lock-grants` · `claude-ro-reconciliacao` · `cleanup-orphan-score-carteira-delete` · `cockpit-preco` · `cold-start-parametros` · `comment-honesto-margem-faixa` · `criar-pedidos-com-itens` · `crm-carteira` · `customer-metrics-viewgate` · `data-health-carteira-identidade` · `data-health-customer-metrics` · `data-health-custos-proveniencia` · `data-health-estoque-fonte-dado` · `data-health-pedidos-compra` · `data-health-sync-state-saude` · `data-health-vendas-cadastros-proof` · `data-health-watchdog-reemissao` · `defasagem` · `deploy-atestacoes` · `deploy-sonda-cron` · `drop-omie-cliente-upsert-mapping` · `drop-reprocessar-sku-items` · `em-transito-erro-terminal` · `embalagem-auto-cadastro-wp` · `embalagem-motor` · `endividamento-money-path` · `envio-portal-claim-ids` · `exclusao-outlier-removida` · `expirar-planos-taticos` · `farmer-assoc-rules-safeupdate` · `farmer-association-rules-atomica` · `farmer-cobertura-custo` · `farmer-config-limiar-faixa` · `farmer-desfecho` · `farmer-escopo-carteira` · `farmer-geracao-vigente` · `farmer-head-geracao` · `farmer-margem-server-side` · `farmer-melhor-individual-bulk` · `farmer-scores-colunas-orfas` · `farmer-troca-dono` · `fase0-sales-orders-identity` · `fcs-guard-flagged` · `filas-recalc-rls-master-only` · `fin-antecipacoes` · `fin-balanco-inputs` · `fin-custo-rateio` · `fin-dre-custo-tipo` · `fin-sync-retry-kick-perdido` · `fin-sync-watchdog-retry-sem-efeito` · `fix-aplicar-promocoes` · `fix-enqueue-sinais-owner` · `fixes-codex-711` · `fu4f-fase3-afinidade-reaplica` · `fu4f-fase3-carteira-margem-faixa` · `fu4f-fase3-paridade-ts-sql` · `fu7-callers-orfaos` · `fu7-helpers-schema-privado` · `fu7b-pode-ver-carteira-wrapper` · `gate-estoque-nao-confirmado` · `gatilho-farmer-fase2` · `geocoding-cep` · `get-customer-sales-summary` · `get-ultimos-precos-cliente` · `grupo-comercial` · `grupo-contas-receber` · `hardening-aplicar-promocoes` · `hash-omie-canonico` · `ia-uso-cota` · `import-tint-formulas` · `kb-0c-aprovacao` · `kb-extraction-drafts` · `kb-fundacao-casamento` · `kb-hardening-codex` · `kb-spec-versions` · `kb_catalisador_links` · `leadtime-efetivo-dedup-nfe` · `margem-cliente-helper-compartilhado` · `margin-audit-log-master-pode-ler` · `minimo-forcado` · `motor-fonte-unica` · `net-revoke-publico` · `omie-customer-account-map` · `omie-customer-account-map-fresco` · `omie-identidade-a2-client-to-user` · `omie-identidade-backfill` · `omie-identidade-snapshot` · `oportunidade-erro-terminal` · `order-feed-view` · `outliers-leadtime-stack-efetivo` · `param-auto` · `param-fila-e-fusivel` · `pcp-f1a-destilacao` · `pcp-f1a-m1-staging` · `pcp-f1b-execucao` · `pcp-f1b-m2-corte-multiplo` · `pcp-f2a-custo` · `pcp-parser-dimensoes` · `pedido-item-split-estoque` · `pedidos-programados` · `pedidos-programados-claim` · `po-inexistente-antes-de` · `pos-candidatos-guard-temporal` · `pos-frescor-marcador` · `pot-nid-receb` · `preco-medio-leadtime-efetivo` · `preco-pedido-cmc` · `preco-pedido-cmc-account` · `precos-compra-leadtime-efetivo` · `preflight-dependencia-funcao` · `prime-fundacao` · `profiles-prevent-self-approval` · `promo-forward-buying-min` · `push-vendedora` · `qtde-inteira` · `qtde-inteira-persist` · `qtde-multiplo-embalagem` · `quarentena-omie-clientes` · `radar-contagem-perf` · `radar-fatia3` · `radar-fundacao` · `radar-rls-perf` · `radar-rpcs` · `recencia-colacor-created-at` · `recencia-fonte-trigger-backfill` · `recencia-mv-order-date-kpi` · `recommend-cluster-agregado` · `recompute-leadtime-derivado` · `reconcile-score-owner-from-carteira` · `reconciliar-pedidos-omie` · `refresh-customer-metrics-automacao` · `refresh-ranking-gate-cron` · `register-carteira-member` · `regua-custo-capital-money-path` · `regua-preco` · `regua-preco-customer360` · `remove-trigger-auto-super-admin` · `remover-itens-pedido-guard` · `reposicao-consolidacao-demanda` · `reposicao-depara-auto` · `reposicao-fase2-badge-mv` · `reposicao-pos-candidatos` · `reposicao-publicar-run-completo` · `reposicao-religamento` · `reposicao-rls-initplan` · `reposicao-selo-aprovacao` · `returning-exige-select` · `revoke-nao-dono` · `roteirizador-campo-banco` · `roteirizador-prospects` · `rpc-account-aware` · `rpc-intraday` · `rpc-tactical-plan-posse-segura` · `sayerlack-captura-precos` · `sayerlack-custo-portal-cas` · `secdef-searchpath-oraculo` · `seed-targets-faltantes` · `seg-customer-metrics-viewgate` · `seg-onda1-rls-views-matview` · `seg-onda2e5-revoke-searchpath` · `selfservice-pr00-base-crua` · `selfservice-pr00bis-payload` · `selfservice-pr01-gate` · `selfservice-pr02a-views` · `selfservice-pr03-isolamento` · `sinal_classe_config_check_classe` · `sku-fornecedor-externo-fator-positivo` · `sla-compliance-leadtime-efetivo` · `snapshot-universo-itens` · `sync-state-products-vendas-aposentadoria` · `tactical-idempotencia-janela` · `tactical-plan-idempotencia` · `tactical-plan-rpc-hardening` · `tactical-plans-eligible-fail-closed` · `tactical-plans-rls-split` · `tarefas-guard-comprovacao` · `tarefas-leitura-instancia` · `tarefas-matcher-enum` · `telemetria-probes` · `teto-cobertura-motor` · `tick-auto-aprovacao-corrida` · `tool-spec-custom-option` · `trava-credito-fase2` · `v-titulo-baixas-otica-canonica` · `v_grupo_contatos_fresca` · `venda-perdida-rls` · `vendas_sync_cursor` · `vendas_sync_semear_janela` · `views-anon-invoker-literal` · `watchdog-novas-actions` · `whatsapp-pendentes`

## O que ficou de fora, com dono

Reconciliado no fecho (2026-09-30) com a regra de chips do #2651 — no máximo UM, e de continuação:

- ✅ **Fatia 1 — data-health** (2026-09-30): `familia-ausente` e `carteira-rebuild` revividas pelo
  `data-health-vivo.sh` e no núcleo; `familia-ausente-lista-email` fundida na primeira. Detalhe,
  falsificação e achados em [provas-data-health-revividas.md](provas-data-health-revividas.md).
- ✅ **Fatia 2a — canal** (2026-09-30): `whatsapp-hsm` e `-proposta` revividas pela lib nova
  `db/lib/corpo-vivo.sh` (snapshot + ACL MEDIDO em prod + cadeia dinâmica) e no núcleo. A `-funil`
  revivida fica VERMELHA contra o ACL de prod — achou o funil do canal dando `permission denied` para
  todo staff (coluna nova não herda o GRANT por coluna) — e entra no núcleo quando o conserto (1 GRANT,
  decisão do founder) chegar a prod. Detalhe em [provas-canal-revividas.md](provas-canal-revividas.md).
- ✅ **Fatia 2b — carteira** (2026-10-01): `melhorias-rpcs` e `fornecedores-classificacao` revividas pela
  `db/lib/corpo-vivo.sh` e no núcleo (md5 13/13 = prod). A morte de fornecedores foi medida executando: o
  gatilho da carteira cria o score de farmer, e o seed o reinseria. Detalhe, falsificação e revisão em
  [provas-carteira-revividas.md](provas-carteira-revividas.md).
- 📌 **Fatia 3 — money-path** (`reposicao-demanda-insumos-bom`, `preco-tier`): a partir de 03/10,
  quando a cota do Codex reabre, ou antes por Caminho B com `sem-codex:` no corpo.
- 📌 **O sensor** — decisão de custo do founder (as opções A e C, acima). Sem ela, nada de A é
  implementado; a C tem custo ~0 e pode entrar junto de qualquer fatia.
