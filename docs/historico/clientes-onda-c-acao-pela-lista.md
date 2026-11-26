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
| 5. Lente na 360 | aliases do crédito e blocos pelo papel REAL do master; `listar_clientes_base` bloqueada | exibição por `useDisplayAccess` (o score dispensou a lente: desde a onda B ele é do cliente, `UNIQUE(customer_user_id)`). Escrita (tarefa por voz) exige o papel real **e** o da persona. `listar_clientes_base` liberada na allowlist: é STABLE e SECURITY INVOKER, sem escrita no corpo (lido em prod via psql-ro) |
| 6. Desfecho | o menu aceitava um 2º desfecho com o 1º em voo; o sensor contava o toque | serializado **por cliente** em qualquer instância (`useIsMutating` + trava síncrona), com "Salvando…"; o sensor conta só no `onSuccess` |
| 7. Hero | `size="sm"` fixo; emoji no botão de voz | `touch` no celular, ícone `Mic`, atalho **L** (aciona o botão Ligar real, que respeita lente e telefone inválido) |
| 8. Sensor | a 360 não emitia ligar, pedido nem ver pedidos; denominador único | tentativa e sucesso separados (`fase`). Sucesso = ligação atendida, **pedido enviado** (no `UnifiedOrder`, pelo `state` da navegação) e **feed do cliente lido** (no `/sales`). `abrir_cadastro` ganhou emissor. A query passou a ter denominador **por superfície** (lista, 360, Cadastro) **e por papel comercial**, mais a régua "N de M dias úteis" e o funil |

## Decisões e achados

