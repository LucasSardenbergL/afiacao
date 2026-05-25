# Cobertura de teste do `buildPrintData` — Design Spec

> **Data:** 2026-05-25
> **Status:** continuação autônoma (Codex #4 na fila de cobertura). Função **pura** que monta os dados de impressão do pedido (`src/services/orderSubmission/buildPrintData.ts`) sem teste. Money-adjacent — é o que o cliente lê no comprovante (itens, totais, frete, condição de pagamento). Lógica pura → teste durável.

## Goal

Travar o mapeamento carrinho → `PrintOrderData[]`: quais blocos são gerados (Oben/Colacor/Serviço), em que ordem, com que totais, fallbacks de perfil de empresa e parsing do nº do pedido. Sem mudança de código.

## Regras (do código)

- Gera **um bloco por conta com itens** (`length > 0`), na ordem fixa **Oben → Colacor → Serviço**. Carrinho vazio → `[]`.
- **Oben**: `isOben:true`; `orderNumber` = `results.find(startsWith 'PV Oben')` sem o prefixo (ou `''`); itens mapeados com `valorTotal = quantity * unit_price` + campos de tinta (`tintCorId`/`tintNomeCor`); `subtotal === total === obenSubtotal`; `frete:0`, `desconto:0`; `observacoes = notes || undefined`; `condPagamento = findParcelaDesc(parcelaOben, formasPagamentoOben)`.
- **Colacor**: `isOben:false`; `orderNumber` de `'PV Colacor '`; itens sem campos de tinta; demais iguais ao Oben.
- **Serviço**: `isOben:false`; `orderNumber` de `'OS '`; itens via `getServicePrice(c)` (`valorTotal = price * quantity`, `codigo = omie_codigo_servico.toString() || '-'`, `descricao = servico.descricao || getToolName(userTool)`, `unidade 'SV'`); `frete = DELIVERY_FEES[deliveryOption]`; `total = serviceSubtotal + frete`; `condPagamento = afiacaoMethod==='a_vista' ? 'À Vista' : afiacaoMethod`.
- **Perfil da empresa** (`companyProfiles.{oben,colacor,afiacao}`) sobrescreve nome/CNPJ/telefone/endereço; ausente → fallback hardcoded.
- `customerDocument = customer.cnpj_cpf || ''`.

## Cenários

1. **Carrinho vazio** → `[]`.
2. **Só Oben** → 1 bloco; `isOben:true`; orderNumber `'12345'`; item `valorTotal = 2*10 = 20`; subtotal=total; observacoes=notes; fallback `'OBEN COMÉRCIO LTDA'` sem perfil.
3. **Só Colacor** → 1 bloco; `isOben:false`; orderNumber de `'PV Colacor '`; fallback `'COLACOR COMERCIAL LTDA'`.
4. **Só Serviço** → 1 bloco; `frete === DELIVERY_FEES[deliveryOption]`; `total === serviceSubtotal + frete`; `condPagamento 'À Vista'` quando `a_vista`; preço via `getServicePrice`.
5. **Os três** → 3 blocos na ordem Oben, Colacor, Serviço.
6. **Perfis presentes** → sobrescrevem companyName/cnpj/phone/address.
7. **`results` sem prefixo** → `orderNumber === ''`.
8. **notes vazio** → `observacoes === undefined`; **cnpj_cpf null** → `customerDocument === ''`.
9. **condPagamento de serviço passthrough** quando `afiacaoMethod !== 'a_vista'`.

## Mock

- `vi.mock('../helpers')` → `findParcelaDesc` retorna `desc:<codigo>`; `getToolName` retorna `'FerramentaMock'` (isola o mapeamento da lógica dos helpers, já cobertos à parte).
- `DELIVERY_FEES` **real** de `@/types` (assert por referência à constante, não valor hardcoded — robusto a mudança de tabela de frete).
- Fixtures por `as unknown as` (padrão dos testes de submitOrder/submitQuote).

## Testing

`src/services/orderSubmission/__tests__/buildPrintData.test.ts` (vitest). Sem rede. Suíte verde; lint limpo; sem tocar `buildPrintData.ts`.

## Out-of-scope

- O componente `OrderPrintLayout` (render); helpers (mockados/cobertos à parte).
