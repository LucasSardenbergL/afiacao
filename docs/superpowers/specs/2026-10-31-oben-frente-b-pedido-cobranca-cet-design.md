# Oben PME/PMR — Frente B: aviso de prazo no pedido, fila de cobrança com estado, CET persistido (2026-10-31)

> Status: DESENHO (3 PRs, uma entrega). Pai: `2026-10-31-oben-pme-pmr-plano-design.md` §4 (decisões 1 e 4 do founder). Money-path: precisão > recall, ausente ≠ zero, Codex desenho + adversarial no diff. Fatos de prod medidos por `psql-ro` em 2026-10-31 (UTC ~18h).

## 0. Fatos medidos que o desenho obedece

| Fato | Medida | Consequência |
|---|---|---|
| Vencido em aberto Oben (`v_ciclo_cliente_resumo`, `n_vencidas>0`) | 101 clientes · R$ 266.910 | denominador congelado do PR2 |
| Dona pela carteira: `omie_customer_account_map` → `carteira_assignments.owner_user_id` (eligible) | 92/101 clientes · R$ 246.549/266.910 | 9 clientes ficam `dona = null` (honesto), nunca atribuição inventada |
| `fin_contas_receber.vendedor_id` nos vencidos | 0/446 preenchido | NÃO serve para dona |
| Ler 1 cliente em `v_ciclo_cliente_resumo` | **2,7 s** (view agrega a empresa inteira; sem pushdown) | o pedido NÃO lê a view; `v_ciclo_cr_titulos` por cliente = 1,8 s, idem |
| Ler vencido de 1 cliente direto em `fin_contas_receber` (índice `(company, omie_codigo_cliente)`) | 0,5 ms | fonte do aviso no pedido |
| Condição de pagamento do pedido = `codigo_parcela` Omie (código + `descricao` texto: "A Vista", "30 dias", "30/60/90 DDL", "28/56/84 DDL", "30dd") | sem campo numérico de dias | a sugestão exige PARSER fail-closed da descrição; ilegível ⇒ sem sugestão (precisão > recall) |
| `analytics_ledger_registrar` tem allowlist fechada + md5-trava do predecessor (`20261031130100`) | função QUENTE, 3 frentes paralelas podem querer evento novo | o sensor desta frente é escrito pela PRÓPRIA RPC writer (1 writer por evento) direto em `analytics_outbox`, com a mesma `chave_dedup` `ledger:<uid>:<evento>:<chave>:<dia>` — sem tocar a função compartilhada |
| `fin_funding_inputs` | `{}` nas 3 empresas; RLS master-only; o `fin-funding` lê `capital_giro_cet_perc`/`cheque_*` (percentual a.a.) | o CET mensal do desconto entra em chave NOVA `custo_capital_mensal` (fração, 0,025), sem colidir com as chaves do funding |
| `venda_gate_credito` (edge, service_role) | bloqueia só vencido > 60d sem exceção | INALTERADO (decisão do founder) |

## 1. RÉGUA

- **Unidade decisória:** o pedido de venda (`sales_orders.id`) de um cliente com título vencido em aberto. Exposta em `UnifiedOrder` (barra do carrinho, junto do seletor "Pagamento Oben/Colacor"). Denominador: pedidos criados por staff para clientes com `vencido > 0` no instante do envio — TODOS ficam em `venda_prazo_decisao` (inclusive `sem_sugestao`), então numerador e denominador saem da mesma tabela.
- **Unidade da cobrança:** o par (company, cliente) com `n_vencidas > 0` = um `cobranca_caso`. Denominador congelado = `cobranca_carteira_snapshot` (saldo e parcelas por cliente no dia do go-live, gravado pela migration com `INSERT … SELECT` idempotente). Recuperado = `saldo_inicial − saldo_vencido_atual` por cliente (clamp em 0 quando o cliente venceu títulos novos — o novo vencido é outra coorte).
- **Unidade do desconto:** R$ antecipado × dias antecipados. `d_max = 1 − (1+c)^(−N/30)` com `c` lido do banco (ausente ⇒ "—", nunca 0, nunca URL). Elegível só quem NÃO paga antes do vencimento hoje (`atraso_pond > 0` ou `n_vencidas > 0`).
- **Como a prova falsifica:** PG17 aplica a migration real e (a) sabota o status do título (`'RECEBIDO'` entrando no vencido) ⇒ aviso fabrica vencido; (b) sabota o gate da RPC (employee → qualquer autenticado) ⇒ `customer` lê vencido de terceiros; (c) sabota a transição de estado (`pago → a_contatar`) ⇒ histórico aceita regressão; (d) sabota o snapshot (`WHERE NOT EXISTS` removido) ⇒ re-aplicar duplica o denominador. Em TS: parser que aceita "Boleto" como 0 dias ⇒ sugestão à vista fabricada.
- **Ordem dos irreversíveis:** (1) tabela + RPC de leitura (reversível, só lê) → (2) UI aviso + registro da decisão (reversível) → (3) snapshot congelado (irreversível por desenho: é o denominador; só nasce uma vez por empresa) → (4) CET no banco (UPDATE jsonb, só se chave ausente) → (5) WhatsApp (envio é irreversível: só por clique humano, nunca automático).

