# Giro de corante (WP) → política de estoque por corante — Fase 1

> **Status:** rascunho revisado (revisor-construtor + Codex, §12), aguardando aprovação do founder.
> **Domínio:** reposição (money-path) × tintométrico. Ler antes: `docs/agent/reposicao.md`, `docs/agent/money-path.md`, `docs/agent/tintometrico.md`, `docs/agent/database.md` §1/§4, `docs/historico/ci-testes-edge-deno.md`.
> **Marcação:** _(founder)_ = decidido pelo Lucas nesta conversa · _(minha)_ = decisão do autor, revisável · _(medido)_ = psql-ro em prod, 2026-10-27.

## 1. Intenção e porquê

A loja tinge tinta na máquina (Dnaxis). Cada um dos 14 concentrados **WP** fica num canister de ~2,3 L dentro da máquina. Quando o canister esvazia, alguém abre uma lata fechada (QT 0,81 L ou GL 3,24 L, compradas da Sayerlack) e despeja nele.

O Lucas quer que o **giro real de cada corante** vire **política de estoque por corante** _(founder)_:

- gira pouco → não manter lata fechada parada (vence; validade de 1 ano), confiar no canister;
- gira muito pouco → nem encher o canister;
- gira rápido → lata fechada de reserva.

Hoje isso não dá para decidir com dado, porque **o consumo da máquina não chega ao app de forma confiável**. A baixa da lata no Omie sai de três jeitos _(founder)_: venda a cliente que não comprou WP (o preço de outro item vai para a linha do concentrado), NF de uso e consumo, ou perda. A "demanda" de WP que o motor vê é parcial (perda nem passa pelo histórico de vendas), aos solavancos (data do lançamento, não da dosagem) e misturada a clientes reais. A fonte verdadeira é o SayerSystem: **`vendas_item`** registra cada dosagem com corantes e quantidades _(founder: a loja dosa pela Dnaxis)_.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos (Fase 1 — esta entrega)** _(founder: fasagem aceita)_
1. Coletar `vendas_item` pelo `sayersync`, incremental e com **cobertura provada**, e gravar o **consumo por corante por dosagem** numa tabela durável.
2. Calcular, por WP: consumo diário, ponto de pedido em ml, faixa, regra de pedido, estoque fechado recomendado e **excesso** do estoque fechado atual (L e R$).
3. Mostrar isso numa aba **"Corantes"** na tela de baixo giro, ao lado da demanda que o motor usa hoje (Omie), com frescor e confiança.

**Não-objetivos**
- Mudar o motor de compra ou `sku_parametros` — é a **Fase 2** (§11), que só entra com sinal desta.
- Linha ACAB10 PU (`WFO.6506.*`, sem ponte com o Omie) _(minha)_.
- Popular `tint_vendas`/`tint_vendas_itens` (vazias, FKs para fórmula/SKU; o giro não precisa) _(minha)_.
- Medir ou estimar o nível do canister, registrar abastecimento (sem fonte legível; Santint consultada).
- Corrigir a prática de lançamento da baixa no Omie; separar a venda externa legítima de WP (residual, ~5 linhas/ano _(medido)_, indistinguível da disfarçada).

**Anti-objetivos (fracasso mesmo "funcionando")**
- Consumo **zero** para corante cujo dado **não chegou** (ausente ≠ zero).
- Contar a mesma dosagem duas vezes (reenvio, re-scan, margem do HWM, edição na fonte).
- Guardar ou expor o nome do cliente do balcão — inclusive em log de erro.
- Falha da entidade nova derrubar o sync de catálogo/fórmulas em produção.
- Recomendação que gera ruptura previsível ou reserva que vence por construção.

## 3. Fatos medidos (prod, 2026-10-27)

