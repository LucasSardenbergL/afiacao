# Venda por cliente — recompra, complemento e preço dentro do dia da farmer

> **Status:** aprovado pelo founder em 2026-10-20 · 2026-10-20 · branch `claude/cross-sell-upsell-revenue-702b57`
> **Origem:** brainstorming Claude + Codex + Fable (dossiê de uso medido em prod, 20/10/2026).
> **Próximo:** aprovação do Lucas → `superpowers:writing-plans`.

## 1. Intenção e porquê

O app tem motores de venda há meses — Apriori, motor de cross/up-sell, edge `recommend`, Mix/Gap, bundles, plano tático, cockpit de defasagem, régua de preço — e **nenhum virou receita**. Medido em prod:

- 17.316 recomendações geradas, **≈0 desfechos**; 955 planos táticos, **0 desfechos**; `recommendation_log` com 1 único `accept` na vida.
- As farmers (Regina, Tatyana) **não logam desde abril**; 1 pedido nascido no app em 12 meses; **100% da venda entra pelo Omie**.

O diagnóstico é **canal e adoção, não algoritmo**: as sugestões nascem numa tela que ninguém abre e morrem sem que ninguém saiba se viraram pedido.

**O que muda agora (decisão do Lucas):** ao fim deste programa, o uso do app passa a ser **obrigatório** para as farmers. O app vira, ao mesmo tempo, o **canal** (é onde a farmer decide quem ligar e o que oferecer) e o **sensor** (é onde sabemos o que foi sugerido e se virou pedido no Omie).

O programa entrega **um dia de trabalho da farmer dentro do app**: abrir o Meu Dia, ver a lista de quem ligar e por quê, abrir a ficha do cliente com o que recomprar, o que oferecer a mais e o preço a praticar, ligar, registrar o desfecho em um toque — e fechar o pedido no Omie como hoje. O app **não** substitui o Omie como lugar do pedido.

## 2. Quem usa e como é o dia

- **Farmers de televendas** (Regina, Tatyana): carteira por cidade, ligam para os clientes da carteira, fecham o pedido no Omie. A posse da carteira é **única por comprador** (`carteira_assignments`, `UNIQUE(customer_user_id)`, derivada do vendedor Oben no rebuild noturno); 501 dos 504 compradores dos últimos 12 meses estão em carteira elegível. Ligam pelo telefone delas (a telefonia do app está congelada).
- **Founder** (Lucas): único usuário ativo hoje. Quer ver, por farmer, quantos clientes ela tinha para contatar, quantos contatou e quantos compraram — e decidir repasse de preço.
- Cliente típico: marcenaria/indústria moveleira; pode ter **2 cadastros Omie legítimos** (Oben + Colacor). Medido: cadastros do **mesmo CNPJ** já são o **mesmo `customer_user_id`**, separados por `sales_orders.account` (`omie_customer_account_map`); os aliases fiscais `@placeholder.local` resolvem para o canônico por `customer_canonical_alias` (1.633 ativos). **Comprador = `customer_user_id` canônico** (alias → canônico). Filiais (mesma raiz de CNPJ, user diferente) **não** são unidas neste programa (`cliente_grupos` tem 0 linhas).

## 3. Objetivos, não-objetivos e anti-objetivos

### Objetivos
1. **Medir sem pedir clique.** Toda sugestão mostrada tem identidade; um job casa sugestão × pedido do Omie e diz "virou / não virou / não consegui medir".
2. **Motores sãos.** Saúde do cliente separa *perdido* de *atrasado*; recompra por cliente × produto (o quê, quanto, quando, o que está atrasado); **uma** fórmula de complemento, no servidor.
3. **Uma lista de quem ligar**, com motivo, e um desenho que permite saber se ela funciona (conversão da lista contra a **reconstrução do mesmo gerador nos 12 meses anteriores**, conferida por uma sombra curta — sem grupo controle, decisão do founder).
4. **Complemento na ligação**, não numa tela separada.
5. **Repasse de preço** determinístico: o founder vê defasagens e casos abaixo do piso; a farmer vê preço alvo, nunca custo.
6. **UX única:** um Meu Dia com fila única, ficha da ligação e desfecho em 1 toque; telas mortas saem do caminho da farmer.