## 2. PR1 — Aviso + sugestão de prazo no pedido (`venda_prazo_*`)

### 2.1 Banco (`supabase/migrations/20261031200000_venda_prazo_decisao.sql`)

**RPC `venda_prazo_aviso(p_company text, p_codigo bigint) RETURNS jsonb`** — STABLE, SECURITY DEFINER, `search_path=public`, gate staff (`user_roles.role IN (employee, master)`; senão `42501`). `REVOKE … FROM PUBLIC, anon; GRANT TO authenticated, service_role`.
- `p_codigo IS NULL OR <= 0` ⇒ `{disponivel:false, motivo:'sem_codigo'}` (precisão > recall).
- Lê `fin_contas_receber` do par: `status_titulo IN (OPEN_TITLE_STATUSES)` (paridade com `titulo-status.ts` pelo teste `titulo-status-paridade.test.ts`, que passa a cobrir esta função), `saldo > 0 AND saldo < 'Infinity' AND saldo <> 'NaN'`, `data_vencimento < hoje_sp`.
- Devolve `{disponivel:true, vencido, n_titulos, dias_vencido_max, vencimento_mais_antigo, atraso_medio_vencido_dias (ponderado por saldo, SÓ do vencido em aberto — rotulado assim; o atraso histórico da view custa 2,7 s e fica fora), sync_em (último `fin_sync_log` complete de CR)}`. Sem vencido ⇒ `{disponivel:true, vencido:0, n_titulos:0}` — zero REAL (linhas lidas, soma zero), distinto de ausente.

**Tabela `venda_prazo_decisao`** (1 writer = RPC abaixo; sem policy de INSERT/UPDATE/DELETE para `authenticated`): `id, sales_order_id uuid NOT NULL REFERENCES sales_orders ON DELETE CASCADE, company CHECK IN ('oben','colacor'), omie_codigo_cliente bigint NOT NULL, nome_cliente, vencido_no_momento numeric NOT NULL CHECK finito ≥ 0, n_titulos int, dias_vencido_max int, parcela_ranking text (condição habitual do cliente), parcela_sugerida text, parcela_escolhida text NOT NULL, decisao text CHECK IN ('aceitou','recusou','ignorou','sem_sugestao'), motivo text (obrigatório quando `recusou`: CHECK), motivo_sistema text (ex.: `condicao_ilegivel`, `ja_a_vista`), decidido_por uuid NOT NULL (forçado = auth.uid() na RPC), created_at`. `UNIQUE (sales_order_id, company)` — 1 decisão por pedido/conta (retry do envio não duplica; `ON CONFLICT DO NOTHING`). RLS: SELECT staff; `service_role` ALL.

**RPC `venda_prazo_decisao_registrar(p jsonb) RETURNS uuid`** — VOLATILE, SECURITY DEFINER, gate staff, valida domínio (decisao, company, finitude), força `decidido_por = auth.uid()`, exige que `sales_orders.id` exista e tenha `created_by`/`user_id` = quem registra OU caller gestor/master (evita registrar decisão em pedido alheio). Insere a decisão e, na MESMA transação, o evento `venda.prazo_sugerido` em `analytics_outbox` (props: `company, decisao, parcela_sugerida, parcela_escolhida, faixa_vencido` — sem nome de cliente nem R$ exato: faixa `<=15d/16-45d/46-90d/>90d`), `chave_dedup = 'ledger:'||uid||':venda.prazo_sugerido:'||sales_order_id||':'||dia_utc`, `ON CONFLICT DO NOTHING`. Teto de props 2 KB.

