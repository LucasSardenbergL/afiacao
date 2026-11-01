# Oben PME/PMR — Frente B: aviso de prazo no pedido · fila de cobrança · CET (2026-10-31)

- **Spec:** `docs/superpowers/specs/2026-10-31-oben-frente-b-pedido-cobranca-cet-design.md` (§7 = calibração do Codex de desenho)
- **Plano-pai:** `docs/superpowers/specs/2026-10-31-oben-pme-pmr-plano-design.md` §4 (decisões 1 e 4 do founder)
- **Lição de domínio:** `docs/agent/financeiro.md` § "Ciclo por cliente"; `docs/agent/money-path.md` §1/§2/§5

## PR1 — Aviso + sugestão de prazo no pedido (`venda_prazo_*`)

- **Migration:** `20261031200000_venda_prazo_decisao.sql` (3 objetos novos; sem envelope — `bun run db:aplicar`). Pré-voo psql-ro 2026-10-31: os 3 objetos AUSENTES em prod; dependências presentes (`pode_ver_carteira_completa(uuid)`, `omie_customer_account_map`, `fin_sync_log.companies text[]`); a postcondição contra o estado antigo falha em **exatamente um** predicado (`P1 FALHOU: RPC ausente`).
- **Prova:** `db/test-venda-prazo-decisao.sh` — 58 asserts, `PASS=58 FAIL=0` em `LC_ALL=C` **e** `pt_BR.UTF-8`; `--falsificar`: **14 sabotagens vermelhas / 0 falhas**, cada uma no assert declarado (gate, RECEBIDO no universo, datas inválidas, ambíguo somado, Infinity, dono do pedido, cliente, conta, dedupe, REVOKE, RLS aberta, INSERT direto, vencido do payload, sync de outra empresa). No `db/nucleo-ci.txt` com `58 falsificar=14`.
- **Helper TS:** `src/lib/unified-order/prazo-sugestao.ts` (parser fail-closed da descrição da parcela, dominância de calendário, classificação da decisão) + `AvisoPrazoCliente` + `usePrazoAviso` + `prazoDecisao.ts` (registro fail-open após o envio de cada conta).

### Medido em prod (psql-ro, 2026-10-31)

| Fato | Medida | Efeito no desenho |
|---|---|---|
| Vencido Oben pelo predicado DIRETO (status aberto + saldo>0 + venc<hoje) × pela view do Ciclo | 446 títulos / R$ 273.371 × 430 / R$ 266.910 | os 16 (R$ 6.461) são `ATRASADO` com `vencimento < emissão` — a view descarta; a RPC do aviso espelha a view (ambíguo/inválido só contados) |
| Clientes que SÓ têm título fora da view | 12 | sem o espelho, 12 clientes receberiam aviso falso (precisão > recall) |
| Ler 1 cliente em `v_ciclo_cliente_resumo` / `v_ciclo_cr_titulos` | 2,7 s / 1,8 s | a view agrega a empresa inteira (`v_titulo_baixas` sem pushdown): não serve à tela de pedido → RPC lê `fin_contas_receber` direto (0,5 ms, índice `(company, omie_codigo_cliente)`) |
| `v_titulo_baixas` só tem linhas para `RECEBIDO/LIQUIDADO` | — | para título ABERTO a view nunca tem baixa ⇒ "vencida_aberta" = regra de status + validade; a ideia de um `EXISTS` em `fin_movimentacoes` foi descartada (3,5 s sem índice e NÃO é a regra da view: 2 títulos divergiam) |
| Pedidos de 30 d (oben+colacor) × para clientes que hoje têm vencido | 453 × 244 | denominador EXTERNO do sensor (cobertura das decisões registradas), medido por fora da tabela |
| Dona do cliente pela carteira (`omie_customer_account_map` → `carteira_assignments`) | 92/101 clientes vencidos (R$ 246,5k/266,9k) | `fin_contas_receber.vendedor_id` é NULL em 446/446 — não serve |
| Condição de pagamento do Omie | código + descrição livre ("30/60/90 DDL", "A Vista", "28/56/84 DDL", "30dd") | parser fail-closed; "Boleto" ⇒ sem sugestão; 1.533/1.534 pedidos de 120 d sem `codigo_parcela` no `omie_payload` (não dá para auditar a condição enviada por ali) |