### Não-objetivos (fora deste programa)
- Pedido nascendo no app (o Omie continua sendo o lugar do pedido).
- Descongelar telefonia, WhatsApp, rota, tarefas, loja ou KB (M-41 até 10/01/2027).
- Re-pesar regras de associação com ML, LTV/RFM, novo "supermotor", recalibração automática.
- Portal do cliente com recomendação; automação de WhatsApp.
- Tier de preço em massa (`cliente_tier_preco` segue aguardando o go do founder, programa próprio).
- Apagar código dos motores antigos (sai do caminho da farmer agora; limpeza de código é trabalho separado).

### Anti-objetivos (falha mesmo se "funcionar")
- **Mais uma tela de sugestões sem desfecho.** Se a sugestão não tiver ID e casamento com o Omie, o programa falhou.
- **Antecipar compra e chamar de crescimento.** O critério compara a conversão das sugestões contra a **linha de base** (mesmo gerador reconstruído no passado + sombra, sem lista), não o faturamento contra o mês anterior; e o painel diz com todas as letras que antes × depois não é prova causal.
- **Comprar faturamento com margem**: desconto geral, IA sugerindo preço, preço alvo abaixo do piso.
- **Expor custo à farmer**, direta ou indiretamente (ex.: preço alvo derivado que permita reconstruir o custo — ver §7.4).
- **Fabricar número:** cliente sem dado vira "não consegui medir", nunca zero.
- **Quatro listas de "quem ligar"** convivendo. Ao final, a farmer vê uma.

## 4. Restrições (regras do projeto que este desenho obedece)

| Regra | Como aparece aqui |
|---|---|
| Fase N+1 só com sinal da fase N, com denominador | Toda superfície nasce com sensor; liberação em ondas (§8) |
| Ausente ≠ zero | Desfecho tem 3 estados; recompra sem histórico suficiente = "sem base", não "em dia" |
| IA não precifica | Preço alvo vem de regra determinística (régua/markup/último preço), nunca de LLM |
| Vendedor nunca vê custo | Gate `private.cap_custo_ler`; farmer vê preço alvo e faixa de margem |
| Corte por ranking só no eixo da decisão | A lista do dia é cortada por *atraso de recompra × valor*, que é o eixo da decisão "ligar hoje"; complemento e preço não entram no corte |
| Cross × up-sell incomensuráveis | Recompra, complemento e preço são **seções separadas** na ficha, sem score comum |
| Máquina meta só com incidente | O casamento sugestão × pedido é **sensor de produto que nasce com a superfície**; incidente citado: 17.316 recomendações e 955 planos com 0 desfechos |
| M-41 | Nenhuma rota `/rota`, `/telefonia`, `/whatsapp`, `/tarefas` volta. Peças **puras** usadas pela ficha (munição, histórico, último preço) podem ser **re-hospedadas** no módulo `farmer-inteligencia` — ver §7.5 |
| 2 cadastros = 1 comprador | Gerador e casamento de desfecho operam no **comprador** (`customer_user_id` canônico, alias resolvido por `customer_canonical_alias`); nada é deletado |
| Arquivo novo em `src/` | Dono no `manifesto.ts` (`farmer-inteligencia`) |
| Deploy | Migration · edge · Publish são passos separados do merge; ver §9 |

## 5. O que já existe e o destino de cada peça