### 2.2 Helper puro `src/lib/unified-order/prazo-sugestao.ts` (vitest, módulo `vendas`)

- `parseCalendarioParcela(descricao): number[] | null` — `A Vista`/`À vista`/`a vista (…)` ⇒ `[0]`; `N dias|dd|DDL` ⇒ `[N]`; `N/N/N …` ⇒ lista crescente; qualquer outra coisa (`Boleto`, `Cartão`, `Entrada+30`, vazio) ⇒ `null`. Nunca default.
- `prazoDaParcela(cal) = max(cal)` (a parcela mais longa é o que a Oben financia; média de 30/60/90 ≠ condição — `financeiro.md`).
- `sugerirParcela({ formas, parcelaAtual, vencido }) : Sugestao` — `vencido ≤ 0` ⇒ `{tipo:'nenhuma'}`; parcela atual ilegível ⇒ `{tipo:'nenhuma', motivoSistema:'condicao_ilegivel'}`; atual já à vista (prazo 0) ⇒ `{tipo:'nenhuma', motivoSistema:'ja_a_vista'}`; senão alvo = `degrauAbaixo(prazoAtual)` (de `ciclo-cliente-helpers`, os mesmos degraus da aba Ciclo) e a sugerida = forma legível com `max(cal) ≤ alvo`, maior prazo primeiro, menos parcelas em empate; se nenhuma ⇒ forma à vista (`[0]`) se existir; se nem à vista existir ⇒ `nenhuma` com `motivoSistema:'sem_forma_menor'`. **Vencido > 60 d ou `dias_vencido_max > 60`** ⇒ sugestão = à vista direto (o gate já exige exceção; degrau não faz sentido).
- `classificarDecisao({ sugerida, escolhidaNoEnvio, interagiu, motivo })` ⇒ `aceitou` (escolhida = sugerida) · `recusou` (interagiu e manteve/alterou para outra, motivo obrigatório) · `ignorou` (não interagiu e escolhida ≠ sugerida) · `sem_sugestao`.

### 2.3 UI e fronteira

- `AvisoPrazoCliente` (novo, `src/components/unified-order/`): renderiza ao lado do `PaymentCombobox` de cada conta com evidência positiva (`disponivel && vencido > 0`): "R$ X vencido · N títulos · até D dias · atraso médio do vencido A d · sync em …". Sugestão: chip "Sugerido: {descricao}" com `[Aplicar]` (troca `selectedParcela`) e `[Manter]` → `Select` de motivo (`cliente_combinou_pagamento`, `pagamento_em_transito`, `erro_do_omie`, `decisao_gestor`, `outro` + texto). Lente "Ver como": botões `disabled` (cosmético) e a RPC só grava com `useAuth()` real (SECDEF lê `auth.uid()`).
- Estado em `useUnifiedOrder` (aditivo): `prazoDecisaoOben/Colacor: { sugerida, interagiu, motivo } | null`, zerado ao trocar cliente.
- `submitOrder.ts`: após `criar_pedido` Oben/Colacor SEM erro e SEM bloqueio, chama `venda_prazo_decisao_registrar` se o aviso estava disponível com vencido > 0. Falha de registro ⇒ `results.push('registro de prazo falhou')` + `logger.warn` — **nunca** bloqueia nem desfaz o pedido (telemetria/auditoria não quebra venda).
- **Edge `omie-vendas-sync`: NÃO muda.** Nada é gateado (decisão do founder); o vencido 60+ já é logado na fronteira pelo gate. Um 2º log não-bloqueante na edge duplicaria `venda_bloqueio_credito_log` e custaria deploy de edge sem efeito na decisão.