### Decisões tomadas na execução

- **Sugestão por DOMINÂNCIA de calendário, não por `max`** (Codex P1 #6): 30/60 domina 30/60/90; "75 dias" não (sobe a média 60→75); 30/60 não domina 28/56/84 (dia 28) ⇒ para quem paga 28/56/84 a única sugestão é à vista. Entre as dominantes ≤ degrau, a de maior média.
- **Edge `omie-vendas-sync` NÃO muda:** nada é gateado; o vencido 60+ já é logado na fronteira pelo gate. Um 2º log não-bloqueante custaria deploy de edge sem efeito na decisão.
- **Sensor direto no outbox pela RPC writer**, sem estender a allowlist de `analytics_ledger_registrar` (função quente, 3 frentes paralelas). Chave = id da decisão; evento só na criação do fato.
- **Registro FAIL-OPEN e DEPOIS do envio**, com o desfecho real da tentativa (`enviado | bloqueado_credito | erro | ja_enviado`). Sem FK ao pedido: a auditoria sobrevive à exclusão.

### Sensores e como medir (psql-ro)

```sql
-- Decisões registradas × aceitação, por semana (numerador e cobertura da própria tabela)
SELECT date_trunc('week', created_at AT TIME ZONE 'America/Sao_Paulo')::date AS semana, company,
       count(*) AS decisoes,
       count(*) FILTER (WHERE decisao='aceitou') AS aceitou,
       count(*) FILTER (WHERE decisao='recusou') AS recusou,
       count(*) FILTER (WHERE decisao='ignorou') AS ignorou,
       count(*) FILTER (WHERE decisao='sem_sugestao') AS sem_sugestao,
       count(*) FILTER (WHERE desfecho_envio='enviado') AS enviados
FROM public.venda_prazo_decisao GROUP BY 1,2 ORDER BY 1,2;

-- Cobertura: pedidos de clientes com vencido HOJE × decisões registradas (30 d)
SELECT count(*) AS pedidos_elegiveis,
       count(d.id) AS com_decisao
FROM public.sales_orders so
JOIN public.omie_customer_account_map m ON m.user_id = so.customer_user_id AND m.account = so.account
JOIN public.v_ciclo_cliente_resumo v ON v.company = m.account AND v.omie_codigo_cliente = m.omie_codigo_cliente AND v.n_vencidas > 0
LEFT JOIN public.venda_prazo_decisao d ON d.sales_order_id = so.id AND d.company = so.account
WHERE so.created_at > now() - interval '30 days' AND so.account IN ('oben','colacor');

-- Prazo concedido médio dos títulos novos da Oben, por mês de emissão (antes × depois), ponderado por valor
SELECT date_trunc('month', data_emissao)::date AS mes,
       round(sum(valor_documento * (data_vencimento - data_emissao)) / sum(valor_documento), 1) AS prazo_concedido_pond,
       count(*) AS parcelas
FROM public.fin_contas_receber
WHERE company = 'oben' AND status_titulo IS DISTINCT FROM 'CANCELADO' AND valor_documento > 0
  AND data_emissao >= date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 180)
GROUP BY 1 ORDER BY 1;
```

Linha de base (2026-10-31, antes do Publish): 0 decisões (a tabela nasce vazia); 244 pedidos de 30 d para clientes com vencido hoje. **Fase N+1** (piloto de degrau, alerta de desconto) só com ≥ 1 decisão registrada DEPOIS do Publish e cobertura publicada.

## PR1 — calibração do Codex adversarial de CÓDIGO (gpt-6-astra · max · 462 s · 146.471 tokens)

0 P0 · 4 P1 · 8 P2, todos adotados (parecer cru em `logs/oben-frente-b/codex-pr1-codigo.txt`):
- **P1 Aplicar podia PIORAR** (vendedora já pôs à vista; "Aplicar" voltava a 30/60) → "Aplicar" só aparece se a sugerida ainda antecipa mais que a seleção; escolhida que COBRE a sugerida conta como `aceitou` (`escolhida_cobre`, validado também no servidor).
- **P1 formas recarregadas** (código `002` muda de significado) → oferta congelada guarda a DESCRIÇÃO; descrição diferente ⇒ oferta expirada (`formas_mudaram`, `sem_sugestao`).
- **P1 auditoria Oben segurava o PV Colacor** → registros correm em paralelo e são esperados com teto (6 s) só no fim.
- **P1 retry com PV já no Omie registrava a parcela da tela** → `ja_enviado` NÃO registra (a condição da tentativa original é desconhecida).
- P2: desfecho por prioridade (divergência > erro do PV > já enviado; ordem de produção não rebaixa PV confirmado); oferta segue a seleção até a 1ª interação (a habitual chega assíncrona); ref zerada por conta; parser exige contagens inteiras ≥ 0 e coerência saldo×títulos×dias; inválidos/ambíguos aparecem como nota de qualidade mesmo com vencido 0; "Manter" sem motivo = `recusou_sem_motivo` (não `ignorou`); RPC recusa decisão contraditória (aceitou com escolhida ≠ sugerida sem `escolhida_cobre`; recusa com escolhida = sugerida); erro de refetch com dado em cache = indisponível.
- Prova PG17 após as correções: **60 asserts, 15 sabotagens vermelhas / 0 falhas** (C e pt_BR).

## PR2 — Fila de cobrança com estado e dona (`cobranca_*`, rota `/cobranca`)

- **Migration** `20261031210000_cobranca_fila.sql`: `cobranca_coorte` + `cobranca_coorte_titulo` (coorte SELADA por TÍTULO a partir de `v_ciclo_cr_titulos` `vencida_aberta`, uma por empresa — `oben` na estreia; reaplicar é no-op), `cobranca_caso` (1 aberto por par, índice parcial único), `cobranca_promessa` (identidade própria; situação DERIVADA em leitura: cumprida se o saldo vencido do cliente caiu ≥ o prometido), `cobranca_evento` (append-only; contato/nota/whatsapp são EVENTOS e não mudam estado). RPCs SECDEF `cobranca_fila`, `cobranca_caso_registrar` (writer único; dona OU gestão; `quitado` só com saldo 0 na view, senão 23514; `cancelado_gestao` só gestão com nota), `cobranca_regua_hoje` (D−2 só a vencer; D+1/D+7 pela régua da view; telefone do mapa→profiles). Helpers `cobranca_dona`/`cobranca_pode_agir` fechados a `authenticated`.
- **A prova pegou um fail-open real:** cliente SEM dona dava `NULL = uid` ⇒ `IF NOT NULL` não barrava — qualquer employee agia sobre cliente sem carteira. Fechado com `coalesce` nas DUAS pontas (helper e chamador); a falsificação tira as duas (defesas independentes).
- **Prova** `db/test-cobranca-fila.sh`: 50 asserts, 13 sabotagens vermelhas / 0 falhas. Lição de harness: no bash 3.2 do Mac, `\"` dentro de `$( )` dentro de `"…"` sofre expansão de chaves e picou o JSON — payloads em aspas SIMPLES.
- **UI:** módulo novo `cobranca` no manifesto (negócio, `RequireStaff`, `/cobranca`), página com régua do dia + fila por faixa; atalhos no Ciclo (master) e em Ferramentas de Venda (vendedora). Fronteiras: Ciclo e Vendas só LINKAM — não importam o módulo (gate de fronteiras).
- **Sensores:** `cobranca.estado_mudou` (só mudança de ESTADO; chave = id do evento); variação da coorte por título (query abaixo); promessas por situação.

```sql
-- Destino de cada título da coorte congelada (NÃO é "recuperado": renegociação/cancelamento são destinos próprios)
SELECT c.company,
       count(*) AS titulos, round(sum(ct.saldo_inicial)) AS saldo_inicial,
       count(*) FILTER (WHERE r.status_titulo IN ('RECEBIDO','LIQUIDADO')) AS recebidos,
       round(coalesce(sum(ct.saldo_inicial) FILTER (WHERE r.status_titulo IN ('RECEBIDO','LIQUIDADO')), 0)) AS saldo_recebido,
       count(*) FILTER (WHERE r.status_titulo = 'CANCELADO') AS cancelados,
       count(*) FILTER (WHERE r.data_vencimento <> ct.data_vencimento) AS renegociados,
       count(*) FILTER (WHERE r.id IS NULL) AS sumiram_da_fonte,
       count(*) FILTER (WHERE r.status_titulo IN ('ATRASADO','A VENCER','VENCE HOJE') AND r.saldo > 0) AS ainda_abertos
FROM public.cobranca_coorte c
JOIN public.cobranca_coorte_titulo ct ON ct.coorte_id = c.id
LEFT JOIN public.fin_contas_receber r ON r.company = ct.company AND r.omie_codigo_lancamento = ct.omie_codigo_lancamento
GROUP BY c.company;

-- Promessas por situação (cumprida = saldo caiu >= valor desde a criação)
SELECT ca.company,
       count(*) FILTER (WHERE p.substituida_em IS NULL) AS vivas,
       count(*) FILTER (WHERE p.substituida_em IS NULL AND coalesce(v.saldo_vencido,0) <= p.saldo_na_criacao - p.valor) AS cumpridas,
       count(*) FILTER (WHERE p.substituida_em IS NULL AND coalesce(v.saldo_vencido,0) > p.saldo_na_criacao - p.valor
                          AND p.data_prometida < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS vencidas
FROM public.cobranca_promessa p JOIN public.cobranca_caso ca ON ca.id = p.caso_id
LEFT JOIN public.v_ciclo_cliente_resumo v ON v.company = ca.company AND v.omie_codigo_cliente = ca.omie_codigo_cliente
GROUP BY ca.company;
```

## PR3 — CET persistido (`fin_funding_inputs.custo_capital_mensal`)

- **Migration** `20261031220000_fin_funding_cet_oben.sql`: COLUNA tipada (não chave no jsonb — `useFunding` regrava `funding_inputs` inteiro no upsert), CHECK (0, 0,2], oben = 0,025 só se NULL (não sobrescreve ajuste), RPC `fin_ciclo_custo_capital()` com `_fin_ciclo_gate_master` + `fin_user_can_access`.
- **Prova** `db/test-fin-funding-cet.sh`: 13 asserts, 5 sabotagens vermelhas / 0 falhas; inclui o upsert do Funding preservando a coluna.
- **Painel** `CicloDescontoPainel` lê do banco: sem CET ⇒ "—" e nenhum número; alerta fixo "1% por 7 dias ≈ 68,9% a.a." (fórmula de quem concede, `(1/0,99)^(365/7) − 1`); elegibilidade por perfil: quem já antecipa nas duas leituras não conta; sem histórico fica fora; vencido entra. Chave de URL `cicloCusto*` removida.

## PR2/PR3 — calibração do Codex adversarial de CÓDIGO (gpt-6-astra · max · 480 s · 197.720 tokens)

0 P0 · 7 P1 · 8 P2 (parecer cru em `logs/oben-frente-b/codex-pr23-codigo.txt`). Adotados:
- **P1 policies chamavam `public.pode_ver_carteira_completa`**, que `authenticated` NÃO executa (hardening `20260718180000`) — todo SELECT de staff daria 42501. Confirmado em prod (`has_function_privilege('authenticated', 'public.pode_ver_carteira_completa(uuid)') = false`; a implementação em `private` é SECDEF com EXECUTE). Corrigido em PR1 e PR2; os stubs das provas agora espelham essa ACL (o stub anterior escondia o furo).
- **P1 ex-dona seguia lendo** (fila preferia a dona de abertura) → dona = carteira de HOJE na fila e nas policies (`cobranca_dona` passa a ser executável por `authenticated`); o writer refresca `dona_user_id` a cada ação. Prova C11 (caso aberto pela dona antiga, carteira trocada, ex-dona perde fila, tabela e ação).
- **P1 "promessa cumprida" sem recebimento** → situação `saldo_caiu` (cancelamento/renegociação também baixam); saldo desconhecido não afirma.
- **P1 `quitado` com ausência de informação** → `cobranca_quitacao_ok`: nenhum título aberto/ambíguo/inválido, sync do CR da empresa ≤ 24 h e ≥ 1 recebido; a fila expõe `pode_quitar` e a tela só mostra o botão com ele. Provas C6e0–C6e2 (sync velho e status ambíguo barram).
- **P1 coorte "atual" pelo vencido total e NULL→0** → `saldo_atual_coorte` pelos MESMOS títulos congelados (título sumido ⇒ NULL ⇒ "→ ?"); `coorte_corte_em` sai da RPC (a página não fixa mais "31/10").
- **P1 parser monetário `1250.50 → 125050`** → `parseValorBR` com gramática fechada (pt-BR com milhar, vírgula decimal, ou ponto decimal; `1.2.3` recusado).
- **P1 régua com cache velho** → `refetchInterval` 5 min, `refetchOnMount: 'always'`; residual documentado: o deeplink usa o item lido na última releitura.
- P2: saída de disputa exige nota em QUALQUER ação (estado/promessa/fechar); cancelado pela gestão aparece como `cancelado_gestao` em vez de voltar a `a_contatar`; sob a lente a página se declara indisponível (as RPCs não estão na allowlist de leitura); telefone validado (`telefoneWa`: 10–11 dígitos ganham 55; "(55) 99999-0010" não vira DDI); painel distingue carregando/erro/ausente para CET e para o resumo; texto do cadastro do CET aponta o caminho real (coluna via SQL Editor, não o formulário de Funding); uma releitura por ação (sem `refetch` duplicado).
- Não adotado: nada.
- Provas após as correções: PR2 **58 asserts, 15 sabotagens** (dona de abertura e disputa-por-promessa novas); PR1 60/15 (policy private); PR3 13/5. Todas verdes em C e pt_BR.

## QA visual logado pós-Publish (2026-11-01) — o que os bytes não mostram

Publish provado pelos bytes às ~04:50Z; o QA logado (Chrome, founder master) veio depois, já numa release
posterior (`index-BVrtji3i`, outras sessões publicaram no meio). Três telas abertas de verdade:

- **`/cobranca`** renderiza: régua D−2/D+1/D+7 e fila por faixa; 33 + 21 + 52 = 106 clientes e
  R$ 36.329,98 + 52.811,23 + 191.074,05 = R$ 280.215,26 — **iguais à coorte selada** (cabeçalho = detalhe,
  2ª testemunha pela tela). Primeira abertura deu **404**: a aba estava pinada na release anterior pelo SW
  (`afiacao-release-index-CvD7wadp`, sem o chunk `Cobranca-*`); a release nova já estava `promovida` no
  meta e a NAVEGAÇÃO seguinte a serviu. É o desenho (`src/sw/releases.ts`): quem tinha o app aberto vê a
  rota nova só na próxima navegação/"Atualizar".
- **Aviso de prazo no pedido** (MOVEIS FENIX, Oben, R$ 4.114 vencido há 4 d): renderiza no carrinho com
  R$, títulos, dias, atraso médio e sync. **Defeito achado (PR1):** com "30/60/90" selecionado o aviso dizia
  "Condição atual não lida como prazo em dias". O parser só lia "30 dias"/"30dd"/"30 DDL"; o catálogo
  REAL do Omie da Oben (`omie_condicao_pagamento_catalogo`, 145 linhas) grafa **"Para 30 dias"** (40),
  **"30/60/90"** nu (80), **"A Vista/30/60"** (11). Resultado: a sugestão NUNCA nascia para condição a
  prazo da Oben. Correção no parser (PR de fix desta seção), falsificada contra `num_parcelas` do catálogo:
  130 lidas · 15 ilegíveis por desenho ("N Parcelas", "(C)", "Informar…", "A Vista/1/1", "30/30") · 0
  divergentes; Codex (gpt-6-astra·max·96 s·72k tk): 0 P0/P1, 2 P2 de cobertura adotados. `dias_parcelas`
  do catálogo está vazio nas 145 linhas — por isso a verdade usada foi a contagem.
- **Painel do CET** (aba Ciclo): Oben 2,5% a.m. com a fonte do cadastro, alerta 68,9% a.a., tabela 10/20/30
  dias (0,82% / 1,63% / 2,44%), elegíveis 446 · já antecipam 13.

Residuais da régua, medidos e NÃO corrigidos aqui (cada um é entrega própria):

- **WhatsApp morto na régua:** o telefone vem de `profiles.phone` via `omie_customer_account_map`; dos 106
  clientes da coorte, 96 mapeados e 95 com phone — mas **91 estão sem DDD** (`99999-9999` ×71,
  `9999-9999` ×20), porque `omie-cliente/index.ts` grava `phone: cliente.telefone1_numero` (sem
  `telefone1_ddd`; `omie-vendas-sync` concatena certo). `telefoneWa` exige 10–11 dígitos ⇒ "telefone
  inválido no cadastro" em TODAS as linhas. Não há outra fonte de DDD no banco (`customer_contacts` vazia;
  catálogo sem DDD) — conserto é na edge + re-sync, não no SQL.