| Peça | Destino |
|---|---|
| `lib/fila/*` (contrato `AcaoSugerida`, `rankearFila`, `dedupe`), `useFilaAcoes` (erro honesto por fonte), telemetria 1×/dia | **Reaproveitar** — a fila única é esta, com fontes novas |
| `AcaoOutcomeMenu` + 4 RPCs de desfecho com guard de lente | **Reaproveitar** o padrão; o desfecho da ligação passa a ter um escritor único por cliente (§7.6) |
| `useMunicaoLigacao` / `lib/call/municao.ts`, `useHistoricoCompras`, `lib/omie/ultimo-preco.ts` | **Reaproveitar** na ficha (re-hospedar, §7.5) |
| `FichaPreContato` (só montada na rota congelada) + `FilaContextPanel` (flag) | **Fundir**: o painel de contexto da fila vira a ficha da ligação |
| `PositivacaoHero` + `get_minha_positivacao` | **Reaproveitar** como placar do mês no Meu Dia |
| `get_meu_mixgap` + `farmer_mixgap_feedback` + adapter `mixgap` | **Fonte única de complemento** (§7.3) |
| Cockpit `get_preco_cockpit`, `get_defasagem_cliente`, régua `get_regua_preco` (flag desligada, v1 só Oben) | **Reaproveitar** como base do preço alvo (§7.4) |
| `farmer_client_scores` (cron `calculate-scores`) | **Corrigir** a classificação perdido × atrasado (§7.2); `revenue_potential`/`expansion_score` 100% NULL **não** são preenchidos neste programa |
| `useCrossSellEngine` (browser) + `/farmer/recommendations` | **Sai do caminho da farmer** (rota sem link já; nada novo consome) |
| Edge `recommend` (pedido/360, staff) | **Intocado** — não é canal da farmer |
| Plano tático (cron `tactical-plans-batch-nightly` 08:00 UTC, 955 planos/0 desfechos), bundles, copiloto | **Sai do caminho da farmer**; ⟨decisão minha: desativar o cron do plano tático — custo de LLM sem consumidor⟩ |
| Adapters `tarefa`, `whatsappPendente`, `rota` da fila | **Desligar** enquanto M-41 vigorar (consultam tabelas vazias e geram links para `/`) |
| `ClientesAPositivarCard`, `AgendaTodayList`, `AgendaQueueCard`, `BoardCarteira`, `/farmer/calls` | **Fundir** no Meu Dia ou aposentar da navegação da farmer |
| "Modo antigo" do `FarmerDashboardV2`, `SlaCardMeuDia`, links para módulos congelados | **Remover** do Meu Dia |

## 6. Peça central: a sugestão com identidade (`venda_sugestao`)

Toda sugestão que a farmer **vê** é uma linha com identidade. É a espinha do programa: sem ela, nenhuma fase tem sinal.

**Campos mínimos (o construtor fecha os nomes):**
- `id`, `tipo` (`recompra` | `complemento` | `preco`), `gerada_em`, `dia_referencia`
- `farmer_user_id` (dono da carteira no dia), `comprador_id` (`customer_user_id` canônico), `empresa` (`oben` | `colacor` | `colacor_sc`)
- alvo: `produto_id` (recompra/preço) ou `familia` (complemento)
- referência: `qtd_ref`, `valor_ref` (R$ esperado — nulo se não houver base, **nunca 0**), `preco_alvo` (só `tipo=preco`)
- `fase` (`historico` | `sombra` | `ativa`) — `historico` = linhas reconstruídas para datas passadas (§Fase 2); `sombra` = gerador rodando antes do go-live, sem mostrar a ninguém; `ativa` = mostradas à farmer. `historico` e `sombra` são a linha de base
- `mostrada_em` (primeira exibição real na tela; nulo = nunca vista)
- desfecho automático: `desfecho` (`virou_pedido` | `nao_virou` | `nao_medivel`), `desfecho_motivo` (ex.: `cadastro_sem_vinculo`, `sync_atrasado`), `sales_order_id`, `valor_realizado`, `avaliado_em`
- desfecho manual (§7.6): referência ao registro de contato

**Escritores (1 por papel):**
- **Gerador noturno** (servidor) cria as linhas do dia (`sombra` antes do go-live da onda, `ativa` depois).
- **UI** marca `mostrada_em` via RPC idempotente (primeira vez vence).
- **Job de desfecho** (servidor, noturno, após o sync do Omie) fecha cada linha cuja janela venceu: recompra 14 dias, complemento 30 dias, preço 30 dias ⟨decisão minha, ajustável⟩. "Virou" = existe pedido do **comprador** (qualquer dos cadastros) na janela contendo o produto/família; para preço, o preço praticado ≥ preço alvo − tolerância.
- Fonte do casamento: `order_items ⋈ sales_orders` (fonte canônica; 100% dos pedidos de venda de 12m têm itens com `product_id`), universo de venda de `src/lib/farmer/universo-pedidos.ts` (exclui cancelado/rascunho/pendente/orçamento, `deleted_at IS NULL`), data do pedido = `COALESCE(order_date_kpi, created_at)`. O alias do comprador é resolvido antes de casar.
- `nao_medivel` sempre que: sync de vendas da empresa defasado na janela (o sync roda a cada 2h; usar o heartbeat do sync), comprador sem resolução de alias, ou preço praticado ausente (`tipo=preco`).