- `tint_staging_preparacoes`, `tint_staging_preparacao_itens`, `tint_vendas`, `tint_vendas_itens`: **0 linhas**. `/preparations` nunca foi alimentado.
- **Uma loja só:** `tint_sync_runs` tem um único par `oben`/`M01` (132 mil runs).
- **Ponte corante → SKU:** `tint_corantes` (`oben`) tem os 14 WP com `id_corante_sayersystem` **numérico** (1–16, sem 6/7), `omie_product_id` → SKU **QT** do WP, e `peso_especifico` (1,04–1,95). `volume_total_ml = 810` é a lata QT, não o canister. Os 12 `WFO.6506.*` estão no cadastro (ids 154–165) sem `omie_product_id`.
- Os 28 SKUs WP (14 grupos QT+GL) estão em `sku_parametros` OBEN. LT 7–10 d.u.; o QT de WP06/42/71/88 não tem LT.
- Demanda do motor para WP: 110 de ~116 linhas de NF no ano vão para os nomes de faturamento (Josés/Lucas) — confirma o §1.
- **Linha de base do estoque físico fechado** (L, `sku_estoque_atual` OBEN, QT+GL, sync 2026-10-27 21:53 SP) — usada no §11:

  | WP | L | WP | L | WP | L |
  |---|---|---|---|---|---|
  | WP01 | 7,11 | WP06 | 2,43 | WP53 | 1,43 |
  | WP02 | 2,43 | WP07 | 0,81 | WP69 | 3,05 |
  | WP03 | 3,67 | WP08 | 5,48 | WP71 | 0,00 |
  | WP04 | 3,24 | WP12 | 7,91 | WP87 | 8,34 |
  | WP42 | 1,62 | | | WP88 | 0,00 |

- Sem histórico de estoque físico (`sku_estoque_atual`/`inventory_position` são snapshot). Recebimentos em `nfe_recebimento_itens`.
- Staging do tint: append-only por run, sem UNIQUE; a poda versionada não inclui as tabelas de preparação.

## 4. Parâmetros do founder

| Parâmetro | Valor | Origem |
|---|---|---|
| Validade (`V`) | 365 dias, limiar **mole** (usam vencido se líquido); não há data em lugar nenhum | founder |
| Capacidade do canister (`C`) | 2.300 ml nos 14 WP **a confirmar** — um canister mostrou `CanCapacity=400` no Color Link; o Lucas confere | founder |
| Lead time | o que o motor já usa para o WP (Sayerlack); não tabelar | founder |
| Fonte do consumo | `vendas_item` **substitui** a demanda Omie dos WP (na Fase 2); nunca soma | founder |

## 5. Modelo de decisão

### 5.1 O evento que governa: abrir uma lata

Ninguém sabe o nível do canister, mas todo mundo vê **o momento de abrir uma lata** (o canister esvaziou). A política inteira é dita nesse momento, sem nível _(minha, após o P0 do Codex: a versão anterior descontava um canister cheio que nunca existe na hora do pedido)_. Ao abrir, a posição é: `u` ml recém-despejados + latas fechadas restantes + o que já está a caminho.

- `u` = volume de uma recarga = **810 ml** (QT), limitado a `C` _(minha: corante de giro baixo/médio se compra e se despeja em QT; supõe que o resíduo do canister na hora do alarme é ~0, conservador)_.
- `H` = horizonte de cálculo = **180 dias corridos**, o **mesmo** para todas as grandezas abaixo _(minha: evita o conflito de horizontes 90×365 apontado pelo Codex)_.
- `d` = consumo médio diário (ml/dia) = Σ `qtd_ml` nos dias **cobertos** do horizonte ÷ nº de dias cobertos (§5.3).
- `LTc` = lead time em **dias corridos** = `n + 2·⌈n/5⌉`, com `n = ⌈max(LT médio, LT P95)⌉` em dias úteis do **SKU âncora** (o que o motor usa). Ex.: 7 d.u. → 11 corridos (cobre o fim de semana inteiro; o ×7/5 dava 9,8). Sem LT no QT → LT do GL do mesmo WP → mediana dos WP com LT (mesmo fornecedor), marcado _(founder: "você já sabe qual é o tempo")_.
- `s` = **ponto de pedido em ml** = consumo protegido no lead time = `max( d·LTc , P90 das somas em janelas deslizantes de LTc dias , maior dosagem única do corante )`, tudo dentro de `H`. Os dois pisos impedem `s = 0` em corante intermitente (P0 do Codex: com 92% das janelas zeradas, o P90 sozinho dava zero).

### 5.2 Faixas (avaliadas nesta ordem; a primeira que casa vence)

