# Ligar/WhatsApp no Customer 360 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os botões de contato (Ligar/WhatsApp) nas telas de cliente — links de WhatsApp confiáveis (com 55+DDD) e telefone acionável na tela de detalhe — via um helper único `whatsappLink`.

**Architecture:** Front-end puro, sem backend/schema/Edge Function. Um helper novo (`whatsappLink`) em `src/lib/phone.ts` centraliza a montagem do link `wa.me` reusando o `normalizeBrPhone` existente; os 4 call-sites que montavam o link na mão passam a usá-lo. "Ligar" continua sendo o `<CallButton>` device-aware já existente (sem mudança de comportamento); ele só passa a ser usado também na tela de detalhe.

**Tech Stack:** React 18 + TypeScript, Vite, vitest. Spec: `docs/superpowers/specs/2026-05-28-ligar-whatsapp-cliente-design.md`.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
| --- | --- | --- |
| `src/lib/phone.ts` | Normalização de telefone BR + novo `whatsappLink` | Modificar (+1 função) |
| `src/lib/__tests__/phone.test.ts` | Testes unitários do helper | Modificar (+1 `describe`) |
| `src/components/customer360/CustomerHero.tsx` | Header da 360° — botão WhatsApp | Modificar (1 trecho + import) |
| `src/components/adminCustomers/Customer360View.tsx` | Detalhe do cliente — card "Contato" + dropdown "..." | Modificar (card + dropdown + imports) |
| `src/components/customer360/components.tsx` | `ContactRow` — link WhatsApp (×2) | Modificar (helper + remover `cleanPhone` + import) |
| `src/pages/AdminDemandForecast.tsx` | Mensagem de afiação via WhatsApp | Modificar (`handleWhatsApp` + import) |

**Validações canônicas (CLAUDE.md §2/§13):**
- Testes: `heavy bun run test` (vitest — canônico do CI).
- Typecheck strict (phone.ts está no `tsconfig.strict.json`): `heavy bun run typecheck:strict`.
- Typecheck baseline (cobre todo `src/` + testes): `heavy bunx tsc --noEmit -p tsconfig.app.json`.
- Lint: `bun lint`.
- O prefixo `heavy` é obrigatório em comandos pesados (máquina satura com sessões paralelas).

---

## Task 1: Helper `whatsappLink` (TDD)

**Files:**
- Modify: `src/lib/phone.ts` (append após `formatBrPhone`)
- Test: `src/lib/__tests__/phone.test.ts`

- [ ] **Step 1: Escrever os testes que falham**

Em `src/lib/__tests__/phone.test.ts`, trocar a linha de import:

```ts
import { normalizeBrPhone, formatBrPhone } from '../phone';
```

por:

```ts
import { normalizeBrPhone, formatBrPhone, whatsappLink } from '../phone';
```

E adicionar este bloco ao final do arquivo (após o `describe('formatBrPhone', …)`):

```ts
describe('whatsappLink', () => {
  it('fixo sem DDD (8 díg) → aplica DDD 37 + prefixa 55', () => {
    expect(whatsappLink('35213493')).toBe('https://wa.me/553735213493');
  });

  it('celular com DDD formatado → só dígitos + 55', () => {
    expect(whatsappLink('(37) 99999-8888')).toBe('https://wa.me/5537999998888');
  });

  it('já com +55 → não duplica o 55', () => {
    expect(whatsappLink('5537999998888')).toBe('https://wa.me/5537999998888');
  });

  it('número curto / lixo / falsy → null (call-site esconde o botão)', () => {
    expect(whatsappLink('123')).toBeNull();
    expect(whatsappLink(null)).toBeNull();
    expect(whatsappLink(undefined)).toBeNull();
    expect(whatsappLink('')).toBeNull();
  });

  it('mensagem opcional vira ?text= URL-encoded', () => {
    expect(whatsappLink('37999998888', 'Olá, tudo bem?')).toBe(
      'https://wa.me/5537999998888?text=Ol%C3%A1%2C%20tudo%20bem%3F',
    );
  });

  it('sem mensagem não adiciona ?text=', () => {
    expect(whatsappLink('37999998888')).toBe('https://wa.me/5537999998888');
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `heavy bun run test src/lib/__tests__/phone.test.ts`
Expected: FAIL — `whatsappLink is not a function` / `whatsappLink is not exported`.

- [ ] **Step 3: Implementar o helper (mínimo)**

Em `src/lib/phone.ts`, adicionar ao final do arquivo (após `formatBrPhone`):

```ts
/**
 * Monta um link wa.me confiável a partir de um telefone brasileiro.
 * Normaliza (aplica o DDD padrão se faltar) e prefixa o código do país 55.
 * Retorna null quando o número não tem DDD + número válido (≥ 10 dígitos):
 * o call-site deve ESCONDER o botão em vez de renderizar um link quebrado.
 */
