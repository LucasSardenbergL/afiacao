# PR-4 Canal WhatsApp — Proposta 1-toque (design)

> Fatia 4/6 do programa Canal WhatsApp (benchmark Lu/Magalu, parecer Codex 2026-07-12).
> Handoff determinístico da sessão anterior; decisões do bloco 4 do handoff NÃO re-litigadas aqui.
> Docs-mãe: `docs/historico/programa-canal-whatsapp.md` · spec §4–6 de `2026-05-28-whatsapp-ia-orcamento-design.md` · `docs/agent/money-path.md`.

## Objetivo (UMA entrega)

A vendedora envia a cesta de recompra de um cliente da fila `/rota/propostas` pela conversa
WhatsApp via template HSM (`colacor_proposta_recompra`), com **recotação Omie no momento do
envio** — linha sem preço/estoque/unidade/prazo **trava a proposta inteira** (ausente ≠ zero,
nunca fabricar número) — gravando o **elo** `sales_orders.whatsapp_conversation_id` que tira o
funil do PR-3 do zero. Humano decide enviar; nada automático (disparo por rota = PR-6).

## Fluxo (recotação → travas → envio → elo)

```
RotaPropostas (card do cliente, preview já aberto)
  └─ clique "Cotar & revisar"
       ├─ RPC get_whatsapp_proposta_cotacao(customer, account, skus da cesta+cross-sell)
       │    → por SKU: preco (praticado ▸ tabela ▸ NULL), fonte_preco, estoque, unidade, ativo…
       ├─ helper puro avalia TRAVAS (linha e gerais) + total (NULL se travada)
       └─ painel: linhas cotadas, badges de trava, total, RENDER FIEL da mensagem
  └─ clique "Enviar via WhatsApp" (desabilitado se travada)
       ├─ edge whatsapp-send-template (dedupe-first `proposta:{customer}:{routeDate}`,
       │    origem='proposta', opt-out/template-inativo enforced NA EDGE — caminho único de envio)
       └─ sucesso → INSERT sales_orders status='orcamento' com itens RECOTADOS
            + whatsapp_conversation_id (retornado pela edge) ← O ELO
```

Conversão posterior (fluxo EXISTENTE `SalesQuotes.convertToOrder`) atualiza o MESMO registro →
`omie_pedido_id` chega ao row com o elo → funil conta proposta→pedido sem heurística.

## Decisões de desenho (e por quê)

1. **Recotação numa RPC SQL** (`SECURITY INVOKER`, `SET search_path public`, REVOKE anon por
   nome — padrão PR-2/3). Fonte de preço = regra provada do app (`mergeCustomerPrices`):
   último `order_items.unit_price` VÁLIDO do próprio cliente vence; `omie_products.valor_unitario`
   válido preenche gap; nenhum válido → `preco NULL` + `fonte_preco NULL`. Válido em SQL =
   `> 0 AND <> 'NaN'::numeric AND < 'Infinity'::numeric` (em Postgres `NaN > 0` é TRUE — o
   predicado ingênuo vazaria NaN). RLS morde nas bases: não-staff não enxerga `order_items` de
   terceiro → o "praticado" de outro cliente NÃO vaza (assert na prova).
2. **Travas fail-closed** (helper TS puro, testado):
   - por linha: `sem_preco` · `sem_estoque_info` (estoque NULL = desconhecido, não zero) ·
     `estoque_insuficiente` (estoque < qtd sugerida) · `sem_unidade` · `inativo` ·
     `nao_encontrado` (SKU fora do catálogo da conta);
   - gerais: `sem_prazo` (sem data de entrega derivável da rota) · `sem_nome` ({{1}} vazio a
     edge rejeita) · `sem_telefone`;
   - QUALQUER trava de linha na cesta (principal+secundários enviados) → proposta inteira
     travada; total = NULL (nunca soma parcial).
   - **Cross-sell é recomendação, não promessa**: item de cross-sell indisponível (inativo/sem
     estoque) é REMOVIDO da mensagem com aviso na UI — não trava a cesta. Não cita preço, não
     entra no orçamento (sem qtd) — nada fabricado.
3. **Prazo de entrega {{2}}**: `routeDate` (D+1 da rota) ou, em dia só-diárias, amanhã
   (`dailyOnly` — a diária entrega todo dia). Não derivável → trava `sem_prazo`. Formato
   "amanhã (DD/MM)" — helper puro.
4. **Params do template** ({{1}} nome, {{2}} prazo, {{3}} cesta compacta "2× LIXA…; 1× …;
   sugestão: …"). O {{3}} NÃO é o texto do preview (que tem saudação própria — duplicaria o
   "Olá" do template). A UI mostra o render fiel (corpo_referencia + params, mesma regra da
   edge) — a vendedora aprova EXATAMENTE o que sai.
5. **Elo gravado no fluxo da proposta, 1 writer** (decisão PR-3): INSERT de `sales_orders`
   `status='orcamento'` com payload IGUAL ao `submitQuote` (product_id, omie_codigo_produto,
   codigo, descricao, unidade, quantidade, valor_unitario, valor_total) + `customer_document`
   (cnpj/document do profile — âncora P0-B da conversão) + `whatsapp_conversation_id`.
   Preços do orçamento = recotados agora (jamais `ultimoPrecoRef` da cesta, que é debug).