- **Régua sem nome do cliente** ("cliente 8689697854"): a RPC `cobranca_regua_hoje` lê
  `fin_contas_receber.nome_cliente`, que está **NULL nas 14.511 linhas da Oben**; a fila mostra nome porque
  passa por `v_ciclo_cliente_resumo`. Correção: a RPC coalescer pela mesma fonte da fila (migration).

## PR4 — Telefone do perfil Omie nasce COM DDD + reposição dos já gravados (`omie-cliente` v1.4)

**Sintoma (QA logado pós-Publish do PR2, 2026-11-01):** TODAS as linhas da régua `/cobranca` da Oben saíam como "telefone inválido no cadastro" — o botão de WhatsApp estava morto. A RPC `cobranca_regua_hoje` resolve o telefone por `omie_customer_account_map → profiles.phone`, e o `telefoneWa` do front exige 10–11 dígitos (DDD + número) para montar o `wa.me`.

**Causa:** `supabase/functions/omie-cliente/index.ts` gravava `phone: telefone1_numero` (sem o `telefone1_ddd`) no insert de `profiles` do `sync_all_clients`, e devolvia o mesmo campo pelado em `pesquisar_clientes`/`consultar_cliente` (que alimentam o `criar_perfil_local`). O ramo "cliente já mapeado" do sync fazia `skip` sem nunca revisitar o perfil — então o dado errado era permanente. A `omie-vendas-sync` já compunha `(ddd) numero`; não havia outra fonte de DDD no banco (`customer_contacts` vazia; nenhum espelho de clientes com telefone).

