# PR3 — Reconciliação humana de pedido disparado (design)

> Fecha o ciclo PR1→PR2→PR4. **Estado:** desenho aprovado pela realidade — os pedidos 281/286 já
> percorreram este caminho na mão em 2026-07-19 e provaram que a porta não existe.
> Contexto anterior: `2026-07-11-reposicao-reconciliacao-po-excluido-omie-design.md`.

## 1. O problema, provado em produção

Um pedido `disparado` pode divergir da realidade de duas formas, e o sistema não tem saída para
nenhuma das duas:

1. **O PO sumiu do Omie** (bug original: excluído direto lá). O PR2 detecta, o PR4 mostra.
2. **A compra deixou de existir no fornecedor** — o comprador confirmou e cancelou lá fora.

O card do PR4 instrui: *"confirme com o fornecedor que o pedido CONTINUA ativo; se ele disser que não
existe, foi cancelado ou já foi atendido, **PARE — não recrie**"*. Em 19/07 o founder percorreu
exatamente isso nos pedidos 281 e 286 (RENNER SAYERLACK, protocolos 2097501/2097910, ~R$3.060),
chegou no ramo do PARE — **e o sistema não tinha continuação**:

| Caminho | Por que não serve |
|---|---|
| `cancelar_pedido_sugerido()` | Guard explícito: `IF status IN ('disparado','concluido_recebido') THEN RETURN error`. Recusa por desenho. |
| Botão da UI | `PedidoRow.tsx:31` só libera `pendente_aprovacao`, `bloqueado_guardrail`, `aprovado_aguardando_disparo`. |
| `useDetalhesModal` (remover todos os itens) | Chega a `cancelado_humano`, mas grava a justificativa literal *"Todos os itens foram removidos manualmente"* — **registro falso**. O label do status é "Cancelado (vazio)". |

Saída real: `UPDATE` colado à mão no SQL Editor contornando o guard. Funciona, mas **só o founder+Claude
conseguem abrir essa porta**, e a evidência acaba em texto livre, sem trilha estruturada.

### O guard está CERTO e deve continuar

A trava existe porque a premissa "o fornecedor tem o pedido" é verdadeira na maioria dos casos — em
produção, **59/59 dos disparados têm canal de portal**, e o portal é acionado ANTES do PO existir no
Omie. Cancelar por automatismo faria o motor re-sugerir e **recomprar**. O PR3 não remove a trava:
abre uma porta ao lado, que exige um humano e uma evidência.

## 2. Decisão

**Reconciliação humana com evidência obrigatória. NUNCA auto-cancelamento.**

RPC `reposicao_reconciliar_pedido(p_pedido_id, p_desfecho, p_evidencia, p_po_novo)`.

### Desfechos (universo fechado)

| Desfecho | Efeito | Quando |
|---|---|---|
| `cancelado_no_fornecedor` | `status='cancelado_humano'` + higiene do portal (`status_envio_portal='nao_aplicavel'`, `portal_proximo_retry_em=NULL`) | O fornecedor confirmou que a compra não existe mais. **O caso 281/286.** |
| `po_recriado` | Atualiza `omie_pedido_compra_id` para o novo número; **mantém `disparado`** | O PO foi recriado no Omie sob outro número. |

Não existe desfecho "excluir", "ignorar" ou "arquivar": o universo é fechado e ambos deixam rastro.

## 3. Invariantes (o que provar no PG17, com falsificação)

1. **Evidência obrigatória e substantiva.** `p_evidencia` NULL, vazia ou com menos de N caracteres úteis
   → `RAISE` com SQLSTATE dedicada. Fail-closed: sem evidência não há reconciliação.
2. **Só entra pedido `disparado`.** Qualquer outro status → erro. É o espelho exato do guard de
   `cancelar_pedido_sugerido`, e a razão de ser uma função separada em vez de afrouxar aquela.
3. **Idempotência.** Reconciliar duas vezes não duplica efeito nem log — a 2ª chamada falha por (2),
   porque o status já mudou. Provar que falha, não presumir.
4. **Gate de escrita mais estrito que o de leitura.** Leitura (PR2) usa `pode_ver_carteira_completa`.
   Escrita exige `master` OU `employee` com commercial_role de gestor. ⚠️ **Tri-state:** `has_role`/
   `get_commercial_role` devolvem NULL para employee sem papel comercial — usar comparação POSITIVA
   explícita (`= TRUE` / `IN (...)`), nunca `NOT (...)`, que com NULL não barra. Foi o furo que quase
   passou no PR2 e só apareceu no teste O1.
5. **`po_recriado` valida o número novo:** não nulo, dígitos apenas, `≠` do antigo, dentro do range de
   bigint. Reaproveitar `reposicao__po_id()` do PR2 (já trata zeros à esquerda, overflow e whitespace
   unicode).
6. **Auditoria em tabela dedicada** `reposicao_reconciliacao_log`: pedido, desfecho, evidência, quem,
   quando, status anterior, PO anterior/novo, `run_id`. Append-only, RLS, sem UPDATE/DELETE.
   Coluna dedicada — **nunca** jsonb multi-writer (armadilha do upsert destrutivo).
7. **Uma reconciliação, uma transação.** Efeito no pedido + linha de log no mesmo commit; se o log
   falhar, o pedido não muda.

### Falsificações obrigatórias

Sabotar a migration e exigir vermelho em cada uma: evidência vazia aceita · status não-`disparado`
aceito · gate deixando employee sem papel passar · PO novo igual ao antigo · log não escrito ·
segunda chamada surtindo efeito.

## 4. UI (fatiada em PR separado)

Ação no card do PR4, disponível **apenas** com apuração fresca (nunca sobre lista desatualizada — o
PR4 já suprime instrução em estado velho). Diálogo exige a evidência por escrito antes de habilitar o
botão. A copy segue a regra do PR4: nunca insinuar que cancelar é o caminho natural.

## 5. Limitação conhecida (assumida, não resolvida)

**Corrida entre dois compradores.** A e B podem reconciliar o mesmo pedido quase ao mesmo tempo. O
invariante (2) fecha o caso sequencial — a segunda chamada falha porque o status já mudou. O que
permanece aberto é a ação **fora** do sistema (recriar o PO no Omie), que nenhuma trava daqui alcança.
Mitigação atual é social (a copy do PR4 manda avisar a equipe antes de agir). Fechar de verdade exigiria
claim/posse da linha — candidato a follow-up, fora do escopo deste PR.

## 6. Fatiamento

| PR | Conteúdo | Ritual |
|---|---|---|
| **3a** | Migration: tabela de log + RPC + gate | `prove-sql-money-path` (PG17 + falsificação) → Codex → SQL Editor |
| **3b** | UI: ação no card do PR4 | typecheck/test + Codex → Publish |

Separados porque 3a é escrita em money-path e merece prova isolada; 3b não pode existir sem 3a
aplicada em produção.