RLS: farmer lê só as suas linhas com `fase='ativa'`; master lê tudo; ninguém escreve direto (só RPCs/SECURITY DEFINER com gate na fronteira).

## 7. Fases

Ordem pedida pelo Lucas: **melhorar os motores primeiro, UX por último**. Cada fase lista o que entrega, onde mais aparece, o sensor e as camadas de deploy.

### Fase 0 — Medir sem pedir clique

- Tabela `venda_sugestao` + RPCs (marcar mostrada, ler minhas sugestões) + job de desfecho (§6).
- **Painel de adoção do founder** (master-only): por farmer e por semana — clientes na lista (denominador), clientes contatados (desfecho manual registrado), clientes que compraram (desfecho automático), receita e faixa de margem, **conversão `ativa` × linha de base lado a lado** — mesma semana do ano anterior (`historico`) e últimas semanas antes do go-live (`sombra`) — com o aviso "antes × depois, não causal", e a contagem de `nao_medivel` (se for alta, o painel diz "não consegui medir", não "zero").
- **Onde mais aparece:** nada da farmer muda nesta fase.
- **Sensor:** o próprio painel; a query de leitura fica no plano ("quando medir" é query).
- **Deploy:** migration · edge/cron do job · Publish (painel).

### Fase 1 — Saneamento dos motores

**1a. Saúde: perdido × atrasado.** Hoje a classe "atenção" mistura cliente perdido com cliente em risco real. **Causa medida:** `avg_repurchase_interval` **não é calculado por ninguém** — o seed grava 0 e linhas legadas têm 30 (6.334 linhas com 0, 140 com 30). Em `calculate-scores` (`index.ts:844`), `freqScore = 100 − interval/maxInterval·100` dá ~80 pontos a quem tem o resíduo 30; com margem/x/s nulos e pesos renormalizados, cliente morto (999 dias) cai em "atenção" (69 linhas). A regra de positivação `days > avg_repurchase_interval × 1,5` está **inerte** pelo mesmo motivo.

Entrega: (i) `calculate-scores` passa a **calcular e persistir** o intervalo de recompra do comprador (mediana dos gaps entre dias de pedido, histórico de `order_items`); com < 3 pedidos o intervalo é **nulo** e a frequência sai da conta (ausente ≠ zero) — isso corrige a classe dos mortos; (ii) uma **situação de recompra** por comprador: `em_dia` | `atrasado` | `perdido` | `sem_base`. Perdido = sem compra há mais que max(3× intervalo, 365 dias) ⟨limiar inicial; o construtor mostra a distribuição antes de cravar⟩. Perdido **sai da lista da farmer** (vai para Caça/dormentes, papel hunter).

**Onde mais aparece (efeito desejado, mas visível):** `health_class` muda para parte da base (atenção → crítico); a lista `a_positivar` da positivação **volta a funcionar** (regra 1,5× deixa de ser inerte); `BoardCarteira`, `AgendaTodayList`, plano tático e Customer360 leem `farmer_client_scores`. O PR registra a contagem por classe antes/depois. O espelho TS em `src/lib/scoring/*` acompanha (é paridade testada).

**1b. Recompra por cliente × produto.** Não existe cálculo persistido. Existe a lógica pura `montarCestaRecompra` (`src/lib/whatsapp/cesta-recompra.ts`, usada na proposta de WhatsApp): por SKU e empresa, cadência = mediana dos intervalos entre dias de pedido, quantidade sugerida por mediana com tendência, `dueRatio`, confiança alta/média/baixa. **Portar essa lógica para o servidor** (tabela recalculada no cron noturno) e usar a versão TS como oráculo de teste de paridade. Escopo: por comprador × SKU × empresa com ≥3 pedidos em 18 meses: cadência, quantidade sugerida, última compra, último preço praticado (`unit_price` − `desconto_valor`/qty, o mesmo critério de `lib/omie/ultimo-preco.ts`), atraso. Atrasado = `dueRatio` ≥ 1,5 (o critério do dossiê). Valor esperado = quantidade sugerida × último preço (nulo se faltar preço). Fonte: `order_items ⋈ sales_orders`, universo de venda canônico.

