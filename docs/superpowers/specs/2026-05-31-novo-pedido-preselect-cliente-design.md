# Pré-seleção de cliente no "Novo pedido" (Customer 360 → /sales/new)

**Data:** 2026-05-31
**Autor:** Lucas + Claude (decisão A confirmada por consult codex)
**Status:** aprovado (founder: "Siga")

---

## 1. Problema

O botão **"Novo pedido"** do Customer 360 (`CustomerHero.tsx`) navega para `/sales/new?customer=<user_id>` (corrigido no #516, antes era a rota morta `/admin/orders/new`). Mas o `useUnifiedOrder` **ignora** o param `?customer=` → o vendedor abre o cliente no 360, clica "Novo pedido", e cai no passo "Cliente" tendo que **buscar de novo o mesmo cliente** que já tinha aberto. Fricção óbvia no caminho comercial; parece produto inacabado no fluxo de dinheiro.

> Gap registrado como follow-up no #516. Priorizado como próxima atividade (decisão eu + codex: opção A, "completar Novo pedido"). Codex: maior valor, risco aceitável **se a mudança for estreita** (ler `?customer=`, hidratar pelo caminho existente, TDD, review).

## 2. Comportamento atual (confirmado por trace — o "smoke test" do codex)

- `useUnifiedOrder` (`src/hooks/useUnifiedOrder.ts`): expõe `selectCustomer(omieCustomer: OmieCustomer)` (vem do hook `useCustomerSelection`) — o **caminho validado** de seleção. NÃO lê `searchParams`.
- `currentStep` (staff) deriva de `selectedCustomer`: `!selectedCustomer ? 0 (Cliente) : cart.length===0 ? 1 (Itens) : 2 (Revisão)`. **Selecionar um cliente já faz o stepper pular pra "Itens"** — sem manipular step manualmente.
- Precedente interno `handleAICustomerSelect(customer)`: resolve `codigo_cliente` por `user_id` via `omie_clientes`, monta `OmieCustomer`, chama `selectCustomer`. É o padrão a **espelhar** (não refatorar).
- `OmieCustomer` (shape usado): `{ codigo_cliente, razao_social, nome_fantasia, cnpj_cpf, codigo_vendedor, local_user_id }`.

**Fontes de dados por `user_id`:**
- `omie_clientes` (tabela de MAPEAMENTO, sem identidade): `omie_codigo_cliente`, `omie_codigo_vendedor`, `user_id`.
- `profiles` (identidade): `razao_social`, `name`, `document` (cnpj_cpf), `user_id`.

## 3. Design (estreito — reusa o caminho existente)

### 3.1 Helper puro `buildOmieCustomer` (TDD)
Arquivo novo: `src/lib/unified-order/build-omie-customer.ts`.
```ts
// Monta o OmieCustomer a partir dos 2 registros buscados por user_id.
// Puro e testável: sem I/O. Retorna null se não há identidade mínima (sem profile).
export function buildOmieCustomer(
  userId: string,
  profile: { razao_social: string | null; name: string | null; document: string | null } | null,
  omie: { omie_codigo_cliente: number; omie_codigo_vendedor: number | null } | null,
): OmieCustomer | null {
  if (!profile) return null;                       // sem identidade → não dá pra pré-selecionar
  const nome = profile.razao_social || profile.name || '';
  return {
    codigo_cliente: omie?.omie_codigo_cliente ?? 0, // 0 = cliente local/não-sincronizado (fluxo manual já trata)
    razao_social: nome,
    nome_fantasia: profile.name || nome,
    cnpj_cpf: profile.document ?? null,
    codigo_vendedor: omie?.omie_codigo_vendedor ?? null,
    local_user_id: userId,
  };
}
```
> O tipo `OmieCustomer` é importado de `@/hooks/unifiedOrder/types` (definido em `src/hooks/unifiedOrder/types.ts:84`; re-exportado por `@/hooks/useUnifiedOrder`). O helper importa direto de `@/hooks/unifiedOrder/types` (evita ciclo com o hook).

### 3.2 `selectCustomerByUserId(userId)` no `useUnifiedOrder` (camada de dados)
- Busca **em paralelo** (`Promise.all`): `profiles` (razao_social/name/document por `user_id`) + `omie_clientes` (omie_codigo_cliente/omie_codigo_vendedor por `user_id`). Ambos `.maybeSingle()`.
- `const omieCustomer = buildOmieCustomer(userId, profile, omie)`.
- Se `omieCustomer` → `await selectCustomer(omieCustomer)` (o caminho existente; dispara os downstream loads de endereço/preço/pagamento/ferramentas como na seleção manual).
- Se `null` → **fallback silencioso** (não pré-seleciona; retorna sem erro). NÃO quebra o fluxo manual.
- Exposto no return do hook como `selectCustomerByUserId`.
- `useCallback` com dep `[selectCustomer]` (espelha `handleAICustomerSelect`).

### 3.3 Fiação no `UnifiedOrder.tsx`
- Lê `const [searchParams] = useSearchParams(); const preselectId = searchParams.get('customer');`.
- `useEffect` run-once (guard por `useRef(false)`): dispara **só** se `preselectId && isStaff && !selectedCustomer && !preselectedRef.current` → seta o ref, chama `selectCustomerByUserId(preselectId)`.
- Selecionar avança o stepper sozinho (via `currentStep`).
- Exibe o `loadingCustomer` existente durante a resolução (sem novo estado de loading).

## 4. Privacidade

Só o `user_id` (UUID opaco) trafega na URL. `cnpj_cpf`, nome e demais PII **nunca** vão na query string (regra de privacidade) — são buscados client-side a partir do `user_id`. A `CustomerHero` já passa só `customer.user_id` (#516) → nenhuma mudança lá.

## 5. Degradação honesta (mitiga o risco apontado pelo codex)

> Risco do codex: "mexer no fluxo de pedido e quebrar seleção/endereço/pagamento por causa dos efeitos online do `selectCustomer`."

Mitigações:
- **Reusa `selectCustomer` verbatim** — zero money-path novo; a resolução é puramente aditiva (2 reads + build).
- **Run-once guard** + dispara só com `?customer=` presente, modo staff, e **sem** seleção prévia → nunca sobrescreve uma escolha manual nem re-dispara.
- **Fallback silencioso** em qualquer falha de resolução (sem profile, sem mapeamento Omie, erro de rede) → o vendedor cai no passo "Cliente" manual, fluxo 100% intacto. Sem toast de erro assustador.
- `codigo_cliente=0` quando não há mapeamento Omie = exatamente o que o fluxo manual já faz pra cliente local/não-sincronizado.

## 6. Testes

- **Unit (vitest, TDD)** do `buildOmieCustomer`: profile presente + omie presente → OmieCustomer completo; profile presente + omie ausente → `codigo_cliente=0`, vendedor null; profile ausente → `null`; razao_social ausente → fallback pra `name`; document ausente → `cnpj_cpf` null.
- **Fiação do mount** (`UnifiedOrder` lendo o param + run-once): coberta por **verificação manual no QA** (mock de hook + router + selectCustomer rende pouco sinal pra muito setup). Documentar no PR o passo de QA: abrir Customer 360 → "Novo pedido" → cliente pré-selecionado, stepper em "Itens".
- Suíte completa verde (typecheck/lint/test/build).

## 7. Fora de escopo

- Mudar/refatorar `selectCustomer` ou `handleAICustomerSelect` (money-path — manter intacto).
- Pré-seleção a partir de outras telas (só a `CustomerHero` manda `?customer=` hoje; o mecanismo fica pronto pra futuros callers).
- Pré-preencher itens/carrinho a partir da URL (só o cliente).
- Modo cliente (`isCustomerMode`) — lá o cliente é o próprio usuário, não se aplica.

## 8. Arquivos

- **Criar:** `src/lib/unified-order/build-omie-customer.ts` + teste `src/lib/unified-order/__tests__/build-omie-customer.test.ts`.
- **Modificar:** `src/hooks/useUnifiedOrder.ts` (add `selectCustomerByUserId` + expor no return), `src/pages/UnifiedOrder.tsx` (ler param + useEffect run-once).
- **Inalterado:** `CustomerHero.tsx` (já passa `?customer=<user_id>`), `selectCustomer`/`useCustomerSelection`.

## 9. Risco

Baixo. Mudança aditiva sobre um caminho validado; degradação silenciosa preserva o fluxo manual. O único risco real (efeitos online do `selectCustomer`) é o **mesmo** que a seleção manual já exercita todo dia — não introduzimos comportamento novo no money-path, só uma nova porta de entrada (programática) pro mesmo `selectCustomer`. Verificação de runtime fica pro QA final (browser headless não renderiza a SPA).