6. **Idempotência**: dedupe_key determinística por cliente×rota. 2º clique → 409 da edge →
   UI explica. Órfã (enviou mas não gravou orçamento): no 409, o service resolve a conversa
   pela dedupe_key e grava o orçamento SE ainda não existe (auto-conserto, sem re-enviar).
7. **Envio SÓ pela edge existente** — dedupe/opt-out/gate provados no PR-1; nenhum caminho
   paralelo. Edge NÃO muda neste PR (deploy de edge fora do checklist).
8. **Rollout gated**: kill-switch global já existe (`whatsapp_templates.ativo=false` → edge 409);
   piloto 1 rota × 1 vendedora × 1 CNPJ é operacional (founder instrui), sem flag nova.

## O que NÃO entra (escopo)

- Disparo automático por rota (PR-6) · status transacional (PR-5) · qualquer mudança na edge ·
  Pix/checkout in-chat (cortado) · flag de rollout nova · precificação por tier/volume (a fonte
  é a regra praticado▸tabela já provada do app; tier entra se o founder pedir).

## Arquivos

| Ação | Caminho |
|---|---|
| novo | `supabase/migrations/20260713040000_whatsapp_proposta_cotacao.sql` (RPC) |
| novo | `db/test-whatsapp-proposta.sh` (prova PG17 + falsificação) |
| novo | `src/lib/whatsapp/proposta-cotacao.ts` (+ `.test.ts`) — travas + params + prazo |
| novo | `src/services/whatsappProposta/enviarProposta.ts` (+ index + testes) — orquestração |
| muda | `src/queries/usePropostaPreview.ts` — expõe cesta estruturada + nomes + cross-sell c/ SKU |
| muda | `src/pages/RotaPropostas.tsx` — botão Cotar & revisar → painel → Enviar |

## Validação (prova da entrega)

- PG17 novo com FALSIFICAÇÃO no risco de negócio: sabotar a RPC com `COALESCE(preco, 0)`
  (fabricar zero) → assert `preco IS NULL` TEM de ficar vermelho; e sabotar o filtro de validade
  (praticado 0 vence) → vermelho. RLS sob `SET ROLE` (staff/não-staff/anon 42501).
- 3 provas existentes verdes (`test-whatsapp-hsm` · `test-whatsapp-pendentes` · `test-whatsapp-funil`).
- vitest: travas (cada motivo), NULL nunca vira 0, total NULL se travada, service não envia
  travada / não grava sem envio / 409 não duplica orçamento.
- `heavy bun run typecheck` · `heavy bun lint` · `heavy bun run test`.
- Codex adversarial no diff (background; cota esgotada → Caminho B registrado).
- Pós-merge (founder): migrations (040000 + 050000, em ordem) no SQL Editor → Publish. Edge
  NÃO muda. Envio real espera Meta aprovar o template (`ativo=true`).

## Adendo — challenge adversarial do Codex (2026-07-13, gpt-5.6-sol xhigh; cru preservado na sessão)

Parecer inicial: **NÃO APROVAR** (3 P0 · 7 P1 · 3 P2). Acatados e corrigidos NA HORA (migration
`20260713050000_whatsapp_proposta_cotacao_v2.sql` — a 040000 é imutável por política do repo):

- **P0-1** praticado atravessava CONTAS → `JOIN sales_orders` + `so.account = p_account`
  (falsificação C: re-aplicar a 040000 deixa o assert cross-conta vermelho).
- **P0-2** qtd 0/NaN e estoque NaN/Inf passavam → travas `qtd_invalida`/`sem_estoque_info`
  endurecidas + total finito>0 + revalidação independente no service (defesa em profundidade).
- **P0-3** idempotência do orçamento não segurava concorrência → `whatsapp_proposta_dedupe`
  UNIQUE parcial em `sales_orders`; INSERT atômico (23505 → reusar). Mata 2-abas, convertido
  e janela de 24h.
- **P1-4** 409 com send `queued` não é "já enviada" → erro `envio_em_andamento`.
- **P1-5 (mínimo)** orçamento pós-retry ganha nota explícita (a mensagem não cita preços).
- **P1-6** janela cotar→enviar ilimitada → snapshot imutável da revisão + TTL 10min.
- **P1-7 (mínimo)** conversa de OUTRO cliente no telefone → trava `conversa_de_outro_cliente`
  (checagem client no cotar; binding server-side fica pro PR-6, edge intocada por decisão).
- **P1-9** template ilegível não travava → `template_indisponivel`/`template_inativo` no
  avaliador; o render nasce no helper puro (a UI mostra exatamente o que sai).
- **P1-10** `created_at NULL` decidia por id → cronologia comercial `COALESCE(oi, so)`.
- **P2-11** limite Meta → trava `mensagem_longa` (>1024, sem truncar). **P2-13** lente
  "Ver como" → botões desabilitados + catch.

**Débito declarado (v2/PR-6, decisão de escopo minha):** P1-8 fronteira server-side da
proposta com carteira + `created_by=auth.uid()` (a superfície é a MESMA do `submitQuote`
atual — não é regressão deste PR; o motor de disparo do PR-6 é o lugar natural);
P1-5 completo (snapshot imutável da cotação indexado pelo dedupe); P1-7 completo (binding
cliente↔conversa na edge); P2-12 (bigint>2^53 — códigos Omie atuais longe do limite).