**1c. Uma fórmula de complemento, no servidor.** A fonte única é a lógica de `_carteira_mixgap_for_owner` (Apriori por empresa em `farmer_association_rules`, pisos conf ≥ 0,15 · lift ≥ 1,5 · n ≥ 30, compras de `order_items` 12m, gap por `familia`, supressão de `convertido` e `recusado` < 90d). Hoje só devolve a carteira inteira, top-1 por cliente, até 100 linhas. Evolução: **função nova por comprador** (para a ficha) devolvendo até 3 famílias e, por família, os 1–3 SKUs mais comprados por quem tem a regra na mesma empresa; a RPC atual `get_meu_mixgap` **fica como está** (o `MixGapCard` e o adapter seguem funcionando). Os outros dois motores (browser e edge `recommend`) **não** alimentam a farmer.

- **Onde mais aparece:** ver 1a (scores); `get_meu_mixgap` não muda de assinatura. Funções novas: REVOKE de `PUBLIC` e `anon`, gate staff na fronteira.
- **Sensor:** nesta fase, distribuição das situações e cobertura (quantos compradores com recompra calculável vs `sem_base`) — vai para o painel da Fase 0.
- **Deploy:** migration · **edge `calculate-scores`** (deploy manual) · cron da tabela de recompra encaixado depois de `calculate-scores` (06:00/06:25 UTC) e `carteira-rebuild` (07:30 UTC).

### Fase 2 — Lista de quem ligar (sem grupo controle — decisão do founder)

- **Gerador noturno** (depois da tabela de recompra, ~08:15 UTC = 05:15 BRT): para cada farmer, uma lista feita pela **união** de duas fontes (decisão do founder; união, não `LIMIT` sobre um só eixo):
  1. os compradores **atrasados** das **cidades com entrega amanhã** — agenda semanal `route_schedule` (dia da semana → cidade/UF, 24 linhas; só **leitura** da tabela, nenhuma tela de rota volta);
  2. os **maiores atrasos** do resto da carteira elegível, por valor esperado em atraso (teto diário ⟨decisão minha: 10 por farmer, ajustável na configuração⟩).
  Cada comprador entra com suas linhas de recompra (§6) e o motivo de entrada ("entrega amanhã em X" ou "maior atraso da carteira").
- **Linha de base (sem grupo controle):**
  1. **Reconstrução histórica** (`fase='historico'`): o gerador roda para cada dia dos **12 meses anteriores** usando só os pedidos conhecidos **até aquela data** (sem olhar o futuro — a cadência e o atraso de cada dia são recalculados com o histórico daquele dia) e com a carteira atual. O job de desfecho fecha essas linhas na hora (o futuro já é conhecido). Resultado: a taxa "atrasado que recomprou em 14 dias com a rotina de então", semana a semana, incluindo a **mesma época do ano passado** — o que absorve boa parte da sazonalidade.
  2. **Sombra curta** (`fase='sombra'`): assim que a Fase 2 é implantada, o gerador grava as listas do dia sem mostrar a ninguém, até o go-live. Serve para **conferir** que a reconstrução bate com o presente (se a sombra divergir muito do histórico das mesmas semanas, a reconstrução tem defeito e o painel diz "linha de base não confiável" em vez de comparar).
  3. No go-live da Onda 1, passa a gravar `fase='ativa'`.
  Limite declarado: carteira e mercado mudam de um ano para o outro — continua sendo antes × depois, não prova causal.
- **Critério em 30 dias** (lido no painel): **≥80%** dos compradores da lista com tentativa de contato registrada; **conversão `ativa` acima da linha de base** da mesma época (virou pedido / sugeridos) e receita por comprador atendido não menor; medição incompleta (`nao_medivel` alto, sync defasado, sombra divergente do histórico) = **inconclusivo**, não libera a onda seguinte. Limite declarado: antes × depois, sujeito a sazonalidade — é sinal operacional, não prova causal.
- **Onde mais aparece:** a lista é uma **fonte nova da fila** (adapter `recompra`) — só aparece na Fase 5.
- **Deploy:** migration (gerador + configuração) · cron.

### Fase 3 — Complemento na ligação