export function whatsappLink(
  phone: string | null | undefined,
  mensagem?: string,
): string | null {
  const numero = normalizeBrPhone(phone);
  if (numero.length < 10) return null;
  const base = `https://wa.me/55${numero}`;
  return mensagem ? `${base}?text=${encodeURIComponent(mensagem)}` : base;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `heavy bun run test src/lib/__tests__/phone.test.ts`
Expected: PASS (todos os `describe`, inclusive os 6 casos novos).

- [ ] **Step 5: Typecheck strict (phone.ts está no strict include)**

Run: `heavy bun run typecheck:strict`
Expected: 0 erros.

- [ ] **Step 6: Commit**

```bash
git add src/lib/phone.ts src/lib/__tests__/phone.test.ts
git commit -m "feat(phone): helper whatsappLink (normaliza BR + 55, null se inválido)"
```

---

## Task 2: Tela 360° — WhatsApp do `CustomerHero`

**Files:**
- Modify: `src/components/customer360/CustomerHero.tsx`

Contexto: o import atual NÃO inclui `@/lib/phone`. O bloco quebrado está nas linhas ~154-165 (`href={`https://wa.me/${customer.phone.replace(/\D/g, '')}`}`). O `<CallButton>` (Ligar) fica inalterado.

- [ ] **Step 1: Importar o helper**

Adicionar após o import do `cn` (`import { cn } from '@/lib/utils';`):

```ts
import { whatsappLink } from '@/lib/phone';
```

- [ ] **Step 2: Computar o href uma vez**

Logo após a linha `const churn = churnTone(s?.churn_risk ?? null);` adicionar:

```ts
  const waHref = whatsappLink(customer.phone);
```

- [ ] **Step 3: Trocar o botão WhatsApp**

Localizar o bloco:

```tsx
            {customer.phone && (
              <Button asChild variant="outline" size="sm">
                <a
                  href={`https://wa.me/${customer.phone.replace(/\D/g, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                  WhatsApp
                </a>
              </Button>
            )}
```

e substituir por (guard pelo helper, não pelo `customer.phone` cru):

```tsx
            {waHref && (
              <Button asChild variant="outline" size="sm">
                <a href={waHref} target="_blank" rel="noopener noreferrer">
                  <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                  WhatsApp
                </a>
              </Button>
            )}
```

- [ ] **Step 4: Typecheck baseline + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json`
Expected: 0 erros.
Run: `bun lint`
Expected: sem novos errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/customer360/CustomerHero.tsx
git commit -m "fix(customer360): WhatsApp do CustomerHero via whatsappLink (55+DDD)"
```

---

## Task 3: Tela de detalhe — telefone acionável + dropdown limpo (`Customer360View`)

**Files:**
- Modify: `src/components/adminCustomers/Customer360View.tsx`

Contexto: o dropdown "..." (linhas ~106-110) tem itens mortos "Ligar"/"WhatsApp"/"Agendar visita" (sem `onClick`). O card "Contato" (linhas ~144-148) mostra o telefone como texto puro. `Phone`, `MessageSquare`, `Calendar` já estão importados de `lucide-react`. O arquivo NÃO importa `@/lib/phone` nem `CallButton`.

- [ ] **Step 1: Adicionar imports**

Após a linha `import { decodeHtmlEntities } from '@/lib/format';` adicionar:

```ts
import { formatBrPhone, whatsappLink } from '@/lib/phone';
import { CallButton } from '@/components/call/CallButton';
```

- [ ] **Step 2: Computar o href do WhatsApp uma vez**

Logo após `const healthInfo = HEALTH_CLASSES[score?.health_class || 'critico'];` adicionar:

```ts
  const waHref = customer.phone ? whatsappLink(customer.phone) : null;
