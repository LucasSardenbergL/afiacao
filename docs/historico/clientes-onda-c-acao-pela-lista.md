# Clientes — onda C: agir pela lista, linha acessível, origem e lente na 360, sensor com denominador

> 2026-11-24 · `/admin/customers` e a 360 · só front + `db/` (query de leitura e prova PG17) · **Publish**.
> Sem migration e sem edge.

## O que entrou

| Item | Antes | Agora |
|---|---|---|
| 1. Agir pela lista | telefone como texto puro; prioridade sumia no celular | **Ligar** (`CallButton`) e **WhatsApp** na linha, sem abrir a ficha; na lente, o WhatsApp fica desligado (o ligar já era bloqueado na fonte). No celular, a nota aparece compacta na célula do nome |
| 2. Linha acessível | `<tr onClick>` | o nome é um `<Link>` real para a 360 (foco, Enter, Ctrl/Cmd+clique abre nova aba); o clique simples segue pelo `onSelect`, que guarda fila e rolagem. A linha continua clicável, mas ignora cliques que vêm de controles dela. J/K no registro de atalhos |
| 3. Pedido com o cliente | "Montar pedido" da fila (mix gap) abria `/sales/new` cru | `urlNovoPedido(cliente)`. **Já estavam certos na main** (confirmado por grep antes de mexer): "Novo pedido" da ficha antiga e `?customer=` do `/sales` (lido e na chave de cache) |
| 4. Origem | o voltar da 360 só conhecia a lista | `location.state.origemTela` (rótulo + URL interna validada), levado por carteira, positivação, agenda, telefonia, painel do farmer, mix gap e ficha da ligação. Passa pela ida e volta 360 → Cadastro (`repassarOrigem`). A fila da lista continua vencendo |
| 5. Lente na 360 | score lido pelo `user.id` do master; aliases do crédito e blocos por papel real; `listar_clientes_base` bloqueada | score por `effectiveUserId`, exibição por `useDisplayAccess`. Escrita (tarefa por voz) exige o papel real **e** o da persona. `listar_clientes_base` liberada na allowlist: é STABLE e SECURITY INVOKER, sem escrita no corpo (lido em prod via psql-ro) |
| 6. Desfecho | o menu aceitava um 2º desfecho com o 1º em voo; o sensor contava o toque | serializado **por cliente** em qualquer instância (`useIsMutating` + trava síncrona), com "Salvando…"; o sensor conta só no `onSuccess` |
| 7. Hero | `size="sm"` fixo; emoji no botão de voz | `touch` no celular, ícone `Mic`, atalho **L** (aciona o botão Ligar real, que respeita lente e telefone inválido) |
| 8. Sensor | a 360 não emitia ligar, pedido nem ver pedidos; denominador único | tentativa e sucesso separados (`fase`). Sucesso = ligação atendida, **pedido enviado** (no `UnifiedOrder`, pelo `state` da navegação) e **feed do cliente lido** (no `/sales`). `abrir_cadastro` ganhou emissor. A query passou a ter denominador **por superfície** (lista, 360, Cadastro) **e por papel comercial**, mais a régua "N de M dias úteis" e o funil |

## Decisões e achados

- **Desfecho na cobertura: fica fora, por desenho.** A regra é "cobertura lê, não age" (`docs/agent/database.md` §4, confirmada pela onda D e pelo challenge do Codex). `private.clientes_para_agir` / `public.pode_agir_no_cliente` exigem a atribuição elegível do próprio usuário na raiz fiscal. A cobertura só entra em `cliente_contato_visivel`, que é leitura de contato. O PG17 da onda D trava isso: A8 (cobertura → pode_agir=false) e W3 (cobertura → `venda_registrar_contato` 42501). Fazer a cobertura registrar desfecho seria decisão de produto nova, incluindo quem vira o `farmer_user_id` do contato.
- **A rota canônica da 360 é `/admin/customers/:id/:id`.** A máscara de `analytics-rota-canonica.ts` trata segmento só de dígitos ("360") como identificador. A query aceita as duas formas.
- **`ficha_acao` legado** (antes da onda C) não tem `fase` nem a superfície `lista` → conta como `tentativa`. O desfecho da 360 antes da onda C era o toque.
- O `not.toThrow()` de `agenda.test.ts` já tinha sido trocado pela onda A (#4146). Não mexi.

## Prova

- vitest: `lib/nav` (origem, rótulo, sensor com fase e destino), `lens-write-guard` (libera por nome exato, irmã fictícia segue barrada), lista (link, Ctrl+clique, J/K, ações, lente, nota compacta), `BotoesContato` (2º toque e 2ª instância não gravam, falha não conta), 360 na lente (score pela persona, voltar pela origem).
- PG17: `db/test-analytics-ledger-clientes.sh` (no núcleo do CI) e o gêmeo `-ficha`, com asserções novas de superfície, papel comercial, denominador NULL (nunca 0/100%), funil e régua.
- `db/sensor-clientes-adocao.sql` rodou em prod (psql-ro, `FIM_ADOCAO_OK`).

## Como medir (depois do Publish, dentro dos ~7 dias de retenção)

```bash
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sensor-clientes-adocao.sql
```
