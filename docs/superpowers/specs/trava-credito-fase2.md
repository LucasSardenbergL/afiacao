# Spec — Trava de crédito Fase 2 (bloqueio com exceção aprovada) + hotfix Fase 1

> Item 4 do programa "back to basics" (Pernambucanas). Fase 1 (PR #1141) = alerta
> informativo no wizard. Fase 2 = **enforcement na fronteira comum** com exceção
> aprovada por gestor. Money-path: precisão > recall, ausente ≠ zero, gate na
> fronteira que TODA via cruza (money-path.md §5).

## 0. Achado que muda o desenho (verificado em prod via psql-ro, 2026-07-02)

**`fin_contas_receber.cnpj_cpf` está vazio nos 43.049 títulos** (o `ListarContasReceber`
do Omie não retorna o campo; o mapper grava `""`). **`omie_codigo_cliente` está 100%
populado** e nenhum código mapeia para 2 clientes dentro da mesma company.

Consequências:
1. **A Fase 1 em prod nunca dispara** (filtro `.in('cnpj_cpf', variantes)` casa 0 linhas).
   → hotfix: casar por par `(company, omie_codigo_cliente)`.
2. O gate da Fase 2 junta por código, não por CNPJ. O wizard conhece os códigos do
   cliente nas contas (`codigo_cliente` [oben], `codigo_cliente_colacor`,
   `codigo_cliente_afiacao` [colacor_sc]).

Impacto hoje (régua 60+): colacor 28 clientes/R$ 78,5k · oben 15/R$ 21,7k · colacor_sc 6/R$ 5,1k.

## 1. Critério (mesma régua da Fase 1 — não muda entre fases)

Bloqueável = soma de `saldo` > 0 dos títulos com `status_titulo IN OPEN_TITLE_STATUSES`
e `data_vencimento < hoje − 60 dias`, casados por `(company, omie_codigo_cliente)`.
Sem títulos vencidos 60+ → passa. Evidência positiva obrigatória.

## 2. Arquitetura em camadas

| Camada | O quê | Cobre |
|---|---|---|
| **Enforcement (server)** | Gate no edge `omie-vendas-sync`, actions `criar_pedido` (e `alterar_pedido`, ver §7) — chama RPC SQL antes de `criarPedidoVenda` | TODAS as vias (submit, conversão de orçamento, edição, retry) |
| Aviso (client) | Fase 1 corrigida (alerta no wizard) | UX cedo, não é proteção |

**Resolução do cliente:** o edge usa o `codigo_cliente` do payload + o `account` do
pedido — par mínimo garantido server-side (o client não consegue afrouxar). O payload
ganha campo opcional `codigos_grupo: [{company, codigo}]` (códigos das outras contas,
que o wizard conhece): códigos extras **só endurecem** o gate (mais títulos no
escopo); omiti-los mantém o mínimo da conta do pedido. Client malicioso não afrouxa.

**RPC `venda_gate_credito(p_pares jsonb)`** → retorna `{bloqueado, vencido, titulos,
vencimento_mais_antigo, excecao_id}`. SECURITY DEFINER + `SET search_path = public`,
EXECUTE **só service_role** (REVOKE anon, authenticated, PUBLIC) — o client nunca a
chama; o alerta client continua lendo `fin_contas_receber` direto sob RLS.
Lógica 100% em SQL = 1 fonte de verdade, provada no PG17 (sem espelho TS, sem canária).

## 3. Exceção aprovada (`venda_excecao_credito`)

- Colunas: `id`, `company` (check 3 empresas), `omie_codigo_cliente bigint`,
  `nome_cliente text` (denormalizado p/ leitura humana), `motivo text NOT NULL`
  (check não-vazio), `valido_ate timestamptz NOT NULL`, `aprovado_por uuid NOT NULL`
  (default `auth.uid()`), `created_at`. **Imutável** (sem UPDATE/DELETE policies —
  exceção errada expira ou é superada por outra).
- Validade default sugerida na UI: 7 dias (o gestor escolhe; teto 30d via CHECK).
- RLS: SELECT staff · INSERT **só gestor/master** (`pode_ver_carteira_completa(auth.uid())`
  — master OU commercial_role gerencial/estrategico/super_admin; fail-closed) ·
  service_role ALL.
- Gate: exceção válida = `valido_ate > now()` para o par → passa e loga o uso.

## 4. Log de bloqueio (`venda_bloqueio_credito_log`)

Escrito pelo edge (service_role): `company`, `omie_codigo_cliente`, `sales_order_id`,
`acao` (`bloqueado` | `liberado_excecao` | `gate_indisponivel`), `vencido numeric`,
`titulos int`, `user_id`, `excecao_id`, `created_at`. RLS: SELECT staff; INSERT
service_role. É a medição da fase (e evidência pro Painel Iceberg).

## 5. Threat-model (defaults — 1 assert PG17 para cada)

| Situação | Default | Racional |
|---|---|---|
| RPC erra (timeout, bug) | **ALLOW** + log `gate_indisponivel` | Disponibilidade de venda > enforcement; falha visível no log, nunca silenciosa |
| Código do cliente ausente/inválido no payload | ALLOW (o guard existente já exige `codigo_cliente` para criar) | Sem evidência não se acusa |
| Cliente sem nenhum título | ALLOW | Evidência positiva obrigatória |
| Exceção expirada | **BLOCK** | Validade é o contrato |
| Vendedor tenta INSERT exceção | **42501** (RLS) | Aprovação é do gestor |
| O que o gate NÃO prova | — | Exposição cross-empresa quando o client omite `codigos_grupo`; dado defasado do sync (alerta já expõe frescor) |

## 6. UI (toque mínimo no wizard quente)

- Submit → edge devolve **422 `{blocked: 'credito', vencido, titulos, ...}`** →
  dialog de bloqueio: valores + vencimento mais antigo.
- `isMaster || gestor` → form inline: motivo + validade → INSERT exceção → re-submit.
- Vendedor comum → botão "Pedir liberação" cria **tarefa** para o gestor (reuso
  `CriarTarefaDialog`) com o contexto no corpo.
- `track()`: `venda.bloqueio_credito_exibido`, `venda.excecao_credito_criada`,
  `venda.bloqueio_credito_liberado`.

## 7. Decisões em aberto (para o challenge do Codex)

1. **`alterar_pedido` também bloqueia?** Opções: (a) não bloqueia (pedido pré-existente;
   reduzir exposição deve ser possível); (b) bloqueia só se o total AUMENTA vs. o
   pedido atual (fecha o buraco "cria barato antes, engorda depois", mantém redução).
   Proposta: **(b)**.
2. Exceção por cliente+company (proposta) vs. por pedido específico.
3. Hotfix Fase 1 no mesmo PR ou separado (proposta: separado, valor imediato).

## 8. Prova (prove-sql-money-path, PG17)

Asserts: bloqueia 60+ · não bloqueia 59d · não bloqueia saldo 0 · status fora do
vocabulário não conta · exceção válida libera · exceção expirada bloqueia · par de
outra company não vaza · RLS: vendedor INSERT exceção → 42501 re-lançado, gestor passa ·
**falsificação**: sabotar a régua (60→6000) e exigir vermelho.

## 8b. UI da válvula — decisões forçadas por fatos de prod (2026-07-03)

- **Vendedor NÃO cria tarefa pro gestor** (plano original): a policy `tarefas_insert`
  exige `pode_ver_carteira_completa` — INSERT de tarefas é gestor-only POR DESENHO do
  domínio Tarefas (cobrança de vendedoras). Não afrouxar RLS de outro domínio pela
  válvula. Caminho do vendedor: `ExcecaoCreditoDialog` mostra QUEM aprova + botão
  "Copiar resumo pro gestor" (WhatsApp é o canal real do balcão). Se a telemetria
  (`venda.bloqueio_credito_resumo_copiado`) mostrar atrito, fase futura cria RPC
  SECURITY DEFINER dedicada para "pedir aprovação".
- **Lista de aprovadores visível ao vendedor = masters** (`user_roles` tem SELECT
  staff-wide) ∪ gestores que a RLS deixar ver — `commercial_roles` só expõe a PRÓPRIA
  linha a staff comum, então gestor comercial não-master não aparece pra vendedor.
  Cobre os aprovadores reais de hoje; ampliar = RPC futura (mesma da nota acima).
- **Aprovação remota**: o gestor abre o pedido em `/sales` → botão escudo no
  `SalesOrderDetailSheet` → o dialog resolve o contexto pelo último
  `venda_bloqueio_credito_log` do pedido (staff lê; evidência escrita pelo próprio
  gate — sem log de bloqueio, sem form: exceção às cegas não).
- **Exceção já válida**: o dialog mostra o estado e instrui o reenvio (não duplica
  aprovação). `valido_ate` client-side leva folga de 5min (CHECK de 30d compara com
  `created_at` forçado pelo servidor — clock skew do balcão violaria o teto).

## 9. Fora de escopo (fases seguintes)

Painel de exceções/bloqueios (ler via BI); notificação push ao gestor; recompute de
score; backfill de CNPJ nos títulos (se o Omie um dia mandar); RPC "pedir aprovação"
(tarefa do vendedor → gestor) e RPC de listagem ampla de aprovadores (ver §8b).

## 10. Veredito do challenge Codex (2026-07-02, 6 P1 + 4 P2 — TODOS acatados)

1. **Não confiar no `codigo_cliente`/`account` do payload** (forjável; account
   desconhecido silenciosamente vira oben): o gate deriva cliente/conta do
   `sales_orders` local + valida coerência com o payload; mismatch → rejeita.
2. **`codigos_grupo` client-side morre**: pares de grupo resolvidos SERVER-side via
   `omie_clientes` (user_id ↔ codigo ↔ empresa_omie), cobertura parcial mas
   não-contornável. Payload não carrega códigos de gate.
3. **`alterar_pedido` bloqueia só se o total AUMENTA, provado pelo `ConsultarPedido`
   do Omie** (que o fluxo já faz), gate ANTES da fase destrutiva (delete de itens);
   consult falhou + cliente bloqueável → rejeita a edição (não dá pra provar redução).
4. **Fail-open só depois de log durável**: allow em falha de RPC exige INSERT do
   `gate_indisponivel` bem-sucedido; se nem o log grava (DB unhealthy) → 503.
5. **`aprovado_por`/`created_at` forçados por trigger BEFORE INSERT** (não default) +
   `WITH CHECK` gestor + CHECK `valido_ate <= created_at + 30 dias`.
6. **Exceção é POR PEDIDO** (`sales_order_id NOT NULL` + snapshot `vencido_no_momento`),
   reuso só para retry idempotente do mesmo pedido. Cliente+company seria exposição
   ilimitada até expirar.
7. Corte de data em **fuso civil de São Paulo** no SQL: `((now() at time zone
   'America/Sao_Paulo')::date - 60)`.
8. Hotfix Fase 1 muda a API do hook para pares `(company, omie_codigo_cliente)`.
9. Vocabulário: contas de PEDIDO são só `oben|colacor` (edge `Account`); `colacor_sc`
   entra apenas como par de RECEBÍVEIS do grupo.
10. **Paridade TS↔SQL do vocabulário de status** (`OPEN_TITLE_STATUSES`): teste de
    paridade textual no vitest lendo a migration — sem drift silencioso.
11. Ordem: **hotfix Fase 1 em PR separado, primeiro** (valida o caminho por pares
    antes do enforcement).

## 11. Review adversarial final do diff (Codex, 2026-07-03) — 2 P1, ambos corrigidos

1. **[P1] Exceção vazava entre pares no MESMO pedido**: o gate casava a exceção só
   por `sales_order_id`; um invoke direto ao edge com o `codigo_cliente` de OUTRO
   cliente bloqueado reusaria a exceção. Fix: migration
   `20260703140000_trava_credito_gate_excecao_por_par.sql` (CREATE OR REPLACE — a
   20260702233000 é imutável) exige `company + omie_codigo_cliente` no match.
   Prova: assert A11b + falsificação F6/F7 (função pré-fix re-aplicada → A11b
   vermelho → fix restaurado → verde).
2. **[P1] Edição: ausência de cliente virava liberação**: `ConsultarPedido` sem
   `cabecalho.codigo_cliente` fazia o gate rodar com null → `sem_codigo` → aumento
   liberado por AUSÊNCIA de dado. Fix no edge: fallback de shape (cabecalho aninhado
   OU no topo, como o `det`) e, se o aumento está provado mas o cliente não é
   identificável → contrato do consult-falhou (fail-open SÓ com log durável
   `gate_indisponivel`; log falhou → erro).
3. **[P2 anotados, sem mudança]**: log de `bloqueado` é best-effort (o bloqueio em
   si nunca depende do log; sem log, o dialog remoto degrada para "sem bloqueio
   registrado") · pós-exceção na edição o usuário precisa salvar de novo (o toast
   de bloqueio da edição instrui explicitamente).
