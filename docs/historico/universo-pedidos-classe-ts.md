# Universo de pedidos: a classe no TypeScript e nas edges

> Metade TS da classe cuja metade SQL está em [universo-pedidos-classe-sql.md](universo-pedidos-classe-sql.md)
> (#2726). Sessão de 2026-10-01, skill `matar-classe`.

## A classe

Ler `public.sales_orders` como VENDA aplicando outro universo que não o da autoridade —
`status NOT IN ('cancelado','rascunho','pendente','orcamento')` + `deleted_at IS NULL`
(`src/lib/farmer/universo-pedidos.ts`, espelho Deno em `supabase/functions/_shared/universo-pedidos.ts`).
No TS a classe tem formas que o SQL não tem: o filtro **depois** da query (com o `.limit()` já
aplicado — a janela encolhe), e a **constante paralela** que copia a lista (`ORDER_STATUS_INVALIDOS`,
`STATUS_INVALIDOS` duas vezes, `STATUS_NAO_FATURAVEL` em src e edge, o literal do audit,
`STATUS_CANCELAMENTO` em caixa alta). Cada cópia nasceu certa para o seu dia e envelheceu sozinha: a
do cockpit dizia espelhar "VERBATIM" a régua do `v_caca`, que o #2726 trocou por baixo dela.

## A medição (psql-ro, 2026-10-01 13:00 UTC)

**Denominador:** 29 `cancelado` (oben, todos com kpi e `omie_pedido_id`; um deles com total de
**R$ 615 mi** — o erro de digitação que já tinha inflado o TTM do cockpit), 1 `orcamento` e 1
`rascunho` (criados pelo app, sem kpi, **sem `order_items`**), 0 `pendente`, 0 apagados. `status` é
NOT NULL; `authenticated` tem SELECT em `status` e `deleted_at` (o filtro no cliente não dá 42501).

**Assinatura × denominador (cru × casado):** 258 linhas mencionam `sales_orders` no código varrido (comentários inclusive);
60 `.from(…'sales_orders')` no grep e **60 no AST** (o teste "cru × casado" exige a igualdade), mais
1 embed real (`sales_orders!inner(…)` no `omie-desconto-backfill`). O resto, lido literal a literal:
mensagens e rótulos de erro (36), tipos `Tables<'sales_orders'>` (4), rótulos de leitura
(`exigirLeitura(…, 'sales_orders')`, 2), uma assinatura realtime que só invalida cache
(`useVendasZone`), e os próprios gates. Os 61 sítios: **4 canônicos · 17 escritas · 1 complemento ·
39 fora** — dos 40 fora (o complemento sem par conta como fora), 22 são de propósito (lookup,
sincronização, sensor) e 18 eram dívida.

**Efeito vivo, no grão e na janela de cada site:**

| Domínio | Efeito medido |
|---|---|
| Dashboard/receita + cockpit | **0** — orçamento/rascunho não têm kpi. Vira vivo no dia em que o app gravar `order_date_kpi` (o passo que o #2730 destrava) |
| Customer 360 "Faturamento 12m" | universo: 19 clientes, +R$ 34,8 mil (máx R$ 7.560, mediana R$ 595), nº de pedidos inflado nos 19. **E o `limit(200)` escondia 55–72% do faturamento 12m dos 3 maiores clientes** (R$ 904.595 aparecia como R$ 248.916) |
| Ligação (preço praticado, munição) | universo efetivo já canônico (pendente = 0), mas filtrado **depois** do `limit`: 11 clientes perdiam ≥1 pedido válido do top-50 do histórico de preço |
| Proposta (cesta enviada por WhatsApp) | **0** (orçamento/rascunho sem itens) — mas a cesta saía de um universo e o preço (`get_whatsapp_proposta_cotacao`, canônico desde #2726) de outro |
| Auditoria de margem | **0** (rascunho sem itens) — o conjunto de exclusão deixava rascunho/pendente contarem como praticado |
| Operacionais | última compra: 1 cliente via cancelado; já-comprou: 19 clientes/29 pedidos cancelados no corte; cores: 3 de 2.191 pares; roteirizador: 1; visit-score: 0 |

Achados fora da classe, decididos junto: `sales_orders.discount` é **0 em 31.678/31.678** (DEFAULT 0)
— a "sensibilidade a desconto" da Inteligência era um 0% fabricado; o roteirizador lia pedidos sem
limit (capa silenciosa de 1.000) e engolia o erro.

## As decisões (founder, 2026-10-01)

- **Customer 360:** KPI numa query própria — universo canônico, janela 12m por `order_date_kpi` (o
  mesmo eixo e universo do tile "90d", que vem do `customer_metrics_mv`), paginada sem teto; a lista
  "Pedidos recentes" (badge de status, vermelho para cancelado) vira feed separado com `deleted_at`;
  erro → "indisponível", nunca R$ 0.
- **Dashboard, cockpit, ligação, proposta, auditoria:** todos canônicos.
- **Operacionais:** os quatro grupos são pergunta de COMPRA — última compra + já-comprou, cores do
  cliente, roteirizador + visit-score, impressão do dia. Os feeds que sobram (admin, brief, sistema,
  atividade, orçamentos, busca) ficam no registro como propósito, com `deleted_at`.
- **Inteligência:** canônico + "indisponível" no lugar do 0%. **Roteirizador:** a capa e o erro
  consertados junto.
- **Codex:** cota em 86% (teto 85%) até 03/10 19:11 → os PRs money-path ficam **DRAFT** até a janela
  reabrir, com desenho (`RÉGUA:`) + adversarial por domínio antes do merge.

## O gate

`src/__tests__/universo-pedidos-ts-gate.test.ts`, com o detector em `src/lib/gates/universo-pedidos-ts.ts`
(AST do compilador TS, padrão do `hoje-utc`) e o registro em `src/lib/gates/universo-pedidos-ts-registro.ts`.

- **G1** — toda leitura fora do par canônico está no registro (arquivo + forma + n).
- **G2** — o registro só encolhe: entrada sem sítio (quitada, sumida ou com a forma mudada) reprova.
- **G3** — feed de propósito tem `.is('deleted_at', null)` ou diz no registro por que não.
- **G4** — a dívida tem teto (18) e cada entrada nomeia o domínio que a quita.
- **G5/G6** — nenhuma cópia da lista (array ou string PostgREST com ≥2 membros da autoridade) fora
  das duas autoridades; o G6 prova no código real que o detector ainda acha as autoridades.
- **Calibração** — fixtures transcritos: o pré-fix real do `useFarmerScoring` (`2025c0808~1`, a
  allowlist que escondia 10.281 pedidos) casa e o pós-fix não; cast, genérico, quebra de linha,
  variável reatribuída, filtro pós-query, embed, complemento com e sem o par.
- **Falsificação** — `bun run falsificar:universo-pedidos-ts [LOCALE]`: 11 sabotagens em arquivos
  reais, no detector, no walker e no registro, cada uma exigindo o vermelho do assert certo E o
  arquivo nomeado; controle verde antes e depois na mesma invocação; `LC_ALL=C` e `pt_BR.UTF-8`.

**Limites declarados:** cadeia que atravessa retorno de função ou parâmetro é julgada pelo que se vê
no site (sai fora → registro, o lado seguro); a variável é seguida por nome no escopo da função, sem
fluxo (filtro num `if` conta como sempre); SQL cru em string não é PostgREST; cópia da lista com UM
membro só (`['CANCELADO']`) não se distingue de vocabulário de outro domínio — havia uma
(`STATUS_CANCELAMENTO`), erradicada na mesma leva.

## As fatias (PRs)

| PR | Domínio | Estado em 2026-10-02 |
|---|---|---|
| #2743 | gate + registro + falsificação | mergeado |
| #2748 | operacionais, feeds, Inteligência, roteirizador | mergeado — falta Publish e o deploy de `visit-score-recalc-client` (sem sonda: o ledger não a enxerga) |
| #2766 | dashboard + cockpit de valor (`fin-valor-cockpit` v1.7) | DRAFT até o Codex |
| #2767 | Customer 360 (faturamento 12m sem teto, sentinela 9999) | DRAFT até o Codex |
| #2768 | ligação (preço praticado, munição) | DRAFT até o Codex |
| #2769 | proposta (cesta enviada ao cliente) | DRAFT até o Codex |
| #2770 | auditoria de margem (`algorithm-a-audit` v1.1) | DRAFT até o Codex |

Os DRAFTs são irmãos sobre o #2748 e mexem no mesmo registro: quem mergear depois resolve o conflito do
`TETO_DIVIDA`/`TETO_CONSTANTES_DIVIDA` como **teto atual − entradas que quita** (o G4 exige igualdade).

Achados fora da classe, registrados nos PRs e não consertados: a lista manual do roteirizador lê
`profiles` sem limit (mostra os primeiros 1.000 de 5.665 clientes); nenhuma zona do cockpit aplica o
recorte de empresa (`companies` está na `queryKey` e não na query).

## Fatia Customer 360 (#2767): o fechamento (2026-10-05)

Assumida pela sessão "Corrigir Faturamento 12m do Customer 360" por decisão do founder. Ela chegou com o
achado **C2** do Codex retroativo do sensor `vendas_empurradas_sem_gemeo` (#2698/#2717): não-venda e
gêmeos push/pull na soma do 12m. Esta fatia já fechava os dois.

**Medido (`psql-ro`, 2026-10-05).** O C2 mediu SEM o teto: 31 linhas de não-venda em 20 clientes,
R$ 615,1 mi, quase tudo de UM pedido importado cancelado de R$ 615.100.434,63. No grão da tela (com o
`limit(200)`) a soma era outra: 30 linhas, 19 clientes, R$ 34.835,70. O cancelado é o 315º pedido do
cliente e ficava FORA do teto: a tela mostrava R$ 152,1–152,5 mil / 200 pedidos (4 empatados no corte), e
o canônico é R$ 367.014,23 / 553. Os 25 recibos de gêmeo (R$ 14.186,56, 15 clientes) entravam na soma
antiga; no eixo `order_date_kpi` eles saem por construção (CHECK `sales_orders_gemeo_e_recibo` e índice
único do #2730: 0 recibos com kpi, 0 pedidos Omie com 2 linhas com kpi). Resíduo do eixo: 0 vendas
empurradas vivas sem gêmeo e sem kpi. Escala: 508 clientes com venda na janela, no máximo 710 pedidos (0
acima de 1.000), 0 subcentavos, e a soma em `Number` bate ao centavo nos 508 (erro máximo 1,34e-7 centavo).

**Codex.** Desenho (gpt-6-astra · max · 478s · 130.688 tokens): 0 P0 / 3 P1 / 2 P2, todos tratados. O
refetch que falha com cache declara a idade (`leituraDaQuery` = `estadoDeLeitura` + `desatualizado`); o
9999 vira "Sem compra no consolidado", com os dois relógios da faixa declarados; e a prova de paginação
ganhou mock fiel (o `range` fatia, capa de 1.000). Código (gpt-6-astra · max · 269s · 101.163 tokens):
0 P0 / 0 P1. Dos P2, o refetch do feed que falhava mudo (inclusive com a lista vazia em cache) foi
consertado, e o controle positivo do R$ 0 entrou. A soma paginada por offset não é um retrato (venda que
entra entre páginas relê a fronteira) e ficou como LIMITE CONHECIDO no hook: só existe acima de 1.000
pedidos do cliente na janela, e o máximo medido é 710. Fora do escopo, preexistente: offline e sem cache,
a página diz "Cliente não encontrado" antes de montar a faixa (`core` em `pending`/`paused`).

**Lições desta fatia.**

- **Um teto esconde nos DOIS sentidos.** O `limit(200)` escondia venda (55–72% nos maiores clientes) e
  escondia também a não-venda mais cara do banco. Tirar o teto sem o filtro de status faria um cliente
  pular para R$ 615 mi: os dois consertos vão JUNTOS. E o retrato de um achado se mede no grão da tela,
  com o corte, senão afirma um número que ninguém viu.
- **R$ formatado em consulta do Testing Library é cego.** O `formatBRL` usa U+00A0, e o normalizador troca
  o `\s+` do NÓ, não o da consulta. `queryByText(formatBRL(0))).toBeNull()` aprovava com R$ 0 na tela; foi
  o positivo vermelho que denunciou. Consulte o R$ como o DOM o expõe, e prove a negativa com uma
  sabotagem que ACENDE o R$ 0.

## Lições

1. **O corte pode ser maior que a classe.** O `limit(200)` do Customer 360 escondia 55–72% do
   faturamento dos maiores clientes — ~30× o efeito do universo errado na mesma query (R$ 1,06 mi escondidos contra R$ 34,8 mil inflados). Medir o site
   no SEU grão e janela, e não só o predicado, é o que achou isso.
2. **Filtro depois do limit é a forma TS da classe**, e ela não aparece como "universo errado": a
   lista já era a certa, só que aplicada a uma janela que já tinha perdido linhas válidas.
3. **O detector achou o próprio registro.** A primeira versão guardava os membros das constantes
   em arrays — que são, eles mesmos, a cópia que o G5 procura. A representação mudou para string; a
   alternativa (excluir o registro do scan) seria um ponto cego com nome.
4. **Vermelho que não diz o arquivo não é marca.** Lista longa no `toEqual([])` sai truncada
   (`[ …(6) ]`); a falsificação pegou isso, e o gate passou a comparar strings.


5. **Mock de cadeia PostgREST é contrato implícito.** Acrescentar `.is('deleted_at', null)` à lista de
   orçamentos derrubou 5 testes de OUTRA feature (`SalesQuotes.accountGuard`/`priceGuard`), cujos mocks não
   tinham `.is` — a query morria antes do `.order()`. O CI pegou. Antes do push, procure os testes que
   mockam a cadeia alterada (pelo arquivo E pela tabela) e rode-os; os testes do próprio domínio não bastam.
6. **Ordem dos métodos na cadeia não é semântica.** No PostgREST, `.not().limit()` e `.limit().not()` viram
   a mesma URL; afirmar "o filtro vem antes do limit" pela ordem das chamadas seria asserção cosmética. O
   defeito era o filtro em MEMÓRIA depois do corte — o teste prende o par NA query e o `limit` como janela
   final (a munição caiu de 16 para 8: o excesso só existia para compensar o refiltro).
7. **A sabotagem tem de ser a regressão REAL, não a remoção da linha.** Tirar o `throw` da zona de vendas
   deixou o teste verde: o `null` quebrava no `for…of` do agregador e a query caía em erro por acidente. A
   sabotagem fiel é a forma antiga — `?? []` engolindo o erro — e essa ficou vermelha.
8. **Camada redundante se mede, não se presume.** A régua em memória da proposta (derivada da autoridade)
   fica verde sob sabotagem: a query já filtra, e o banco não devolve não-venda. Está declarada como defesa
   com a MESMA fonte, e quem trava a query é o gate.
9. **Isolamento de sessão vale também para o worktree que a própria sessão cria.** Um segundo worktree
   para desenvolver em paralelo foi barrado pelo hook (escrita fora do worktree da sessão). Branches da
   mesma sessão andam em sequência — commit antes de trocar —, e o gargalo real era a fila do `heavy`
   (1 slot para ~30 sessões), não a árvore.