- Na ficha, seção "Oferecer também": até 3 famílias de `get_meu_mixgap` evoluída, com os SKUs de referência e a frase "clientes parecidos compram". Gera linha `tipo=complemento` em `venda_sugestao` quando **mostrada**.
- Disponibilidade: só mostrar estoque se houver fonte confiável; sem fonte → não mostrar (nunca "disponível" fabricado).
- O feedback `ofertado/convertido/recusado` do Mix/Gap segue valendo (supressão); a conversão real vem do job.
- **Deploy:** migration (evolução da RPC) · Publish.

### Fase 4 — Repasse de preço (money-path: Codex 2×, desenho com seção `RÉGUA:` e código)

- **Para o founder** (master-only): lista de compradores × SKU com **defasagem** (custo subiu e o preço deste cliente não acompanhou) e **abaixo do piso** (régua/markup), com valor anual recuperável e evidência. `get_defasagem_cliente` hoje só avalia **um cliente com itens informados** (máx. 200); a lista exige uma versão em lote sobre a tabela de recompra (mesmas constantes: tolerância 3pp, alta mínima 2%, âncora ≤ 18 meses, quarentena 50%) — **não** duplicar a regra: extrair o núcleo e chamar dos dois lugares. Ele **aprova** quais repasses aplicar (decisão do founder): a aprovação grava comprador × SKU × preço alvo × validade numa tabela própria (1 escritor, master-only).
- **Para a farmer:** na ficha, por SKU de recompra, **preço alvo só quando houver repasse aprovado** pelo founder e vigente, ao lado do último preço praticado, e a faixa de margem. Sem aprovação, só o último preço. **Nunca o custo**, e nunca um valor do qual o custo se deduza trivialmente (ex.: não exibir "custo × markup" com o markup visível).
- Escopo v1 = o mesmo da régua v1: **Oben, sem tinta**; Colacor e tinta mostram só último preço.
- Gera linha `tipo=preco` em `venda_sugestao` só para repasse aprovado, quando mostrado; desfecho = preço praticado no Omie ≥ alvo − tolerância.
- **Deploy:** migration · Publish. Registro `Codex: desenho=… · código=…` no PR.

### Fase 5 — UX (última)

- **Meu Dia = fila única.** Fontes: `recompra` (nova) como principal; `mixgap` deixa de ser item solto e passa para dentro da ficha; adapters `rota`, `tarefa`, `whatsappPendente` desligados enquanto M-41. `PositivacaoHero` fica como placar. Saem: modo antigo, `SlaCardMeuDia`, links para módulos congelados, `ClientesAPositivarCard` duplicado.
- **Ficha da ligação** (o `FilaContextPanel` promovido, sem flag): cabeçalho com telefone (`tel:` — sem WebRTC) e munição (dias desde a última compra, ticket médio); três seções separadas e sem score comum: **Recomprar** (SKU, qtd sugerida, atraso, último preço, preço alvo), **Oferecer também** (complemento), **Histórico** (últimos pedidos). Link para o 360.
- **Desfecho em 1 toque, por cliente** (§7.6), além do automático.
- **Aposentar da farmer:** `/farmer/calls`, `/farmer/recommendations`, `/farmer/bundles`, `/farmer/tactical-plan`, `/farmer/copilot`, `/farmer` legado — já não estão no menu; garantir que nada do Meu Dia aponte para elas. ⟨Decisão minha: não apagar rotas neste programa; só remover pontos de entrada.⟩
- **Sensor:** `fila.exibida` (1×/dia, já existe), `mostrada_em` por sugestão, desfecho manual por cliente, abertura da ficha — tudo no **ledger** (`registrarNoLedger`), porque o PostHog está bloqueado no founder e a decisão de fase depende disso.
- **Deploy:** Publish (+ migration da RPC de desfecho).

### 7.5 Re-hospedar peças puras do módulo congelado

`useMunicaoLigacao`, `lib/call/municao.ts`, `useHistoricoCompras`, `lib/omie/ultimo-preco.ts` e a apresentação da `FichaPreContato` **não** dependem de WebRTC. ⟨Decisão minha:⟩ movê-las (ou importá-las com exceção registrada em `fronteiras-baseline.ts`) para `farmer-inteligencia` **não** descongela telefonia/rota: nenhuma rota congelada volta, nenhum menu reaparece. `BotaoLigar`/`CallButton`/`WebRTCCallContext` ficam onde estão e **não** são usados; a ficha usa `tel:`.

