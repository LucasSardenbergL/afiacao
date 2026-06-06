# Plano — Etapa 2: identidade de cliente por-conta confiável + tri-state

**Pré-req:** [spec](../specs/2026-06-06-preco-realtime-selectCustomer-design.md) · Etapa 1 (#656) + 2a (#660 + hotfix #673) no ar.
**Status:** consult de design do Codex FEITO (2026-06-06) · **helper puro `src/lib/omie/cliente-lookup.ts` entregue (15 testes)** · backend dos edges = próxima passada focada (money-path, não-testável local, deploy seu).
**Objetivo:** tornar a identidade do cliente por-conta (oben/colacor/afiação) **confiável e tri-state**, fechando o risco de **cliente duplicado** (e completando a base do fail-closed da 2a).

## Refinamentos OBRIGATÓRIOS do Codex (consult 2b)
1. **Helper tri-state (FEITO):** SÓ array vazio = `absent`. `null`/`undefined`/linha-sem-código = `error(malformed)`; **>1 resultado = `error(ambiguous)`** (documento duplicado → não escolher o 1º). `threw` sempre vence.
2. **Detecção de ambíguo no edge:** consultar `registros_por_pagina:2` (ou ler `total_de_registros`); >1 → `error/ambiguous` (hoje os lookups usam `:1` e nunca veem duplicata).
3. **`throwOnTransient` via options object** `{throwOnTransient:true}` (não boolean posicional); **vale também pro `IncluirCliente`** (hoje pode voltar `created:true` com código `null`). Cada lookup/ensure **captura** a exceção → `status:'error'` (não derruba o selectCustomer).
4. **Reusar `src/lib/omie/omie-fault.ts`** (conservador, já testado) pra decidir transitório — NÃO inventar "todo SOAP-ERROR é transitório".
5. **Ensure idempotente + reconciliação:** código `B2B_CLI_<doc>` (namespace, **doc válido 11/14 díg.**). Após **"integração duplicada"** do Omie → **reconsultar por código de integração, confirmar que o documento bate, retornar o código** (obrigatório). Após **timeout/erro transitório do `IncluirCliente`** → mesma reconciliação (a criação pode ter sido efetivada com resposta perdida).
6. **Dois PRs por fronteira de deploy** (NÃO um por edge): **(A) backend** = os 2 edges (tri-state + ensure seguro + determinismo + reconciliação), deploy primeiro; **(B) frontend** = consumir o tri-state + skip em `error`, depois. Compatibilidade: preservar campos legados + adicionar `status`; **frontend novo + edge velho: `status` ausente = `error`, nunca `absent`**.
7. **Não** adotar `UpsertClienteCpfCnpj` (semântica de overwrite pouco documentada).
8. **Parser específico no frontend** (NÃO sobrecarregar o `getResult` genérico dos 7 requests).

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