**Medido ANTES (psql-ro, 2026-11-01, só contagens):**

| recorte | total | sem DDD (8–9 díg.) | com DDD (10–11) | sem phone |
|---|---|---|---|---|
| perfis mapeados distintos (3 contas) | 5.668 | **5.378** | 15 | 262 |
| por conta — oben | 5.622 | 5.333 | 14 | 262 |
| por conta — colacor | 5.204 | 4.938 | 14 | 239 |
| por conta — colacor_sc | 5.296 | 5.019 | 15 | 249 |

Régua de hoje (réplica read-only do filtro da RPC + mesma resolução de telefone): **oben 29 linhas / 23 clientes / 23 com phone / 0 WhatsApp-ok**; colacor 6/6/6/0; colacor_sc 2/2/2/0. Todos os 5.378 sem DDD têm `document` (o paginador de dedup os alcança).

**Correção (precisão > recall — sem DDD é `null`, nunca número pelado nem DDD inventado):**
- Módulo puro `omie-cliente/telefone.ts` (`telefoneOmie`, `telefoneCompleto`, `deveReporTelefone`) + `telefone_test.ts` (Deno, offline): DDD 2 dígitos (tolera `0xx`) + número 8–9 → `(DD) NNNNN-NNNN`; número que já traz o DDD é aceito (com ou sem `55`); DDD repetido no número não duplica.
- Usado em todos os pontos: `pesquisar_clientes`, `consultar_cliente`, insert do `sync_all_clients` e `criar_perfil_local` (normaliza o `telefone` do body — sem DDD vira `null`).
- **Reposição = o próprio `sync_all_clients`** (card "Importar Clientes (3 Contas Omie)" em `/admin/analytics-sync`): no ramo "já mapeado", resolve o user pelo map `(conta, código)` — o MESMO que a RPC lê — e faz `UPDATE profiles.phone` só quando o atual NÃO tem DDD e o Omie fornece um completo. Idempotente (2ª passada = 0 escritas), nunca sobrescreve telefone já completo (pode ter sido corrigido à mão). Zero SELECT por cliente: `phone` entra no paginador de profiles e `user_id` no da view fresca. A edge devolve `telefones_repostos`; o front soma e grava em `acoes_execucoes.detalhes` + toast.
- `VERSAO` → `v1.4-telefone-com-ddd`; fingerprint regravado.