### 2.4 Sensores PR1 (ledger, com denominador)
- `venda.prazo_sugerido` (props acima). Denominador = `count(*) FROM venda_prazo_decisao` por semana; `aceitou/(aceitou+recusou+ignorou)`.
- Prazo concedido médio dos pedidos novos (antes × depois): query sobre `fin_contas_receber` (`avg(data_vencimento − data_emissao)` ponderado por `valor_documento`, por mês de emissão, Oben) — fato já existente, sem sensor novo. Registrada em `docs/historico/`.

## 3. PR2 — Fila de cobrança com estado e dona (`cobranca_*`)

### 3.1 Banco (`20261031210000_cobranca_fila.sql`)
- `cobranca_carteira_snapshot (company, omie_codigo_cliente, nome_cliente, saldo_vencido, n_parcelas, dias_vencido_max, snapshot_em date, PRIMARY KEY (company, omie_codigo_cliente, snapshot_em))` — a migration faz `INSERT … SELECT FROM v_ciclo_cliente_resumo WHERE n_vencidas > 0 AND NOT EXISTS (snapshot da empresa)`; postcondição exige ≥ 1 linha para `oben` e `sum(saldo_vencido)` finito. Só leitura depois (sem policy de escrita para usuários).
- `cobranca_caso (id, company, omie_codigo_cliente, nome_cliente, dona_user_id uuid NULL, estado CHECK IN ('a_contatar','contatado','promessa','pago','negociado','disputa'), promessa_data date, promessa_valor numeric, proximo_contato_em date, aberto_em, atualizado_em, atualizado_por, fechado_em, UNIQUE (company, omie_codigo_cliente) WHERE fechado_em IS NULL)`. CHECK: `estado='promessa' ⇒ promessa_data IS NOT NULL AND promessa_valor > 0 finito`.
- `cobranca_evento (id, caso_id, de_estado, para_estado, canal CHECK IN ('whatsapp','telefone','email','presencial','sistema'), nota, promessa_data, promessa_valor, whatsapp_send_id uuid NULL → whatsapp_template_sends, autor, created_at)` — append-only.
- RPC `cobranca_fila(p_company) RETURNS TABLE(...)` SECDEF: `v_ciclo_cliente_resumo` (`n_vencidas>0`) LEFT JOIN caso aberto LEFT JOIN dona (map → carteira) LEFT JOIN snapshot. Gate: master/gestor (`pode_ver_carteira_completa`) vê tudo; vendedora vê só `dona_user_id = auth.uid()`. Devolve `estado = coalesce(caso.estado, 'a_contatar')`, `faixa` (`<=45d`, `46-90d`, `>90d`) e `saldo_inicial`. Ordem na UI por faixa (recentes primeiro — handoff) e `saldo_vencido DESC` dentro da faixa — **sem peso inventado**.
- RPC `cobranca_transicionar(p_company, p_cliente, p_para, p_canal, p_nota, p_promessa_data, p_promessa_valor) RETURNS uuid` SECDEF VOLATILE: cria o caso se não existe (`a_contatar` → …), valida a máquina de estados (`pago/negociado` fecham; `disputa` não volta a `a_contatar` sem nota; de `pago` não há saída), gate = dona OU gestor/master, grava evento + `cobranca.estado_mudou` em `analytics_outbox` (props: company, de, para, faixa, canal).
- Régua D−2 / D+1 / D+7: RPC `cobranca_regua_hoje(p_company)` lista títulos do dia (a vencer em 2 d; vencidos há 1 d e 7 d) com telefone do cliente (`profiles`/`omie_clientes`). Envio = botão WhatsApp (deeplink `buildWaMeUrl` já existente ou template HSM via `whatsapp_template_sends` quando houver conversa) → ao clicar, `cobranca_transicionar(... 'contatado', 'whatsapp')`. **Sem envio automático** (irreversível e LGPD; precisão > recall).

### 3.2 UI
- Aba Ciclo (master) ganha a seção "Fila de cobrança" (tabela por faixa, estado editável, dona, promessa) e o drill ganha botões de transição + histórico. Vendedora: `/vendas-ferramentas` (ou Meu Dia) lista "Minhas cobranças" pela mesma RPC (gate filtra).
- Sensores: `cobranca.estado_mudou`; recuperado = `Σ(max(0, snapshot.saldo − atual.saldo))/Σ snapshot.saldo` (query, com rótulo "parcial: título novo vencido não entra"); promessas cumpridas/vencidas = casos `promessa` com `promessa_data < hoje` × saldo caiu ≥ promessa_valor.

