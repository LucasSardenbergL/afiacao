# Plano — Etapa 2: identidade de cliente por-conta confiável + tri-state

**Pré-req:** [spec](../specs/2026-06-06-preco-realtime-selectCustomer-design.md) · Etapa 1 (PR #656) no ar.
**Status:** rascunho — **aguarda challenge do Codex** (cota reseta ~12:56) antes de implementar (money-path).
**Objetivo:** tornar a identidade do cliente por-conta (oben/colacor/afiação) **confiável e tri-state**, base para a Etapa 3 (submit fail-closed) sem risco de pedido na conta errada nem cliente duplicado.

## Problema que resolve
Hoje o lookup de cliente colapsa **erro** e **ausência** no mesmo `null` (`getResult` no frontend; `callOmieVendasApi`→null; `omie-sync` retorna 200 com `codigo_cliente:null`). Consequências:
- Erro transitório do Omie (Colacor) vira "ausente" → `IncluirCliente` cria **duplicado**.
- O submit faz fallback pro código oben quando o por-conta falta → **pedido na conta errada**.

## Mudanças (todas money-path → Codex challenge antes de implementar; deploy de edge via Lovable)

### 2.1 — Lookup tri-state no edge
- `buscarClienteVendas` (omie-vendas-sync) e `buscar_cliente_por_documento` (omie-sync): retornar discriminador
  `{ status: 'found'|'absent'|'error', codigo_cliente?, codigo_vendedor? }`.
- Distinguir na origem: `callOmieVendasApi`/`callOmieApi` precisa **lançar** em erro/fault (após retries) em vez de retornar `null`; "lista vazia limpa" = `absent`; exceção/fault = `error`.
- Contrato HTTP segue 200 (o discriminador vai no corpo) → o `Promise.allSettled` do frontend continua tolerante.

### 2.2 — `ensure_cliente` idempotente (substitui `criar_cliente`/`criar_cliente_afiacao` no caminho de ensure)
- Uma action por conta: lookup por documento → `found`→retorna código; `absent`→cria; `error`→**não cria**, retorna `error`.
- **Código de integração determinístico** `APP_<doc>` (não `APP_<doc>_<Date.now()>`) → retry/concorrência dedupe (Omie rejeita integração duplicada → tratar "duplicado" como `found`).
- Idempotência validada: 2 ensures concorrentes do mesmo doc ⇒ no máximo 1 cliente.

### 2.3 — Preço/parcela Colacor com o código certo
- Hoje `buscar_precos_cliente`/`buscar_ultima_parcela` colacor recebem o código **oben** → resultado errado.
- **Decisão:** entregar junto da action consolidada da Etapa 4 (`contexto_comercial_cliente`, que recebe `document`, resolve o código por-conta internamente e devolve preços+parcela numa `ListarPedidos`). Evita patchar as actions antigas 2×. Se precisar antes, fix mínimo = frontend sequencia (lookup colacor → preço/parcela com o código colacor), com custo de +1 hop serial no colacor.

### 2.4 — Frontend: fiação tri-state
- `getResult` para de colapsar erro/ausência; rastrear status por-conta.
- Auto-cadastro (→ `ensure_cliente`) só em `absent`. Em `error`, marcar identidade-desconhecida da conta (consumido pela Etapa 3).

## Testes (TDD, helper puro espelhado no edge — padrão do repo)
- Classificador de resposta Omie: fault/exception→`error`; `clientes_cadastro:[]`→`absent`; com cliente→`found` (+ código). Casos: faultstring presente; HTTP ok com array vazio; null cru; retry esgotado.
- `ensure`: found→não cria; absent→cria 1×; 2 concorrentes→1; error→0 criações.

## Validação (sem terminal de backend; deploy+smoke via Lovable)
- Bloquear request do `omie-sync` (DevTools): lookup deve voltar `status:'error'`, **zero** criação.
- Cliente novo de verdade: exatamente 1 criação; re-selecionar não cria 2º.
- Erro transitório simulado no Colacor: nenhuma duplicata.

## Sequência de deploy (founder)
1. Edge `omie-vendas-sync` + `omie-sync` (verbatim da main) via chat do Lovable.
2. Smoke dos 3 casos acima no preview.
3. Só então a Etapa 3 (submit fail-closed) pode assumir identidade confiável.

## Aberto p/ o Codex challenge
- `callOmieVendasApi` lançar em erro quebra outros callers que hoje toleram `null`? (auditar os consumidores antes).
- `ensure_cliente` deve viver nas 2 edges (oben/colacor em omie-vendas-sync; afiação em omie-sync) ou unificar? (Deno não compartilha helper entre edges → espelho verbatim).
- Tratar "integração duplicada" do Omie como `found` exige re-consultar pra pegar o código — custo aceitável?