**Fora de escopo (anotado, não tocado):** `omie-sync` `list_clientes` devolve `telefone: telefone1_numero` (sem consumidor em `src/`); `criar_cliente`/`criar_cliente_afiacao` mandam o `telefone` do formulário inteiro em `telefone1_numero` para o Omie (sem separar DDD) — ambos exigem bump/deploy de outras edges.

**Verificação pós-deploy + reposição (rodar no psql-ro; a de régua também vale logado, trocando a réplica pela própria RPC):**
```sql
-- perfis mapeados por formato (esperado: sem_ddd → ~0 nos que o Omie tem DDD; com_ddd ↑)
WITH p AS (SELECT DISTINCT pf.user_id, length(regexp_replace(coalesce(pf.phone,''), '\D', '', 'g')) AS n
             FROM public.omie_customer_account_map m JOIN public.profiles pf ON pf.user_id = m.user_id)
SELECT count(*) FILTER (WHERE n BETWEEN 8 AND 9) AS sem_ddd, count(*) FILTER (WHERE n BETWEEN 10 AND 11) AS com_ddd,
       count(*) FILTER (WHERE n = 0) AS sem_phone FROM p;
-- régua (logado como staff): SELECT count(*) FILTER (WHERE telefone IS NOT NULL) FROM public.cobranca_regua_hoje('oben');
```