## 4. PR3 — CET persistido (`20261031220000_fin_funding_cet_oben.sql` + `CicloDescontoPainel`)
- `UPDATE fin_funding_inputs SET funding_inputs = funding_inputs || jsonb_build_object('custo_capital_mensal', 0.025, 'custo_capital_fonte', 'founder 2026-10-31 (CET ≈ 2,5% a.m.)') , updated_at = now() WHERE company = 'oben' AND NOT (funding_inputs ? 'custo_capital_mensal')`. Postcondição: oben com a chave, valor em (0, 0,2]. Pré-voo psql-ro: chave ausente nas 3 (medido: `{}`).
- Leitura: RPC `fin_ciclo_custo_capital() RETURNS TABLE(company, custo_mensal numeric, fonte text)` SECDEF com `_fin_ciclo_gate_master()` (a tabela é master-only, a aba também). `CicloDescontoPainel` deixa o `useUrlState c`: lê do banco; ausente ⇒ "CET não cadastrado para {empresa} — cadastre em Financeiro › Funding" e nenhum número. Alerta fixo: "1% de desconto por 7 dias de antecipação ≈ 69% a.a. (1,01^(365/7)−1)". Elegibilidade: só clientes com `atraso_pond > 0` ou vencido entram na simulação; quem já antecipa aparece como "não elegível (já paga antes)".

## 5. O que NÃO entra (decisões do founder/Codex já tomadas)
Travar pedido · "prazo real vira concedido" · bloqueio por 15 d · degrau em massa 31–45 d · alongar PMP · envio automático de WhatsApp · peso de "esforço" inventado na fila.

## 6. Pendências de deploy (listadas ao fim com `lovable-deploy-verify`)
🟣 3 migrations (envelope `db:aplicar` quando as 4 condições valerem; o snapshot do PR2 é irreversível ⇒ pré-voo com contagem) · 🖱️ Publish · nenhuma edge.

## 7. Calibração do parecer Codex de DESENHO (gpt-6-astra · max · 394 s · 85.478 tokens, 2026-10-31)

Parecer cru em `logs/oben-frente-b/codex-desenho.txt` (gitignorado; cópia no PR). Minha calibração, achado a achado — o que entrou no desenho acima e o que não entrou, com o motivo:

| # | Achado | Sev. | Adoção |
|---|---|---|---|
| 1 | "Staff" não autoriza consultar qualquer cliente; SELECT staff da decisão expõe pedidos alheios | P0 | **Parcial.** A RPC do aviso fica staff: a tela de pedido já deixa qualquer staff vender a qualquer cliente e já lê `fin_contas_receber` por RLS staff (`useAlertaCreditoCliente`) — restringir à carteira calaria o aviso exatamente na venda fora da carteira (cobertura/férias). **Adotado**: SELECT da decisão = quem registrou OU `pode_ver_carteira_completa`; `cobranca_*` (PR2) com RLS por dona/gestor e `cobranca_regua_hoje` com gate explícito. |
| 2 | Autoria do pedido não autentica conta, cliente nem valores | P1 | **Adotado.** A RPC confere `sales_orders.created_by` (ou gestor), `account = company`, cliente via `omie_customer_account_map` (100% dos pedidos de 90 d têm o par), e **relê o vencido** no instante — o `vencido` do JSON é ignorado (prova A7b). Parcela escolhida é declarada pela tela (o Omie não devolve a condição para conferir). |
| 3 | Denominador = registros bem-sucedidos, não todos os pedidos elegíveis; `ON DELETE CASCADE` apaga denominador | P1 | **Adotado.** Sem FK (auditoria sobrevive à exclusão); `desfecho_envio` grava enviado/bloqueado/erro/já-enviado da MESMA tentativa; a afirmação "TODOS" saiu — o sensor publica "decisões registradas" e a cobertura mede-se por fora (pedidos de clientes com vencido no dia × decisões). |
| 4 | Aviso e fila com universos diferentes de vencido (ABERTO/VENCIDO/PARCIAL ambíguos; `n_parcelas` conta pagas) | P1 | **Adotado.** Medido: predicado direto 446/R$273k × view 430/R$266,9k; os 16 são ATRASADO com `vencimento < emissão` (datas inválidas). A RPC espelha a regra `vencida_aberta` (ambíguo e inválido só CONTADOS) — paridade executada com a migration real das views (prova A6). O snapshot do PR2 usa `n_vencidas`. |
| 5 | Soma zero após filtrar não prova ausência de dívida; `sync_em` sem empresa | P1 | **Adotado.** `n_ambiguos`/`n_invalidos` saem no payload; `qualidade` (ok/defasado/sem_sync) pelo sync da EMPRESA (`companies @> p_company`); UI mostra o selo. |
| 6 | Reduzir `max(cal)` pode aumentar o prazo médio (30/60/90 → "75 dias" sobe a média 60→75) | P1 | **Adotado.** `dominaCalendario(S, C)`: fração recebida sob S ≥ sob C em todo dia, com ganho em algum. 30/60 domina 30/60/90; 75 e 60 não; 30/60 NÃO domina 28/56/84 (dia 28) → para A04 a única sugestão é à vista. Entre as dominantes ≤ degrau, a de MAIOR média (menos agressiva). |
| 7 | Parser aceita ambiguidade ("A Vista (30 dias)"); 60 d sem entrada tipada | P1 | **Adotado.** `à vista` só com qualificador `(faturamento)`; `diasVencidoMax` é entrada própria; nunca se inventa código à vista — só da lista da conta. |
| 8–9 | Snapshot por cliente não mede recuperação (vencido novo, renegociação, cancelamento); "só nasce uma vez" não garantido | P1 | **Adotado para o PR2:** coorte selada por TÍTULO (`omie_codigo_lancamento`, saldo, vencimento, corte) com cabeçalho por empresa; recuperação = destino de cada título congelado (recebido / cancelado / renegociado / aberto), rotulada "variação do saldo da coorte", nunca "recuperado" sem baixa. |
| 10–11 | Caso fechado renasce como `a_contatar`; promessa misturada com contato; `wa.me` não prova envio; D−2 não é vencido | P1 | **Adotado para o PR2:** `pago_informado` (não fecha; quitação é derivada da view); promessas em tabela própria com desfecho; contato é EVENTO, não estado; abrir WhatsApp = `whatsapp_aberto`, contato declarado é botão separado; D−2 = lembrete preventivo fora do estoque vencido. |
| 12 | Chave do outbox omite `company`; `DO NOTHING RETURNING` não devolve o existente | P1 | **Adotado.** Chave = `ledger:venda.prazo_sugerido:<id da decisão>`; evento só na criação do fato; retry devolve o id existente (prova A8/A12c: 3 decisões = 3 eventos). |
| 13 | Sensores não demonstram "reduzir PMR sem perder venda" | P1 | **Adotado como registro, não como sensor novo:** `total_pedido` vem de `sales_orders` (servidor); cobertura, conversão e participação dos clientes atingidos são queries no diário; aceitação ≠ efeito. |
| 14 | Elegibilidade do desconto fabrica "já paga antes" | P1 | **Adotado para o PR3:** perfis pontual / antecipador / misto / sem histórico; só antecipador com evidência é inelegível; N = antecipação incremental de cenário. |
| P2 | CET em jsonb: writer do Funding regrava o objeto inteiro | P2→P1 | **Confirmado e adotado:** `useFunding` faz `upsert({funding_inputs})` inteiro — o CET vai para COLUNA tipada `fin_funding_inputs.custo_capital_mensal` (PR3), não para o jsonb. |
| P2 | Degrau mínimo "sem 7→0" | P2 | **Adotado:** `degrauAbaixo() === null` ⇒ `prazo_ja_curto`, sem fallback à vista. |
| P2 | Congelar a oferta | P2 | **Adotado:** sugestão congelada por (conta, cliente) na 1ª leitura. |
| P2 | Alerta anual: `(1/0,99)^(365/7) − 1 ≈ 68,9%` | P2 | **Adotado para o PR3** (texto do painel). |
| P2 | SECDEF `search_path` | P2 | **Adotado:** `SET search_path = ''` com objetos qualificados. |

**Não adotado (com motivo):** envio automático de WhatsApp (decisão do founder); gate por carteira no aviso (acima, #1).