```

- [ ] **Step 3: Limpar o dropdown (remover itens mortos, manter "Agendar visita" desabilitado)**

Localizar:

```tsx
            <DropdownMenuContent align="end">
              <DropdownMenuItem><Phone className="w-3.5 h-3.5 mr-2" /> Ligar</DropdownMenuItem>
              <DropdownMenuItem><MessageSquare className="w-3.5 h-3.5 mr-2" /> WhatsApp</DropdownMenuItem>
              <DropdownMenuItem><Calendar className="w-3.5 h-3.5 mr-2" /> Agendar visita</DropdownMenuItem>
            </DropdownMenuContent>
```

e substituir por:

```tsx
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled>
                <Calendar className="w-3.5 h-3.5 mr-2" /> Agendar visita
                <span className="ml-2 text-[10px] text-muted-foreground">em breve</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
```

- [ ] **Step 4: Tornar o telefone do card "Contato" acionável**

Localizar:

```tsx
            {customer.phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="w-3.5 h-3.5 text-muted-foreground" />
                <span>{customer.phone}</span>
              </div>
            )}
```

e substituir por (espelha o padrão do `ContactRow`: número formatado + CallButton ícone + ícone WhatsApp guardado pelo helper):

```tsx
            {customer.phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1">{formatBrPhone(customer.phone)}</span>
                <CallButton phone={customer.phone} customerName={customer.name} variant="icon" />
                {waHref && (
                  <a
                    href={waHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-status-success-bold transition-colors"
                    aria-label="Enviar WhatsApp"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            )}
```

- [ ] **Step 5: Typecheck baseline + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json`
Expected: 0 erros (confirma que `Phone`/`MessageSquare`/`Calendar` seguem usados — sem import órfão).
Run: `bun lint`
Expected: sem novos errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/adminCustomers/Customer360View.tsx
git commit -m "fix(adminCustomers): telefone acionavel no card Contato + limpa dropdown morto"
```

---

## Task 4: `ContactRow` — link WhatsApp via helper (`components.tsx`)

**Files:**
- Modify: `src/components/customer360/components.tsx`

Contexto: `cleanPhone` (linha ~98) alimenta dois `wa.me/${cleanPhone}` (linhas ~150 e ~175). `formatPhone` (de `./format`) e `CallButton` já são usados — NÃO mudar a exibição, só o href. O arquivo NÃO importa `@/lib/phone`.

- [ ] **Step 1: Importar o helper**

Após a linha `import { CallButton } from '@/components/call/CallButton';` adicionar:

```ts
import { whatsappLink } from '@/lib/phone';
```

- [ ] **Step 2: Trocar `cleanPhone` pelo helper**

Localizar:

```tsx
  const cleanPhone = contact.phone.replace(/\D/g, '');
```

e substituir por:

```tsx
  const waHref = whatsappLink(contact.phone);
```

- [ ] **Step 3: Ajustar o ramo `whatsapp_only` (fallback quando o número é inválido)**

Localizar:

```tsx
            {contact.whatsapp_only ? (
              <a
                href={`https://wa.me/${cleanPhone}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline hover:text-foreground transition-colors"
              >
                {formatPhone(contact.phone)} · só WhatsApp
              </a>
            ) : (
              <span className="inline-flex items-center gap-1">
                {formatPhone(contact.phone)}
                <CallButton phone={contact.phone} customerName={displayName} variant="icon" />
              </span>
            )}
```

e substituir por:

```tsx
            {contact.whatsapp_only ? (
              waHref ? (
                <a
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline hover:text-foreground transition-colors"
                >
                  {formatPhone(contact.phone)} · só WhatsApp
                </a>
              ) : (
                <span>{formatPhone(contact.phone)} · só WhatsApp</span>
              )
            ) : (
              <span className="inline-flex items-center gap-1">
                {formatPhone(contact.phone)}
                <CallButton phone={contact.phone} customerName={displayName} variant="icon" />
              </span>
            )}
```

- [ ] **Step 4: Ajustar o ícone de WhatsApp (guard pelo helper)**

Localizar:

```tsx
        {!contact.whatsapp_only && (
          <a
            href={`https://wa.me/${cleanPhone}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-status-success-bold transition-colors shrink-0 mt-0.5"
            aria-label="Enviar WhatsApp"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </a>
        )}
```

e substituir por (acrescenta `&& waHref`):

```tsx
        {!contact.whatsapp_only && waHref && (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-status-success-bold transition-colors shrink-0 mt-0.5"
            aria-label="Enviar WhatsApp"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </a>
        )}
```

- [ ] **Step 5: Typecheck baseline + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json`
Expected: 0 erros (sem `cleanPhone` órfão).
Run: `bun lint`
Expected: sem novos errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/customer360/components.tsx
git commit -m "fix(customer360): ContactRow usa whatsappLink (55+DDD)"
```

---

## Task 5: `AdminDemandForecast` — mensagem de afiação via helper

**Files:**
- Modify: `src/pages/AdminDemandForecast.tsx`

Contexto: `handleWhatsApp` (linhas ~366-375) monta `wa.me/55${phone}` sem DDD. O arquivo NÃO importa `@/lib/phone` (importa `cn` de `@/lib/utils` na linha 23).

- [ ] **Step 1: Importar o helper**

Após a linha `import { cn } from '@/lib/utils';` adicionar:

```ts
import { whatsappLink } from '@/lib/phone';
```

- [ ] **Step 2: Reescrever `handleWhatsApp`**

Localizar:

```tsx
  const handleWhatsApp = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (customer.customerPhone) {
      const phone = customer.customerPhone.replace(/\D/g, '');
      const message = encodeURIComponent(
        `Olá ${customer.customerName}! Notamos que suas ferramentas estão precisando de afiação. Gostaria de agendar o serviço?`
      );
      window.open(`https://wa.me/55${phone}?text=${message}`, '_blank');
    }
  };
```

e substituir por (o helper já faz a normalização + encode da mensagem):

```tsx
  const handleWhatsApp = (e: React.MouseEvent) => {
    e.stopPropagation();
    const href = whatsappLink(
      customer.customerPhone,
      `Olá ${customer.customerName}! Notamos que suas ferramentas estão precisando de afiação. Gostaria de agendar o serviço?`,
    );
    if (href) window.open(href, '_blank');
  };
```

- [ ] **Step 3: Typecheck baseline + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json`
Expected: 0 erros.
Run: `bun lint`
Expected: sem novos errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/AdminDemandForecast.tsx
git commit -m "fix(demand-forecast): WhatsApp de afiacao via whatsappLink (DDD + 55)"
```

---

## Task 6: Validação final + QA manual

**Files:** nenhum (só verificação)

- [ ] **Step 1: Suíte completa**

Run: `heavy bun run test`
Expected: 100% PASS (todos os testes existentes + os 6 novos do `whatsappLink`).

- [ ] **Step 2: Typecheck (strict + baseline)**

Run: `heavy bun run typecheck:strict`
Expected: 0 erros.
Run: `heavy bunx tsc --noEmit -p tsconfig.app.json`
Expected: 0 erros.

- [ ] **Step 3: Lint**

Run: `bun lint`
Expected: sem novos errors (warnings `react-hooks/exhaustive-deps` pré-existentes são não-bloqueantes).

- [ ] **Step 4: QA manual (device do founder)**

O `/browse` headless NÃO renderiza esta SPA (CLAUDE.md §10) → o QA visual é manual, no device/Chrome do founder:
- Em **desktop**, abrir `/admin/customers/:id` e `/admin/customers/:id/360`: o WhatsApp deve abrir a conversa no número certo (ex.: cliente sem DDD `35213493` → `wa.me/553735213493`); "Ligar" abre o Dialer in-app.
- Em **touch**, "Ligar" abre `tel:` nativo (por design).
- Confirmar que o botão WhatsApp **some** quando o cliente não tem telefone válido (em vez de link quebrado).

> Documentar no PR que o teste de device é manual (limitação do headless).

---

## Notas de escopo (do spec)

- **Fora de escopo:** ligação por voz via WhatsApp (inviável p/ SMB — deferida); config de telefonia Nvoip (outra conversa); "Agendar visita" funcional com fila de visitas persistente (spec próprio futuro — por ora o item fica desabilitado "em breve").
- **Sem backend:** zero migration, zero Edge Function, zero mudança de schema → nada a aplicar via Lovable.
- **DDD padrão 37:** premissa pré-existente do `normalizeBrPhone`, não alterada aqui.
