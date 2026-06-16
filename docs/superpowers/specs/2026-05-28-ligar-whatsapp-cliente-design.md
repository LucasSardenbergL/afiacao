# Ligar e WhatsApp no Customer 360 — correção dos botões + link de WhatsApp confiável

**Data:** 2026-05-28
**Autor:** Lucas + Claude
**Status:** aprovado (escopo travado, aguardando review do spec)

---

## 1. Problema (relatado pelo founder)

Em **duas telas** do cliente, os botões de contato não funcionam:

1. **"Ligar"** — abre o app de telefone do sistema operacional em vez de ligar pelo aplicativo (telefonia in-app).
2. **"WhatsApp"** — não abre a conversa.
3. **Desejo de feature** — ligar por voz pelo WhatsApp seguindo os mesmos parâmetros de uma ligação normal (gravação, transcrição, LGPD, log em `farmer_calls`).

Telas afetadas:
- **Tela 1** — `/admin/customers/:id` (detalhe do cliente). Componente `src/components/adminCustomers/Customer360View.tsx`. Tem um dropdown "..." com **Ligar / WhatsApp / Agendar visita** e um card "Contato" com o telefone.
- **Tela 2** — `/admin/customers/:id/360` (visão 360°). Componente `src/components/customer360/CustomerHero.tsx`. Tem botões **Ligar / WhatsApp / Novo pedido** no header.

Cliente de teste: **"(RR) MOVEIS PLANEJADOS 2 IRMAOS"**, telefone `35213493` (8 dígitos, sem DDD), empresa Oben.

---

## 2. Diagnóstico

### 2.1 Botão "Ligar"

- **Tela 2 (`CustomerHero`)** já usa o componente correto `<CallButton phone={customer.phone} customerName={customer.name} />` (linha 152). O `CallButton` é **device-aware**: em touch (`(hover: none) and (pointer: coarse)`) abre `tel:` nativo (por design, vendedor em campo); em desktop renderiza o `<Dialer>` in-app (Nvoip/WebRTC). Esse roteamento desktop→in-app existe desde o PR #163 (2026-05-22).
- **Tela 1 (`Customer360View`)** — o item "Ligar" do dropdown (linha 107) é **morto**: `<DropdownMenuItem>` sem `onClick`. Não faz nada. O card "Contato" (linha 144-148) mostra o telefone como **texto puro** (`<span>{customer.phone}</span>`), não clicável.
- **"Abre o app de telefone"** — comportamento esperado em **device touch** (o `tel:` é intencional para vendedor em campo). Em **desktop**, o caminho correto é o `<Dialer>` in-app; se um desktop está abrindo o app de telefone, é deploy de produção defasado (código pré-#163) que se auto-resolve no próximo deploy. **A completude da ligação (Nvoip discar o ramal do vendedor) depende de config Nvoip por vendedor — está sendo tratada em outra conversa e está FORA do escopo deste spec.**

### 2.2 Botão "WhatsApp" — **bug real e confirmado**

Os links de WhatsApp usam os dígitos crus do telefone, **sem `55` (código do país) nem DDD**:

- `CustomerHero.tsx:157` — `href={\`https://wa.me/${customer.phone.replace(/\D/g, '')}\`}`. Para `35213493` gera `wa.me/35213493` → **número inválido**, o WhatsApp não acha a conversa.
- `customer360/components.tsx` (`ContactRow`) — `const cleanPhone = contact.phone.replace(/\D/g, '')` (linha 98), usado em `wa.me/${cleanPhone}` nas linhas 150 e 175. Mesmo bug.
- `Customer360View.tsx:108` — item "WhatsApp" do dropdown é **morto** (sem `onClick`).
- `AdminDemandForecast.tsx:373` — `wa.me/55${phone}` (`phone = customer.customerPhone.replace(/\D/g, '')`). **Meio quebrado**: tem o `55` mas **não tem DDD** → para telefone sem DDD ainda gera número inválido.

**Causa-raiz:** não existe um helper único que normalize o telefone brasileiro (aplicar DDD padrão, código do país) e monte o link `wa.me`. Cada call-site monta o link na mão, de forma inconsistente.

### 2.3 Feature 3 — ligar por voz pelo WhatsApp "com os mesmos parâmetros"

**Tecnicamente inviável para o nosso caso (deferida).** A WhatsApp Business Calling API (voz) é restrita a contas grandes/enterprise via BSP; gravação não é documentada; e a chamada não passaria pela Nvoip → **não há como seguir "os mesmos parâmetros" (gravação/transcrição/LGPD/log) de uma ligação normal**. O founder concordou em **corrigir o chat agora e reavaliar a voz depois** (resposta: "Corrigir chat agora + avaliar voz depois"). Documentado em "Fora de escopo".

---

## 3. Escopo

### 3.1 Dentro do escopo

**A) Novo helper `whatsappLink` em `src/lib/phone.ts`**

Função pura, com testes (TDD):

```ts
export function whatsappLink(
  phone: string | null | undefined,
  mensagem?: string,
): string | null
```

