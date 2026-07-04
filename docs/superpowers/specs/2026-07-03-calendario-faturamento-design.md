# Spec — Visão de calendário de faturamento (pedidos programados)

**Data:** 2026-07-03 · **Status:** aprovada pelo founder · **Escopo:** só frontend (leitura)
**Origem:** pedido do founder + consulta convergente Codex (gpt-5.5, reasoning high) × Gemini — os dois recomendaram a MESMA arquitetura em todos os pontos (grade própria, agregação no cliente, contar envios, painel lateral, toggle na página).

## Problema e usos confirmados

O founder quer ver num calendário mensal o que será faturado por dia via pedidos programados. Usos (os três confirmados por ele):

1. **Cobertura futura** — de relance, quais dias têm envio agendado e quais estão vazios.
2. **Carga em R$ por dia** — soma dos envios do dia.
3. **Histórico e erros** — em dias passados, o que saiu e o que falhou; erro precisa chamar atenção.

## Decisões de produto

| # | Decisão | Escolha (founder) |
|---|---|---|
| 1 | Escopo dos dados | **Só envios de pedidos programados** (`pedidos_programados_envios`). Pedidos de venda avulsos ficam fora. |
| 2 | Métrica da célula | Contar **envios** (a entidade que ele agenda). "Vira N pedido(s): Oben, Colacor" aparece só no painel — o pedido ERP não existe antes do cron; não prometer o que ainda não é. |
| 3 | Clique no dia | Painel lateral (`Sheet` shadcn) **só visualização + link** "Abrir pedido" para `/sales/programados/:pedido_id`. Ações (Enviar agora/Cancelar) continuam no detalhe. |
| 4 | Localização | Toggle **Lista \| Calendário** dentro de `/sales/programados`, com `view` e `mes` na URL via `useUrlState` (a página hoje não usa o hook — o toggle o introduz). |
| 5 | Grade | Própria (CSS grid 7 colunas + date-fns), semana **dom→sáb**, **6 linhas fixas** (altura estável ao navegar). Descartados: react-day-picker custom (é date picker, briga com célula rica), FullCalendar (peso desnecessário), página separada, view/RPC SQL (volume minúsculo). |
| 6 | Envios cancelados | Fora da contagem e da soma da célula; visíveis no painel com badge cinza. |
| 7 | v2 (fora de escopo) | Botão "+" para agendar de um dia vazio; filtros por empresa; ações no painel; visão semanal; export. |

## Arquitetura

Sem migration, sem edge, sem mudança de banco — feature 100% de leitura no frontend.

### Dados — 1 query por mês visível

Hook novo `usePedidosProgramadosCalendario(mes: string /* 'YYYY-MM' */)` em `src/hooks/usePedidosProgramados.ts`:

```ts
queryKey: ['pedidos-programados', 'calendario', mes]
// prefixo 'pedidos-programados' → invalidação AUTOMÁTICA pelas mutations
// existentes (invalidarPedidos já faz qc.invalidateQueries({queryKey: ['pedidos-programados']}))

supabase.from('pedidos_programados_envios')
  .select(`id, pedido_id, data_envio, status, erro_motivo,
    pedido:pedidos_programados(id, numero_pedido_compra),
    itens:pedidos_programados_itens(quantidade, preco_final,
      mapa:cliente_item_mapa(omie_products(account)))`)
  .gte('data_envio', `${mes}-01`)
  .lte('data_envio', fimDoMes /* endOfMonth via date-fns, 'yyyy-MM-dd' */)
  .order('data_envio', { ascending: true })
```

- `placeholderData: keepPreviousData` para navegação suave entre meses; `staleTime` padrão do app (60s).
- **Guard de truncamento:** se a resposta tiver exatamente 1.000 linhas (capa silenciosa do PostgREST), exibir aviso "mês truncado" na UI. Hoje é impossível no volume, mas a regra do repo é nunca confiar na capa em silêncio.
- Conversão `Number()` na borda (padrão do hook existente para numerics do PostgREST).

### Agregação — helper puro testável

`src/lib/pedidosProgramados/calendario.ts` (novo, zero imports pesados; testes vitest ao lado). **Não precisa de espelho em edge** — só o front consome.

```
agruparEnviosPorDia(envios) → Map<string /* 'YYYY-MM-DD' */, DiaAgregado>
DiaAgregado = {
  envios: EnvioCalendario[],        // todos, inclusive cancelados (para o painel)
  ativos: number,                   // count status !== 'cancelado'
  totalValor: number | null,        // soma dos envios ativos; null se algum for null
  temErro: boolean,                 // algum status === 'erro'
  statusPresentes: Set<status>,     // para os dots (sem 'cancelado')
}
```