| # | Faixa | Condição | Regra mostrada na tela |
|---|---|---|---|
| 1 | **Sem recomendação** | dado não fresco, cobertura < 60 dias, `C` não confirmada, LT sem fonte, ou dosagens sem ponte acima do limite (§5.3) | "—" com o motivo. Nunca zero, nunca faixa. |
| 2 | **Parado** | `d = 0` com cobertura completa de `H`, ou uma recarga leva mais de um ano: `u/d > V` | **Não manter lata fechada; avaliar tirar a cor da máquina / sob encomenda.** |
| 3 | **Gira muito pouco** | a lata de reserva venceria: `2u/d − LTc > V` | **Nenhuma lata fechada.** Ao abrir a última, não há reserva: pedir 1 QT quando o alarme tocar e aceitar até `LTc` dias sem a cor. Recarregar sempre com QT. |
| 4 | **Gira devagar** | `s ≤ u` | **No máximo 1 lata fechada.** Pedir 1 QT **ao abrir a última** (a recarga cobre o lead time). |
| 5 | **Gira rápido** | `s > u` | Ponto de pedido do fechado `k = ⌈(s − u)/u⌉` latas QT (ou o equivalente em GL): pedir quando, ao abrir uma lata, sobrarem `k` ou menos fechadas (contando o que já está a caminho). |

A condição da faixa 3 é a idade da lata de reserva quando acaba: ela chega `LTc` dias depois de abrir a anterior, espera a recarga atual acabar (`u/d`) e é consumida em mais `u/d`. Na faixa 5, `s > u` implica `d > u/LTc` (≥ ~58 ml/dia para 14 dias), e a lata gira em semanas: não vence por construção.

**Excesso** = estoque fechado atual − teto da faixa (faixa 2/3: 0 · faixa 4: 1 QT = 0,81 L · faixa 5: `(k+1)·u`), quando positivo. **Capital parado** = excesso (L) × `cmc` do QT ÷ 0,81 (custo por litro, vale para QT e GL); `cmc` ausente → "—".

**Mudança de regime:** se `d` dos últimos 60 dias difere de `d(H)` por mais de 2×, a linha leva o aviso "giro mudando" (advisory; a faixa segue `H`).

### 5.3 Ausente ≠ zero: cobertura, frescor e confiança

A tabela de fatos só tem linha quando houve dosagem, então "dia sem linha" só vale zero se o feed **provou** que consultou aquele dia _(minha, após Codex P1 e revisor)_:

- O conector envia a cada ciclo da entidade `vendas_item` um **manifesto de extração**, **inclusive quando o delta vem vazio**: intervalo consultado (`consultado_ate` = relógio da origem no fim da extração), nº de lotes, nº de linhas. A cobertura da loja só avança quando **todos os lotes** daquela extração foram confirmados **e a promoção concluiu** (o ACK da edge hoje confirma enfileiramento, não promoção).
- Um dia é **coberto** se está entre a primeira dosagem da fonte (registrada no backfill) e a fronteira de cobertura promovida. Dia coberto sem linha = zero legítimo.
- **Fresco** = a fronteira de cobertura tem menos de **4 dias corridos** _(minha: o servidor da loja desliga ~17h15 e não roda no fim de semana; 48 h corridas acenderiam "desatualizado" toda segunda-feira)_. Parado ≥ 4 dias → a tela mostra o último cálculo bom com "desatualizado desde …".
- **Confiança baixa** se a cobertura em `H` for < 180 dias (≥ 60 ainda recomenda; < 60 cai na faixa 1).
- **Dosagens sem ponte** (corante que não existe em `tint_corantes`) no horizonte acima de 1% do volume → faixa 1 para todos os WP (não dá para saber de qual WP é). O PU (`WFO.6506.*`) resolve no cadastro e fica fora dos WP legitimamente.
- Dosagem cancelada na fonte **continua contando** se foi executada (critério 5 do passo 0 prova que a linha nasce na dosagem).
- Dosagem gravada na fonte com data anterior à margem do HWM só entra no próximo re-scan: risco residual documentado (§9).

## 6. Arquitetura — passo 0 + quatro peças

### Passo 0 — Prova da fonte (pré-requisito da peça 1; precisa do Lucas)