### 7.6 Desfecho manual da ligação — 1 escritor

Um RPC por cliente/dia: `contatei` com resultado `vendeu` | `vai_pedir` | `sem_interesse` | `nao_atendeu` (+ motivo opcional quando `sem_interesse`, reaproveitando `MOTIVOS_RECUSA`). Fixa `auth.uid()`, bloqueado na lente "Ver como". É o denominador de "tentativa de contato" do critério de 80%. Os 4 escritores antigos continuam existindo para suas telas; a ficha usa só este.

## 8. Liberação em ondas (como "implementar tudo" convive com "fase sem sinal")

Construímos as Fases 0–5 nesta leva, mas a farmer recebe em ondas, cada uma liberada pelo sinal da anterior (lido no painel):

- **Onda 1 (go-live, uso obrigatório):** Meu Dia com lista de recompra + ficha (Recomprar + Histórico) + desfecho em 1 toque. O gerador passa de `sombra` para `ativa` aqui.
- **Onda 2:** liga "Oferecer também" (complemento) quando a Onda 1 tiver ≥80% de tentativas por 2 semanas seguidas.
- **Onda 3:** liga preço alvo na ficha quando o founder tiver aprovado a primeira leva de repasses (Fase 4) e a Onda 2 estiver estável.

O liga/desliga é configuração no servidor (não flag em localStorage), para valer nos aparelhos das farmers. **Ondas: decisão do founder.**

## 9. Camadas de deploy

| Fase | Migration | Edge/cron | Publish |
|---|---|---|---|
| 0 | `venda_sugestao`, RPCs, job | cron do job de desfecho | painel do founder |
| 1 | situação de recompra, recompra × SKU, `get_meu_mixgap` evoluída | `calculate-scores` se 1a ficar lá | — |
| 2 | gerador D-1 (histórico · sombra → ativa), configuração, carga da reconstrução | cron do gerador | — |
| 3 | — (coberto em 1c) | — | seção na ficha |
| 4 | lista de repasse em lote, tabela de aprovação | — | lista do founder + seção na ficha |
| 5 | RPC de desfecho manual, liga/desliga por onda | — | Meu Dia + ficha |

Quem faz: migration no envelope seguro → eu; fora dele → founder no SQL Editor. Edge → deploy manual (decidido por `pendencias:deploy`). Publish → founder clica. **Merge não é produção.**

## 10. Deixado ao construtor

- Nomes de tabelas/colunas/RPCs; horários exatos dos crons (respeitando a ordem scores → carteira → recompra → gerador; desfecho depois de um ciclo de sync de vendas).
- Layout da ficha e do painel dentro do design system v3.
- Tolerância de preço no desfecho `tipo=preco`.

## 11. Decisões minhas (do builder check) — confira ao ler

- **Para quem o gerador roda:** só donos de carteira com papel comercial de farmer (hoje Regina: 1.531 compradores elegíveis, Tatyana: 1.244). O founder (6 compradores) fica fora do gerador e do denominador.
- **Preço alvo nunca sugere baixar:** a aprovação de repasse recusa alvo abaixo do último preço praticado. Colacor e tinta (fora da régua v1) mostram só o último preço e **não** geram linha `tipo=preco`.
- **Margem usa o custo atual** (`product_costs`, um custo por produto, sem empresa nem histórico). A faixa mostrada à farmer e o valor recuperável herdam esse custo; custo à data do pedido seria outra tabela, fora deste programa.
- **Liga/desliga por onda:** tabela de configuração nova no servidor (não existe hoje).
- **Fonte do `nao_medivel` por sync:** `vendas_sync_heartbeat` por empresa.

## 12. Decisões do founder (2026-10-20)

| Pergunta | Decisão |
|---|---|
| Grupo controle | **Sem controle.** Todos os atrasados entram na lista |
| Linha de base | **Reconstrução dos 12 meses anteriores + sombra curta** para conferir (founder: "pode fazer como você preferir") |
| Tudo no dia 1 × ondas | **3 ondas** (§8) |
| Preço alvo | **Só repasses aprovados** pelo founder |
| Lista do dia | **Cidades com entrega amanhã + maiores atrasos** do resto da carteira (união) |