Regras do helper (money-path):

- **Chave do dia = a string `data_envio` como veio** — nunca `new Date('YYYY-MM-DD')` (shift de fuso).
- Valor do envio = `Σ preco_final × quantidade` dos itens. Se **qualquer** item tiver `preco_final === null` → valor do envio = `null` → `totalValor` do dia = `null` (propaga; **ausente ≠ zero**). UI mostra "—" na célula e "valor incompleto" no painel. (O guard de criação de envio impede esse estado; isto é defense-in-depth.)
- **Envio sem itens** (estado anômalo — criação exige seleção): valor `null` + badge "sem itens" no painel. Soma vazia = 0 seria número fabricado para um estado quebrado; precisão > recall.
- Empresas do envio = set dos `account` dos itens via `mapa.omie_products.account`; item sem mapa não quebra (ignora no set).
- Cancelado: excluído de `ativos`, `totalValor` e `statusPresentes`; mantido em `envios`.

## UI

### Toggle na lista (`src/pages/PedidosProgramados.tsx`)

`useUrlState({ view: 'lista', mes: '' })`. `view === 'calendario'` renderiza `<CalendarioFaturamento/>` no lugar da lista; `mes` vazio = mês atual (computado localmente, só entra na URL ao navegar). URL compartilhável: `/sales/programados?view=calendario&mes=2026-07`.

### `src/components/pedidosProgramados/CalendarioFaturamento.tsx` (novo)

- **Header:** ← / → (mês anterior/seguinte), título "julho 2026" (`format(..., 'MMMM yyyy', { locale: ptBR })`), botão "Hoje" (limpa `mes`), legenda de dots (agendado/enviado/erro).
- **Grade:** CSS grid `grid-cols-7`, cabeçalho dom…sáb, **42 células** (6 semanas fixas, `startOfWeek` com `weekStartsOn: 0`). Dias gerados com date-fns em horário local; chave/lookup por `format(d, 'yyyy-MM-dd')`.
- **Célula (dia do mês, com envios):** `<button>` real — nº do dia no topo (hoje = pill accent), linha "N envio(s)" onde **N = `ativos`** (cancelados não contam), valor em `tabular-nums` text-muted-foreground, dots de status no rodapé. `aria-label` completo ("quinta, 16 de julho — 2 envios, R$ 18.420"). Altura mínima ~76px (≥44px touch de graça).
- **Dia com erro:** borda + fundo `--status-error` sutis + ícone alerta — vence a hierarquia visual mesmo em dia passado.
- **Dia fora do mês:** número dimmed, sem dados, não clicável. **Dia vazio do mês:** só o número, não clicável. **Dia com apenas envios cancelados:** tratado como vazio (cancelado não é "para faturar"); os cancelados de um dia só aparecem no painel quando o dia também tem envio ativo — no calendário eles não têm porta de entrada própria (continuam visíveis no detalhe do pedido).
- **Tokens:** `text-status-info/success/error` (regra do repo — nada de cor crua); dark mode via tokens; reutilizar o mapeamento visual de status do detalhe (`ENVIO_STATUS_CLS`).
- **Mês sem envios:** grade permanece + linha discreta "Nenhum envio em <mês>" (não é EmptyState de página).

### Painel do dia (`Sheet` shadcn, lado direito)

Título "qui, 16 de julho · N envios · R$ X". Por envio: PC (`numero_pedido_compra` — se null, "PC —"), badge de status (paleta do detalhe), "N itens · vira N pedido(s): Oben, Colacor", valor (ou "valor incompleto"), `erro_motivo` quando status erro, link "Abrir pedido" → detalhe. Cancelados no fim, badge cinza. **Sem ações** (decisão #3).

## Formatação de datas (regra transversal)

- Agrupar/comparar por **string** `YYYY-MM-DD`; para exibir, o padrão do repo `new Date(\`${d}T12:00:00\`)` (já usado em `fmtData` do detalhe).
- "Hoje" = data local do navegador via `format(new Date(), 'yyyy-MM-dd')` (date-fns é local-time).

## Testes

- **vitest no helper** (`calendario.test.ts`): agrupamento por dia; propagação de `null` (1 item sem preço → dia "—"); exclusão de cancelado da soma/contagem mas presença na lista; set de empresas (incl. item sem mapa); envio sem itens → `null`; `temErro`; dia com só cancelados → célula sem conteúdo ativo.
- UI: verificação manual no ensaio (sem E2E).

## Deploy

Só frontend: merge → Publish no Lovable → `scripts/verify-frontend.sh` com um ALVO do componente novo. Sem migration, sem edge.

## Pendências

Nenhuma aberta. (Ideias v2 na decisão #7.)