## Fecho dos residuais do QA (2026-11-01, ~14:45Z) — parser e nome na régua em prod

- **#3489** (parser lê o catálogo real do Omie) mergeado 14:30Z. Só frontend: vai ao ar no próximo 🖱️ Publish; a prova é por bytes (`RE_A_VISTA_MAIS` no chunk de `prazo-sugestao`).
- **#3490** (régua com `nome_resolvido`) mergeado 14:38Z; migration `20261101120000_cobranca_regua_nome_cliente.sql` **aplicada pelo envelope** (`bun run db:aplicar`, recibo **#841**), com OK explícito do founder. Pré-voo psql-ro antes do apply: função no estado anterior (âncora do PRE presente, sem `nome_resolvido`), ACL já fechado, colunas das duas fontes presentes.
- **Segunda testemunha (psql-ro, outra conexão, pós-commit):** `pg_get_functiondef` contém `nome_resolvido` e `omie_clientes_nao_vinculados`; `has_function_privilege` = false para `anon` e `PUBLIC`, true para `authenticated`/`service_role`; `prosecdef=true` com `search_path=""`. Taxa de resolução replicando o `coalesce` da função sobre `fin_contas_receber` da Oben: **785 clientes com título, 785 com nome, 0 sem** — o "cliente 8689697854" do QA deixa de existir na régua.
- Não medido aqui: adoção na tela (SW troca de build só no clique; régua lê a RPC ao montar, então o nome aparece na próxima abertura de `/cobranca`, sem Publish). Telefone/WhatsApp depende do #3488 (edge no ar; reposição por clique de staff em `/admin/analytics-sync` pendente na sessão-irmã).