- Reaproveita `normalizeBrPhone` (aplica DDD 37 se faltar, tira `55`/`0` de prefixo, deixa só dígitos).
- Se o número normalizado tiver **< 10 dígitos** (sem DDD+número válido) → retorna `null` (o call-site **esconde** o botão em vez de renderizar link quebrado).
- Caso válido → `https://wa.me/55${numero}` (+ `?text=${encodeURIComponent(mensagem)}` quando houver mensagem).

Testes mínimos:
- `"35213493"` → `https://wa.me/553735213493` (aplica DDD 37 + 55).
- `"(37) 99999-9999"` → `https://wa.me/5537999999999`.
- `null` / `""` / `"123"` → `null`.
- com mensagem → inclui `?text=` URL-encoded.

**B) Tela 2 — `CustomerHero.tsx`**

- Trocar o `href` quebrado (linha 157) por `whatsappLink(customer.phone)`.
- Renderizar o botão WhatsApp **só quando o helper não retornar `null`** (guard).
- "Ligar" (`CallButton`) **inalterado**.

**C) Tela 1 — `Customer360View.tsx`**

- **Card "Contato"**: tornar o telefone **acionável**, espelhando o padrão do `ContactRow` — `formatBrPhone(customer.phone)` para exibir + `<CallButton phone={customer.phone} customerName={customer.name} variant="icon" />` + ícone de WhatsApp linkando via `whatsappLink`. Importar `CallButton`, `formatBrPhone`, `whatsappLink`.
- **Dropdown "..."**: **remover** os itens mortos "Ligar" e "WhatsApp" (a ação de contato passa a viver no card, acionável e consistente com o resto do app). Manter o item **"Agendar visita" DESABILITADO com rótulo "em breve"** (decisão: separar e brainstormar depois — ver Fora de escopo / task futura).

**D) `customer360/components.tsx` (`ContactRow`)**

- Trocar os dois `wa.me/${cleanPhone}` (linhas 150 e 175) por `whatsappLink(contact.phone)`. Guard de render quando `null`.

**E) `AdminDemandForecast.tsx:373`**

- Trocar `wa.me/55${phone}?text=...` pelo helper `whatsappLink(customer.customerPhone, mensagem)` (founder pediu para incluir). Preserva a mensagem pré-montada de afiação.

### 3.2 Fora de escopo (documentado)

- **Ligação por voz via WhatsApp** — inviável para SMB (API enterprise-only; não segue os parâmetros da ligação normal). Deferida; reavaliar depois.
- **Config de telefonia Nvoip** (vendedor não consegue completar ligação) — outra conversa em andamento.
- **"Agendar visita" funcional** (fila de visitas persistente: vendedor adiciona cliente manualmente à lista de visitas mesmo fora do filtro do app) — é **feature nova de backend** (tabela/RLS + UI + migration via Lovable). Vira **spec próprio** (task futura). Por ora o item fica desabilitado "em breve".

---

## 4. Arquitetura / fluxo de dados

Nenhuma mudança de backend, schema ou Edge Function. Tudo é front-end puro + um helper:

```
src/lib/phone.ts
  ├─ normalizeBrPhone()  (existente)
  ├─ formatBrPhone()     (existente)
  └─ whatsappLink()      (NOVO — reusa normalizeBrPhone)
        ▲
        ├── CustomerHero.tsx          (tela 2: botão WhatsApp)
        ├── Customer360View.tsx       (tela 1: card Contato — CallButton + WhatsApp)
        ├── customer360/components.tsx (ContactRow ×2)
        └── AdminDemandForecast.tsx    (mensagem de afiação)
```

`CallButton` (device-aware, já existente) continua sendo a única porta para "Ligar" — sem mudança de comportamento, só passa a ser usado também na tela 1.

---

## 5. Testes

- **Unitário (vitest)** do `whatsappLink` — casos da seção 3.1.A (com/sem DDD, inválido→null, com mensagem). Espelha a disciplina dos helpers puros do repo.
- **Manual / device** — o QA visual mobile é limitado (o `/browse` headless não renderiza a SPA; ver §10 do CLAUDE.md). Verificação real do `tel:` em touch e do `wa.me` fica no device do founder. Documentar explicitamente que o teste de device é manual.

---

## 6. Riscos

- **Baixo.** Mudanças localizadas, sem backend. O único risco é regressão visual no card "Contato" da tela 1 (layout) — mitigado por espelhar o `ContactRow` que já existe e funciona.
- `normalizeBrPhone` aplica **DDD 37 (Divinópolis)** como padrão quando falta DDD. Para o cliente de teste (telefone sem DDD) isso gera `37` — pode não ser o DDD real do cliente. É o comportamento já vigente em todo o app (telefonia inclusive); este spec **não muda** essa premissa, só a centraliza. Se o DDD padrão precisar ser por-empresa/por-cliente, é trabalho futuro separado.

---

## 7. Itens deferidos (viram trabalho futuro)

1. **Ligação por voz via WhatsApp** — reavaliar quando/se houver caminho que respeite gravação/transcrição/LGPD/log.
2. **"Agendar visita" com fila de visitas persistente** — spec próprio (backend + RLS + migration Lovable). O route planner hoje só tem seleção manual de paradas em `useState` de sessão (não persiste).
