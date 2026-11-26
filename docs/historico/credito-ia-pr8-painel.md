# Crédito-IA PR 8 — painel de crédito (`/credito/painel`) — 2026-11-25

Fecha o programa crédito-IA (plano `docs/superpowers/plans/2026-11-20-credito-ia.md`, linha 48). É só leitura, para gestor e master.

## O que entrega
- **RPC `credito_painel_resumo(p_dias int default 90)`** (migration `20261125120000_credito_painel_leitura.sql`).
  - É `SECURITY DEFINER` e devolve 1 jsonb. A agregação toda acontece no SQL, porque o PostgREST corta em 1.000 linhas, inclusive no `.rpc()`.
  - Gate: `pode_ver_carteira_completa(auth.uid())`, o mesmo predicado da policy das tabelas `credito_*`. Quem não passa recebe 42501.
  - ACL por allowlist: só `authenticated` executa. anon, service_role, PUBLIC e `sandbox_exec*` ficam de fora, e uma postcondição na migration confere isso.
- **Tela `/credito/painel`** (`src/pages/CreditoPainel.tsx`, módulo `vendas` no manifesto).
  - Período fica na URL (`useUrlState`, opções 30/90/180/365 d).
  - Usa `PageSkeleton` e `EmptyState`. 42501 aparece como "Sem acesso".
- **Sensor de uso:** `navegacao.rota_servida` com a chave `/credito/painel` no ledger (`analytics_outbox`). Já é gravado pelo `PageViewTracker`, então não precisou de máquina nova. A leitura com denominador está em `db/sensor-credito-painel.sql`. Há também um `track('credito.painel_aberto')` como conveniência.

## Definições (premissas do founder)
- **Grupo** = a raiz de `credito_grupo_raiz(company, código)`, do PR 2, somando Oben, Colacor e Colacor SC.
  - Par que não resolve vai para "não consolidados", separado por motivo (`sem_grupo` ou `grupo_conflito`). Nunca é encaixado num grupo adivinhado.
  - Grupo que tem par na Colacor SC leva o selo **parcial SC**: a SC não tem pedido no app, então só existem títulos, sem trânsito e sem decisões.
- **Exposição** = títulos abertos, no vocabulário do núcleo do gate (OPEN_TITLE_STATUSES + PAGTO PARCIAL), mais as reservas ativas *efetivas*.
  - A reserva só é medida depois que o gate efetivo grava a 1ª decisão (PR 6). Antes disso vem `null`, nunca 0.
  - Título sem saldo entra na contagem de indeterminados e o valor aparece como "≥".
- **Liberado que atrasou** = pedido criado no app (`created_by` preenchido) que chegou ao Omie e que tem título derivado vencido há mais de 15 dias (data civil em SP, spec §5.8), sem baixa.
  - "Sem baixa" quer dizer: status diferente de RECEBIDO/CANCELADO e, além disso, PAGTO PARCIAL ou nenhuma baixa inferida em `v_titulo_baixas` com `tipo='CR'`.
  - A taxa é atrasados ÷ maturados. Sem pedido maturado, a taxa é `null`.

## Lições (pegas em prod ou na falsificação)
- **O pedido do app grava o PV com zeros à esquerda** (`000000000010520`); o título e o gêmeo importado gravam `10520`. Com o join cru, os 20 pedidos do app casaram **0 títulos**. A correção compara `ltrim(…,'0')`. Junto veio outra regra: o pedido do app continua `enviado` para sempre, e o estado real fica no **gêmeo** (`gemeo_importado_id`). Se o gêmeo foi cancelado no Omie, o pedido não conta como liberado.
- **`v_titulo_baixas.tipo` vale `CR`/`CP`, não `E`/`S`.** Conferi em prod antes de escrever o filtro.
- **`CREATE OR REPLACE` preserva o ACL da função já existente.** Na falsificação, a sabotagem do fecho de ACL ficou VERDE porque a reinstalação herdava o ACL fechado da instalação anterior. Corrigi o harness: cada variante começa com `DROP FUNCTION`, como na 1ª aplicação em prod.
- **`claude_ro` não executa `credito_grupo_raiz` nem `pode_ver_carteira_completa`** (estão fechadas por desenho). Medir em prod exigiu replicar a lógica em SQL. Também não dá para criar nem função `pg_temp` em sessão read-only.

## Estado em prod na entrega (psql-ro 2026-11-25)
- 246 grupos com título aberto e R$ 881,7 mil em aberto. Os 329 pares resolveram para grupo, e 51 grupos têm par na Colacor SC.
- `venda_bloqueio_credito_log` tem **0 linhas** no histórico inteiro, e `credito_decisao_pedido`, `credito_limite` e `credito_solicitacao` também estão em 0. Os blocos de limites, reservas, sombra, fila e gate v2 aparecem como "sem dado ainda".
- Pedidos criados no app são poucos: 27 em 365 d, quase todos de abril. O bloco de liberados já tem sinal real (o PV 10710 tem título ATRASADO sem baixa), mas o denominador ainda é pequeno.

## Pendências
- **Sombra (PR 5, #4192):** a sombra NÃO grava em `credito_decisao_pedido` (P0 do Codex: não tocar o gate efetivo); o estado atual por PV fica em `public.credito_sombra_pv_atual` (faixa, motivo, …). O bloco já está **plugado por SQL dinâmico**: sem a view → "PR 5 não aplicado"; com ela → distribuição faixa × motivo; forma diferente (coluna/permissão) → só o bloco degrada para "sem dado" + motivo, o painel segue. Quando o PR 5 for aplicado, o bloco acende sozinho — sem follow-up. Distribuição só de `NOT carga_inicial` (orientação do dono do PR 5) + **concordância gate v2 × piso atual** (`faixa` × `(piso->>'bloqueado')::boolean`; piso sem a chave = NULL, não "liberou").
- **Concordância IA × regra:** não existe ainda — a IA não decide pedido; o backtest IA × regra é a fatia 5b (depois do PR 4). O bloco diz isso, e mostra a v2 × piso no lugar.

Prova: `db/test-credito-painel-leitura.sh` roda em PG17 com as migrations reais do PR 1/2, nos dois locales. Tem 9 sabotagens, controle verde e restauração verde na mesma invocação.
