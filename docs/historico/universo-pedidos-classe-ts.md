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

| PR | Domínio | Estado em 2026-10-05 |
|---|---|---|
| #2743 | gate + registro + falsificação | mergeado |
| #2748 | operacionais, feeds, Inteligência, roteirizador | mergeado e publicado (Publish de 05/10); o deploy de `visit-score-recalc-client` (sem sonda) não foi conferido nesta leva |
| #2766 | dashboard + cockpit de valor (`fin-valor-cockpit` v1.7) | mergeado (05/10 17:57Z) — faltam o deploy da edge e o Publish |
| #2767 | Customer 360 (faturamento 12m sem teto, sentinela 9999) | com a sessão "Corrigir Faturamento 12m do Customer 360", que registra o fechamento em seção própria neste arquivo |
| #2768 | ligação (preço praticado, munição) | mergeado e publicado |
| #2769 | proposta (cesta enviada ao cliente) | mergeado e publicado — com a capa de itens (lição 11) |
| #2770 | auditoria de margem (`algorithm-a-audit` v1.1) | mergeado; a edge subiu já como v1.2 (com o #2781), atestada por sonda |
| #2781 | Margem Global (achado da fatia da auditoria — lição 10) | mergeado, publicado; `algorithm-a-audit` v1.2 atestada |

Os DRAFTs são irmãos sobre o #2748 e mexem no mesmo registro: quem mergear depois resolve o conflito do
`TETO_DIVIDA`/`TETO_CONSTANTES_DIVIDA` como **teto atual − entradas que quita** (o G4 exige igualdade).

Achados fora da classe, registrados nos PRs e não consertados: a lista manual do roteirizador lê
`profiles` sem limit (mostra os primeiros 1.000 de 5.665 clientes); nenhuma zona do cockpit aplica o
recorte de empresa (`companies` está na `queryKey` e não na query).

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
10. **A fatia achou um defeito maior que a classe — de novo.** Medindo a auditoria de margem (efeito 0
    do universo), a aba Estratégica somava as 100 linhas mais recentes de `margin_audit_log`, um log que
    ACRESCENTA ~508 linhas por execução semanal, em lotes de 500: a Margem Global mostrava 5–7% da carteira
    auditada (R$ 158.916 contra R$ 2.179.687 na execução de 04/10). Virou o #2781 — a edge carimba UM
    `calculated_at` por execução (v1.2), e a tela soma a última execução INTEIRA (o formato antigo é
    reconstruído pelos lotes de 500 a < 1 s, medido nas 54 transições do histórico) e diz de quando é o
    número e o que o log não garante. "Somar um `.limit()` como se fosse a população" é família própria.
11. **A capa de 1.000 também mora nos ITENS.** A cesta da proposta paginava por pedido, não por item: 8
    clientes passam de 1.000 itens em 365 dias, e os 2 maiores perdiam 53 de 296 e 65 de 283 SKUs da cesta
    enviada. `fetchAllPages` + erro marcado; a falha vira aviso com "Tentar de novo", e o refetch que falha
    não deixa a cesta antiga na tela (o React Query mantém `data` quando a query cai em erro).
12. **Teste verde pela causa errada: o mock sem a telemetria.** O `fetchAllPages` chama `captureException`
    antes de lançar; sem mockar a telemetria, a exceção do PRÓPRIO mock acendia o aviso de falha e o teste
    passava. O adversarial do Codex pegou. Afirme a MARCA do erro (`ehFalhaDePagina` + motivo/fonte/página +
    `cause.code`), nunca só "apareceu o aviso".
13. **A cópia testada não era a executada.** A faturabilidade do Cockpit de Valor tinha duas cópias: a de
    `src/`, com a matriz de testes, e a da edge, a que soma a receita, sem nenhum — sabotar só a edge ficava
    verde. A régua foi para `fin-valor-cockpit/faturabilidade.ts`, testada direto pelo vitest (o arranjo de
    `_shared/janela-pedidos-compra.ts`); a cópia de `src/` saiu, um guardrail prende o corte dos itens a ela
    e o contrato de mutação acompanhou o código. "Espelhado verbatim" num comentário não é teste. E o
    guardrail textual da 1ª versão tinha dois furos que o adversarial mostrou: lia COMENTÁRIOS (a linha
    comentada passava por presente) e não via um 2º filtro por status no handler. Agora lê sem comentários
    e exige que só o módulo leia status, `deleted_at` e data KPI do pedido pai — o resto do agregado
    (produto, preço) pede teste do handler, declarado como follow-up.
14. **Teto por igualdade em PRs irmãos: o merge textual pode sair limpo e errado.** Com dois PRs baixando
    o mesmo `TETO_DIVIDA`, o git às vezes funde sem conflito e fica o teto de um só. Resolver = aplicar
    sobre o `MERGE_HEAD` as linhas que o PR removeu e acrescentou no registro, RECALCULAR os dois tetos pela
    contagem real e rodar o vitest do gate antes do push.
15. **Citação de linha em arquivo protegido acopla o PR de edge a ele.** O `SKILL.md` do
    `lovable-deploy-verify` cita `fin-valor-cockpit/index.ts:<linha>`, e o `docs:citacoes` exige a linha
    certa: cada linha que a edge ganha ou perde obriga a editar o skill — arquivo que o
    `sync_with_base_branch` não funde quando a main também o mudou (fica para uma pessoa; o founder
    escolheu atualizar a citação no próprio PR).
16. **§7 também vale para a PAUSA.** Trocar o "R$ 0 sob falha" pelo card de erro não bastou: offline a query
    PAUSA com `status: success` e o cache — inclusive quando a rede cai entre uma tentativa falha e a
    próxima do `retry: 2` de produção —, `isError` fica falso e a zona de vendas mostrava o faturado velho
    como atual (sem cache, o corpo vazio dizia "Sem orçamentos aguardando."). O adversarial pegou; o repo
    já tinha `desatualizado()` + `<AvisoLeituraFalhou>` para isso — a zona só não os usava.