- **Desfecho na cobertura: fica fora, por desenho.** A regra é "cobertura lê, não age" (`docs/agent/database.md` §4, confirmada pela onda D e pelo challenge do Codex). `private.clientes_para_agir` / `public.pode_agir_no_cliente` exigem a atribuição elegível do próprio usuário na raiz fiscal. A cobertura só entra em `cliente_contato_visivel`, que é leitura de contato. O PG17 da onda D trava isso: A8 (cobertura → pode_agir=false) e W3 (cobertura → `venda_registrar_contato` 42501). Fazer a cobertura registrar desfecho seria decisão de produto nova, incluindo quem vira o `farmer_user_id` do contato.
- **Merges com as ondas B, D e E** (mergearam antes): último contato com `estadoDe`/`contexto` por cliente (E/B), `ehPj` e `pode_agir_no_cliente` (D), estados de leitura de contato/endereço (B). A aresta `CustomerListView → CallButton` (admin-crm → telefonia) entrou na baseline de fronteira de propósito — é a mesma do `Customer360View`.
- **A rota canônica da 360 é `/admin/customers/:id/:id`.** A máscara de `analytics-rota-canonica.ts` trata segmento só de dígitos ("360") como identificador. A query aceita as duas formas.
- **`ficha_acao` legado** (antes da onda C) não tem `fase` nem a superfície `lista` → conta como `tentativa`. O desfecho da 360 antes da onda C era o toque.
- O `not.toThrow()` de `agenda.test.ts` já tinha sido trocado pela onda A (#4146). Não mexi.

## Prova

- vitest: `lib/nav` (origem, rótulo, sensor com fase e destino), `lens-write-guard` (libera por nome exato, irmã fictícia segue barrada), lista (link, Ctrl+clique, J/K, ações, lente, nota compacta), `BotoesContato` (2º toque e 2ª instância não gravam, falha não conta), 360 na lente (blocos pela persona, tarefa por voz exige os dois papéis, voltar pela origem).
- PG17: `db/test-analytics-ledger-clientes.sh` (no núcleo do CI) e o gêmeo `-ficha`, com asserções novas de superfície, papel comercial, denominador NULL (nunca 0/100%), funil e régua.
- `db/sensor-clientes-adocao.sql` rodou em prod (psql-ro, `FIM_ADOCAO_OK`).

## Como medir (depois do Publish, dentro dos ~7 dias de retenção)

```bash
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sensor-clientes-adocao.sql
```

## Seguimento (2026-11-24): a11y medida em prod e empresa na tarefa por voz

**Auditoria nas duas telas, nos dois temas**, na sessão logada (navegador do app). O `axe` não rodou:
injetar script de CDN na sessão logada foi recusado pela permissão. No lugar, uma leitura só do DOM
mediu nomes acessíveis, ids duplicados, `lang`/`h1` e o contraste WCAG de cada nó de texto (cor × fundo
efetivo). Na lista, no escuro, foram 607 nós medidos.

| Achado | Onde | Antes | Agora |
|---|---|---|---|
| selo de saúde (Estável/Atenção/Saudável) | lista e 360 | 2,25–3,30:1 (`text-status-*-bold` sobre `-bg`) | `-foreground`: 6,2–8,2:1 no claro, 10,8–11,4:1 no escuro |
| chips do hero (churn, margem), status de pedido, "Nenhum título vencido" | 360 | 2,25–4,04:1 | mesma troca (`format.ts`, `ActivityColumn`, `components.tsx`, `AcoesDaFicha`) |
| botão da conta (ícone `User`) sem nome | topo do app | sem nome acessível | `aria-label="Menu da conta"` |
| tema escuro | lista e 360 | 0 violações de contraste | — |

**Fica de fora, de propósito:** o cabeçalho da tabela em `text-muted-foreground` dá 4,35:1, logo abaixo
de 4,5. É o token GLOBAL do design system e pede decisão de DS, não um remendo nesta tela. O `-bold`
continua certo para fundo e ícone (é o que ele é); o erro era usá-lo como cor de TEXTO pequeno.

**Tarefa por voz da 360 (pedido da onda B):** o `VozTarefaDialog` recebia `empresa="oben"` fixo. Agora
segue o `CriarTarefaDialog`: com a empresa comprovada, usa ela; quando é ambígua, não tem dado ou a
leitura falhou, mostra o seletor (`voz-escolher-empresa`) com o motivo e trava o salvar até a escolha. A
escolha vale também para os cards detectados antes dela. Falsificado: voltar ao "oben" e tirar o
seletor deixa 2 de 3 vermelhos, e o controle fica verde.

## Seguimento (2026-11-26): 2ª medição de a11y em prod, depois da onda D fatia 3

Mesma leitura do DOM da rodada anterior: o `axe` por CDN foi recusado de novo pela permissão. As medições foram
feitas na lista e na 360, nos dois temas, logado como master, no build `9efe21ae`. Passaram: nome acessível,
ids duplicados, `lang`, `h1` e `alt`. O contraste reprovou em 5 pontos, e 3 deles estão no shell, fora da tela:

| Achado | Onde | Antes | Agora |
|---|---|---|---|
| dias sem compra > 30 | lista | 3,06:1 (`text-status-warning`) | `-foreground`: 6,76:1 claro · 12,85:1 escuro |
| "0–100" da nota | 360 (`components.tsx`) | 2,71:1 claro · 3,78:1 escuro (`muted-foreground/70`) | sem o `/70`: 4,76 · 6,44 |
| títulos das seções do menu | shell, claro | 2,79:1 (`--sidebar-muted` 60%) | token em 45%: 4,66:1 |
| letra do monograma da empresa | shell, escuro | 1,12:1 no "C" (branco sobre 95%) | token `--company-monograma-texto` (escuro no dark): C 16,1 · Oben 5,7 · SC 8,3 |
| selo vermelho de contagem e os 16 usos de `bg-destructive` | shell, escuro | 3,82:1 (branco sobre `0 70% 60%`) | `--destructive-foreground` 6% no dark: 5,01:1 |

O "0 violações no escuro" da rodada anterior mediu só o conteúdo da tela, não o topo e o menu. O
`html.legacy-visual` tem o mesmo defeito no `--sidebar-muted` (4,02:1), mas ficou de fora por ser o visual
antigo. A conta das razões está no #4209.

**Re-medição em prod depois do Publish** (build `94d09707`, 1280 px, logado como master), mesma leitura do DOM:
- lista: 0 falhas em 183 textos no claro (eram 15) e 0 em 183 no escuro (eram 3);
- 360: 0 em 247 no claro (eram 13) e 0 em 251 no escuro (eram 5).

As células de 35, 37 e 50 dias, o "0–100" e os selos "63" e "448" estavam na tela, então o zero não é falta de dado. A largura conta: no painel estreito (533 px) o menu some e a medição pula os títulos das seções.