O mapping atual de `vendas`/`vendas_item` (`connector/sayersync/mapping.go:309-322`) usa nomes inventados e shape filho (`id_venda/id_corante/qtd_ml`); `data_dosagem` não aparece no repo. O Lucas roda no SayerSystem, **sem a coluna `cliente`**:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'vendas_item' ORDER BY ordinal_position;

SELECT count(*), min(data_dosagem), max(data_dosagem) FROM vendas_item;

-- 30 linhas recentes que usem WP07, WP69 ou WP02 (peso específico 1,95 · 1,85 · 1,58),
-- colunas listadas explicitamente, SEM cliente
SELECT <todas as colunas exceto cliente> FROM vendas_item
WHERE <algum coranteN em (ids de WP07, WP69, WP02)>
ORDER BY data_dosagem DESC LIMIT 30;
```

Critérios de aceite — a peça 1 só começa com os cinco respondidos; qualquer um ambíguo mantém a entidade desligada:
1. **Chave única** de cada dosagem e se a linha muda depois de gravada (existe coluna de atualização?).
2. **Formato de `coranteN`**: id numérico (= `tint_corantes.id_corante_sayersystem`) ou código (`WP01`).
3. **Unidade de `qtdN`** (ml ou g) e se é o **total dosado** naquela preparação. Prova com as linhas de corante **denso** (densidade 1 não separa g de ml): cruzar com a fórmula da mesma cor/embalagem em `tint_formula_itens` e ver qual hipótese bate (`qtd` = fórmula em ml, ou = fórmula × `peso_especifico`).
4. **Volume e profundidade** do histórico (dimensiona o backfill).
5. **A linha nasce na dosagem executada**, não no orçamento/pedido (coluna de status/cancelamento? linha sem `data_dosagem`?).

### Peça 1 — Conector `sayersync` (Go)

- Nova entidade `vendas_item`: `data_atualizacao` lógico ← `data_dosagem` físico; slots `corante1..6`/`qtd1..6` no shape flat. **Corrigir a fronteira lógico/físico do `ExtractDelta`**: hoje ele procura o nome físico num mapa montado com nomes lógicos (`pg.go:112` × `pg.go:214`), então `maxDA` ficaria zerado e o HWM nunca avançaria. Teste pelo caminho real de extração, não só com `advanceHWM` sobre timestamp fabricado.
- Reusar a agregação flat (`aggregateFlatFormulaItems`, `pg.go:268`) para `itens[]`. **Integridade por preparação:** slot com corante sem quantidade (ou o inverso) ou corante não resolvido → a preparação inteira é rejeitada e contada, nunca enviada pela metade (o detector atual aceita shape parcial, `mapping.go:510`).
- **Identidade:** enviar o **id bruto** da fonte **e** o código, separados. A resolução na promoção é pelo id bruto contra `id_corante_sayersystem` _(minha: `traduzItensCorante` troca o id numérico pelo código e quebraria a ponte numérica)_.
- **Unidade canônica em ml no conector** (se a fonte for g: `ml = g ÷ peso_especifico`, e o peso específico vai junto no payload para auditoria).
- Payload **sem `cliente`** _(minha, LGPD: minimização — o giro é agregado por corante×dia; `cliente` é texto livre do balcão e pode ser pessoa física)_.
- `syncPreparacoes` próprio: envia para `/preparations` e **envia o manifesto mesmo com delta vazio** (hoje `syncSimpleEntity` retorna sem enviar nada, `sync.go:847`). HWM em `st.HWM["vendas_item"]`, só com lote confirmado.
- **Piso de extração da entidade:** backfill e re-scan nunca leem antes de hoje − 400 dias; o re-scan semanal da entidade cobre pelo menos os últimos 35 dias. O mecanismo é do construtor, sem mudar a semântica do re-scan das outras entidades.
- **Isolamento de verdade:** validação e habilitação **por entidade**. Hoje qualquer coluna `Required` ausente torna o diff global inválido e o `RunCycle` aborta antes de qualquer entidade (`mapping.go:428`, `sync.go:599`). As colunas de `vendas_item` não podem entrar nesse conjunto global: falha fechada só para preparações. Teste entrando por `RunCycle` e pela descoberta de schema.
- Versão nova do binário (semver) + `go test ./...`.

### Peça 2 — Banco (migration nova; nunca editar migration existente)

- **`tint_consumo_corante`** _(minha: fato dedicado por item de dosagem — auditável e re-agregável)_: `account`, `store_code`, `preparacao_id`, `ordem`, `id_corante_origem` (bruto), `codigo_corante_origem`, `tint_corante_id` (FK, NULL quando não resolve — linha mantida e contada), `qtd_ml`, `data_dosagem`, `sync_run_id`, `run_criado_em`. `UNIQUE (account, store_code, preparacao_id, ordem)`. `CHECK` de faixa em `qtd_ml` (finito, > 0, teto medido no passo 0 — `money-path.md` §2). RLS ligada; SELECT para staff; sem policy de escrita.
- **`tint_consumo_cobertura`**: por `(account, store_code)`, a primeira dosagem da fonte, a fronteira promovida (`coberto_ate`), o último manifesto e o run que a avançou. Só a promoção escreve.
- **Colunas em `tint_corantes`:** `capacidade_canister_ml` (NULL = desconhecida) e `capacidade_confirmada boolean NOT NULL DEFAULT false`. Semear 2.300 com `capacidade_confirmada = false` nos 14 WP; o Lucas confirma depois de conferir o canister do "400" _(Codex P1: capacidade duvidosa não pode autorizar recomendação)_.
- **Promoção `tint_promote_preparacoes(run_id)`**: SECURITY DEFINER, `search_path` fixo, `REVOKE` de `PUBLIC`, `anon` e `authenticated`, uma transação por run. Para cada preparação do run: **substitui o conjunto inteiro de itens** (apaga o que não veio, upsert do que veio), **só se o run for mais novo** que o último aplicado àquela preparação. Assim a edição na fonte converge, e reprocessar um run antigo não restaura o valor velho (Codex P1). Ao fim, avança `tint_consumo_cobertura` pelo manifesto do run, se todos os lotes da extração estiverem promovidos.
- Plugada na fila existente (`concluirEEnfileirar` → `tint_promocao_tick` → despacho por tipo de run). Se o despacho exigir `CREATE OR REPLACE` de `tint_promote_sync_run`/`tint_promocao_tick` (funções quentes): pré-flight `pg_get_functiondef` de **prod**, partindo da definição viva.
- **Retenção do staging de preparação por estado de promoção** (nunca por idade sozinha): só sai o que já foi promovido.
- **Views** (`security_invoker = on`): `v_corante_consumo_diario` (série diária por WP **só nos dias cobertos**, com zeros) e `v_corante_giro` (por WP: `d`, `s`, `LTc` e sua fonte, `u`, faixa, regra, `k`, teto, excesso L e R$, confiança, frescor, motivo). Relógio pelas regras de fuso de `money-path.md`. A view recusa com estado explícito se aparecer mais de uma loja no account (hoje 1).

### Peça 3 — Edge `tint-sync-agent`

- `/preparations` aceita o manifesto de extração e conclui por `concluirEEnfileirar`.
- **Sanitização na entrada**, antes de validar, gravar ou logar: remove `cliente` (e qualquer chave fora da allowlist do payload). Hoje a validação chama `logError` com o objeto inteiro, que vai para `tint_sync_errors.raw_data` (`index.ts:698`, `:368`).
- Escritas pelo contrato `escritaCritica` (`money-path.md` §11); lote de inserts no lugar do laço linha a linha.
- `VERSAO` bumpada; os seis gates de edge (§7).

### Peça 4 — App (aba "Corantes" no baixo giro)

- Nova aba em `src/components/reposicao/baixoGiro/`, só na empresa OBEN, lendo `v_corante_giro` (14 linhas) pela leitura canônica.
- Colunas: WP · faixa · regra de pedido (texto da §5.2) · consumo (ml/dia) · demanda do motor hoje (Omie, L/dia) lado a lado · `s` (ml) · LT (dias corridos e fonte) · estoque fechado (L) · teto · excesso (L e R$) · confiança · frescor · motivo quando "—".
- Estados de leitura por `estadoDeLeitura` + `<AvisoLeituraFalhou>`; nada de `?? 0`.
- Ação **manual** pelos controles existentes (manter em estoque / mínimo forçado). A aba não escreve.
- Sensor de uso no padrão de `docs/historico/fase-sem-sinal.md` (registro durável, não só `track()` — o PostHog é bloqueado no founder).
- Arquivos novos registrados em `src/lib/modulos/manifesto.ts`.

## 7. Prova da entrega

- **Passo 0** respondido e registrado no PR (sem dado de cliente).
- **Conector:** `go test ./...` — mapeamento de `vendas_item` (slots, unidade g→ml com corante denso, id bruto + código, ausência de `cliente`); HWM avançando **pelo caminho real** de extração; manifesto enviado com delta vazio; preparação com slot inválido rejeitada inteira; isolamento por `RunCycle` (schema de `vendas_item` quebrado ≠ catálogo parado); piso de 400 dias. Sabotagem de **valor de predicado** (o código compila).
- **Banco** (`prove-sql-money-path`, PG17 executando): mesmo run duas vezes = mesma **soma** e mesmo conteúdo; edição na fonte (ordem trocada) converge sem dobrar; run antigo reprocessado depois do novo não regride; independência da ordem de processamento; corante sem ponte mantido com FK NULL e contado; cobertura só avança com todos os lotes promovidos; `CHECK` recusando 0/NaN/Infinity/acima do teto com `23514`; `REVOKE` por `has_function_privilege` nas pontas; RLS sob `SET ROLE authenticated`; faixas nas bordas (`s = u`, `2u/d − LTc = V`, `u/d = V`, `d = 0` coberto vs dia não coberto, P90 = 0 com consumo recorrente, capacidade não confirmada, 2 lojas). Falsificação com controle verde na mesma invocação, `LC_ALL=C` e `pt_BR.UTF-8`.
- **Edge:** `test:edges`, `edges:typecheck`, `edges:sintaxe`, `bun run test`, `sonda:bump`, `sonda:fingerprint` (`-- --write`); `cliente` ausente da linha, do `raw_data` **e** de `tint_sync_errors`.
- **App:** `heavy bun run test`, `bun lint`, `bun run typecheck`; helper puro de faixa (mesmos casos de borda do SQL, ou a view como única fonte); erro de leitura ≠ "sem consumo".
- **Codex** no design (feito, §12) e antes do merge.

## 8. Deploy — camadas e quem faz

Ordem obrigatória: **migration → edge → conector → Publish.** A edge vai antes do conector para que nenhum envio caia numa edge que grava `cliente` ou não promove.

| Camada | Quem | Como verificar |
|---|---|---|
| Migration | sessão no envelope (idempotente + transacional + pós-condição); senão Lucas no SQL Editor | psql-ro: tabelas, colunas, seed, ACL da função, views |
| Edge `tint-sync-agent` | Lucas (chat Lovable) | `bun run pendencias:deploy` + sonda |
| Conector | `release.sh` publica o manifesto; a loja se auto-atualiza no ciclo diário (`update.go`) | heartbeat com a versão; **backfill completo** (cobertura desde a primeira dosagem) e promoção concluída — não basta a primeira linha |
| Capacidade dos canisters | Lucas confere; `UPDATE` de `capacidade_confirmada` | psql-ro |
| Publish | Lucas | `lovable-deploy-verify` |

## 9. Riscos e limitações conhecidas

- **Unidade de `qtdN` errada** multiplica o consumo por até 1,95. Mitigação: critério 3 do passo 0 com corante denso; fail-closed.
- **Backfill grande** no 1º ciclo: piso de 400 dias, `validateBatchSize`, deadline da edge; HWM e cobertura só com lote confirmado e promovido.
- **Dosagem gravada "no passado"** além da margem do HWM fica fora até o re-scan (≤ 7 dias), com consumo levemente subestimado nesse intervalo.
- **Resíduo do canister na hora do alarme** suposto ~0 (conservador: superestima a necessidade de reserva por no máximo o resíduo).
- **Venda externa legítima de lata WP** fica fora do consumo dosado (residual).
- **A demanda do motor para WP segue poluída** até a Fase 2; a aba a mostra ao lado do consumo dosado para tornar o desvio visível.

## 10. Deixado ao construtor

- Despacho exato da promoção na fila (ramo no `tint_promote_sync_run` vs no tick), com o pré-flight de prod.
- Mecanismo do piso de 400 dias e da janela de 35 dias do re-scan, sem mudar as outras entidades.
- Forma do manifesto de extração no payload/endpoint.
- Teto do `CHECK` de `qtd_ml` (máximo real medido no passo 0).
- Onde guardar `V = 365`, `u = 810`, `H = 180`, limite de 1% sem ponte e 4 dias de frescor (constantes nomeadas únicas ou `company_config`), sem literal espalhado.
- Layout da aba (design system v3: `EmptyState`, `PageSkeleton`, `text-status-*`).

## 11. Fase 2 (fora desta entrega) — critério de entrada

A Fase 2 faz o motor usar o consumo dosado como demanda dos WP (substituindo a do Omie) e aplicar a regra por faixa. Só começa com **sinal** desta fase:

1. Cobertura contínua desde a linha de base (2026-10-27) por **≥ 90 dias**, com a fronteira nunca parada por mais de 4 dias corridos.
2. **Reconciliação dosado × retirado**, no recorte [linha de base, data da medição]:
   `retirado(WP) = Σ recebido (nfe_recebimento_itens, L) − (físico na data − linha de base do §3)`.
   - Elegíveis: WP com `retirado ≥ 2 L`; exige **≥ 5 WP elegíveis** (senão o critério não foi medido, não "passou").
   - Por WP elegível: `|dosado − retirado| ≤ C + 0,81 L` **e** `≤ 25%` do retirado.
   - No agregado: `Σ dosado ÷ Σ retirado` entre 0,85 e 1,15.
   - A diferença conhecida (venda externa, perda real, variação do canister) cabe nas tolerâncias; fora delas, a coleta está furada.
   - A consulta vai no PR da Fase 1 com **falsificações obrigatórias**: feed zerado (dosado = 0) e unidade errada (dosado × 1,95) têm de reprovar.
3. ≥ 1 sinal positivo de uso da aba, com denominador.

## 12. Revisões incorporadas

**Revisor-construtor** (subagente sem o contexto da conversa) — 5 perguntas:
1. Loja × empresa → respondida pelo dado: uma loja (`oben`/`M01`); a view recusa se aparecer outra.
2. Cobertura "dia sem linha = zero" → manifesto de extração + `tint_consumo_cobertura` (§5.3, peça 2).
3. 48 h × calendário da loja → frescor de 4 dias corridos sobre a fronteira de cobertura.
4. Re-scan reenviando tudo → piso de 400 dias e janela de 35 dias no re-scan da entidade.
5. LT ausente no QT → cadeia QT → GL do mesmo WP → mediana dos WP (fala do founder sobre o LT dos WP).

**Codex** (`gpt-6-astra`, reasoning high, 229 s; parecer em `logs/giro-corante/codex-design.out`):
- P0 `Q − C` com canister cheio inexistente → política reescrita no evento "abrir uma lata" (§5.1–5.2).
- P0 P90 = 0 → pisos `d·LTc` e maior dosagem única em `s`.
- P1 faixas sobrepostas e horizontes misturados → horizonte único `H`, ordem de avaliação, faixa "parado" para lote mínimo > consumo anual.
- P1 cobertura sem protocolo; ACK ≠ promoção → manifesto + cobertura avançada na promoção.
- P1 fallback < 90 dias com denominador errado → denominador = dias cobertos; < 60 dias sem recomendação.
- P1 ×7/5 e LT médio → `n + 2·⌈n/5⌉` sobre `max(médio, P95)`.
- P1 gate da Fase 2 aprovava feed zerado e unidade errada → mínimo de elegíveis, tolerância relativa, agregado e falsificações obrigatórias.
- P1 passo 0 fraco → corante denso, critério 5 (dosagem executada), integridade de slot por preparação.
- P1 upsert não converge com edição → substituição do conjunto por preparação, monotônica por run.
- P1 tradução de identidade × ponte numérica → id bruto + código; resolução pelo bruto.
- P1 HWM lógico × físico no `ExtractDelta` → correção + teste pelo caminho real.
- P1 isolamento exige validação por entidade → validação/habilitação por entidade.
- P1 `cliente` no log de erro → sanitização na entrada.
- P1 capacidade duvidosa → `capacidade_confirmada` bloqueia a recomendação.
- P2 poda × promoção → retenção por estado de promoção.
