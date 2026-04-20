# Migração `console.*` → `logger`

Este documento guia a substituição incremental dos 210 `console.*` espalhados
pelo código pelo logger central (`src/lib/logger.ts`). A migração é feita em
**ondas** — não substituir tudo de uma vez.

## Filosofia

- **Preservar comportamento**: o logger imprime no console em dev, então a
  experiência local não muda.
- **Enriquecer contexto**: cada erro deve carregar dados úteis para diagnóstico
  (orderId, customerId, functionName, etc).
- **Não logar PII desnecessária**: nunca passar senhas, tokens, ou CPF completo
  no contexto.

## Ordem de prioridade (ondas)

### Onda 1 — Caminho crítico de venda (FAZER PRIMEIRO)

1. `src/lib/invoke-function.ts` — **já feito nesta entrega** (validação inicial)
2. `src/services/orderSubmission/` — submit de pedido, qualquer erro aqui é dinheiro perdido
3. `src/hooks/useUnifiedOrder.ts`
4. `src/hooks/unifiedOrder/**`
5. `src/contexts/AuthContext.tsx` — falhas de auth derrubam tudo

### Onda 2 — Integrações Omie

- `src/services/omieService.ts`
- `src/services/financeiroService.ts`
- `src/services/financeiroV2Service.ts`

### Onda 3 — Hooks de domínio

- `src/hooks/useFinanceiro.ts`
- `src/hooks/useTintPricing.ts`
- `src/hooks/useAdminOrderDetail.ts`
- demais hooks em `src/hooks/`

### Onda 4 — Páginas (deixar pra depois)

- `src/pages/Farmer*.tsx`
- `src/pages/Tint*.tsx`
- `src/pages/Financeiro*.tsx`

## Padrões de substituição

### `console.error(msg, err)` → `logger.error(msg, { error: err })`

```ts
// ANTES
console.error('Falha ao submeter pedido', err);

// DEPOIS
logger.error('Falha ao submeter pedido', { error: err, orderId, customerId });
```

Se `err` já é uma instância de `Error`, prefira passar direto:

```ts
// MELHOR AINDA
logger.error(err instanceof Error ? err : new Error(String(err)), {
  orderId,
  customerId,
});
```

### `console.warn(msg, ...)` → `logger.warn(msg, ctx?)`

```ts
// ANTES
console.warn('Cliente sem endereço padrão', clienteId);

// DEPOIS
logger.warn('Cliente sem endereço padrão', { customerId: clienteId });
```

### `console.log(...)` de debug

Esses geralmente eram **temporários** durante desenvolvimento. Avaliar:

- Se descreve evento de negócio relevante → `logger.info(...)`
- Se é diagnóstico técnico que ajuda em produção → `logger.debug(...)`
- Se era debug de uma feature já estável → **remover**

```ts
// ANTES (provavelmente lixo)
console.log('chegou aqui', x, y);

// DEPOIS — remover, ou se útil:
logger.debug('Cálculo de preço executado', { x, y });
```

### Edge functions / fetch errors

Sempre incluir contexto da chamada:

```ts
logger.error('Edge function falhou', {
  functionName: 'omie-vendas-sync',
  errorCode: error?.code,
  httpStatus: error?.status,
  payload: { /* sem dados sensíveis */ },
});
```

## Checklist por arquivo migrado

- [ ] Import adicionado: `import { logger } from '@/lib/logger';`
- [ ] Todos os `console.error` substituídos por `logger.error` com contexto
- [ ] `console.warn` → `logger.warn`
- [ ] `console.log` avaliado: removido OU `logger.debug`/`logger.info`
- [ ] `console.info`/`console.debug` → `logger.info`/`logger.debug`
- [ ] Nenhum dado sensível (senha, token, CPF completo) no contexto
- [ ] `npm test` passa
- [ ] Typecheck limpo (`tsc --noEmit`)

## O que NÃO migrar

- `src/lib/logger.ts` — o próprio logger
- Arquivos em `src/integrations/supabase/` — autogerenciados
- Tests (`*.test.ts`) — podem usar `console.*` à vontade
- Service workers / contextos sem acesso a `window` — avaliar caso a caso

## Severidades — guia rápido

| Severidade | Quando usar | Visível em prod? |
|------------|-------------|------------------|
| `debug`    | Diagnóstico técnico de baixo nível | ❌ |
| `info`     | Evento de negócio normal (login, pedido criado) | ✅ (sem context) |
| `warn`     | Algo incomum que não interrompe operação | ✅ |
| `error`    | Erro que deve gerar atenção | ✅ |
| `critical` | Erro que afeta dados/vendas/integridade | ✅ + alerta |
