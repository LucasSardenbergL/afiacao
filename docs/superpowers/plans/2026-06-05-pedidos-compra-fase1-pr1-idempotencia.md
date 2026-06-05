# Idempotência do disparo de pedido de compra (Fase 1 · sub-PR 1) — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o disparo de pedido de compra OBEN à prova de duplicação, sem introduzir estado novo: (A) tratar o erro "já cadastrado" do Omie como **reconciliação** (o PV já existe → marca `disparado`, não `falha_envio`); (B) endurecer o claim do portal Sayerlack (não rebaixar um envio em voo).

**Architecture:** A chave de idempotência do Omie já existe — `cCodIntPed=AFI-<id>` (estável por pedido); o Omie **rejeita** `IncluirPedCompra` com código de integração duplicado (confirmado na doc). Então a corrida disparo-imediato × cron-13h nunca cria 2 PVs; só precisamos parar de tratar a rejeição da 2ª tentativa como falha. Helper puro testável (vitest) espelhado verbatim na edge Deno (que não importa de `@/`). Para o portal, o claim atômico (`envio_portal_claim_ids`, lista-positiva, já em prod) é o mecanismo; aqui só evitamos o rebaixamento `enviando_portal → pendente_envio_portal` no pré-claim.

**Tech Stack:** TypeScript, Vitest (helper puro), Supabase Edge Function (Deno), Omie API (`IncluirPedCompra`/`ConsultarPedCompra`).

**Spec:** `docs/superpowers/specs/2026-06-05-unificacao-pedidos-compra-design.md` §4.3.

**Escopo deste sub-PR:** edge-only, **sem migration**. Não toca a UI, a RPC de aprovação, nem a geração — só o caminho de disparo. Mergeável e validável sozinho (deixa o backend mais seguro sem mudar comportamento visível).

---

## Dependências de implementação (confirmar na Task 1 e na validação)

1. **Texto do `faultstring` do Omie para pedido duplicado.** A doc diz "Pedido de compra já cadastrado". O helper `isOmiePedidoJaCadastrado` usa um matcher robusto; ao ver o erro REAL no log do 1º smoke, ajustar o regex se preciso (e adicionar um teste com o texto exato).
2. **`ConsultarPedCompra` aceita `{ cCodIntPed }`?** É o padrão Omie (consulta por chave nCodPed OU código de integração). Se na prática só aceitar `nCodPed`, o fallback (marcar `disparado` sem número; o cron `omie-sync-pedidos-compra` preenche depois) já cobre — então o plano funciona de qualquer forma.

---

## File Structure

- **Create:** `src/lib/reposicao/omie-disparo-helpers.ts` — helpers puros: `isOmiePedidoJaCadastrado()`, `extrairPedidoOmie()`. Uma responsabilidade: interpretar respostas/erros do Omie no disparo.
- **Create:** `src/lib/reposicao/__tests__/omie-disparo-helpers.test.ts` — testes vitest dos dois helpers.
- **Modify:** `supabase/functions/disparar-pedidos-aprovados/index.ts`
  - espelhar os 2 helpers (inline, perto do topo, com comentário de espelho);
  - `processarPedido` catch (`:711-725`) — reconciliação antes de `falha_envio`;
  - `iniciarEnvioPortalSayerlack` (`:420-440`) — pré-check `enviando_portal` + UPDATE de claim condicional.

---

## Task 1: Helper puro — interpretar erro/resposta do Omie no disparo

**Files:**
- Create: `src/lib/reposicao/omie-disparo-helpers.ts`
- Test: `src/lib/reposicao/__tests__/omie-disparo-helpers.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/reposicao/__tests__/omie-disparo-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { isOmiePedidoJaCadastrado, extrairPedidoOmie } from '../omie-disparo-helpers';

describe('isOmiePedidoJaCadastrado', () => {
  it('detecta "já cadastrado" em pt-BR (com acento)', () => {
    expect(isOmiePedidoJaCadastrado('Omie IncluirPedCompra erro [500]: Pedido de compra já cadastrado')).toBe(true);
  });
  it('detecta sem acento', () => {
    expect(isOmiePedidoJaCadastrado('Pedido de compra ja cadastrado')).toBe(true);
  });
  it('detecta menção a código de integração já cadastrado', () => {
    expect(isOmiePedidoJaCadastrado('O codigo de integracao [AFI-123] ja foi cadastrado')).toBe(true);
  });
  it('detecta "already registered" (inglês)', () => {
    expect(isOmiePedidoJaCadastrado('Purchase order already registered')).toBe(true);
  });
  it('NÃO detecta erro genérico de validação', () => {
    expect(isOmiePedidoJaCadastrado('Omie IncluirPedCompra erro [500]: O preenchimento da tag [nValUnit] é obrigatório')).toBe(false);
  });
  it('NÃO confunde "cliente cadastrado com sucesso"', () => {
    expect(isOmiePedidoJaCadastrado('Cliente cadastrado com sucesso')).toBe(false);
  });
  it('trata null/undefined/vazio', () => {
    expect(isOmiePedidoJaCadastrado(null)).toBe(false);
    expect(isOmiePedidoJaCadastrado(undefined)).toBe(false);
    expect(isOmiePedidoJaCadastrado('')).toBe(false);
  });
});

describe('extrairPedidoOmie', () => {
  it('extrai de pedido_compra_cabecalho', () => {
    expect(extrairPedidoOmie({ pedido_compra_cabecalho: { nCodPed: 999, cNumero: '12345' } }))
      .toEqual({ id: '999', numero: '12345' });
  });
  it('extrai de cabecalho_consulta (formato do PesquisarPedCompra)', () => {
    expect(extrairPedidoOmie({ cabecalho_consulta: { nCodPed: 888 } }))
      .toEqual({ id: '888', numero: '' });
  });
  it('extrai de cabecalho cru no topo', () => {
    expect(extrairPedidoOmie({ nCodPed: 777, cNumero: '55' })).toEqual({ id: '777', numero: '55' });
  });
  it('retorna null quando não há id', () => {
    expect(extrairPedidoOmie({ foo: 'bar' })).toBeNull();
    expect(extrairPedidoOmie(null)).toBeNull();
    expect(extrairPedidoOmie(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `heavy bun run test -- src/lib/reposicao/__tests__/omie-disparo-helpers.test.ts`
Expected: FAIL — "Cannot find module '../omie-disparo-helpers'".

- [ ] **Step 3: Implementar o helper**

```ts
// src/lib/reposicao/omie-disparo-helpers.ts
// Helpers puros do disparo de pedido de compra ao Omie.
// ⚠️ ESPELHADO VERBATIM em supabase/functions/disparar-pedidos-aprovados/index.ts
// (Deno não importa de @/). Mudou aqui? Copie lá.

/**
 * Detecta o erro do Omie de pedido de compra com código de integração duplicado.
 * O Omie REJEITA IncluirPedCompra com cCodIntPed já existente ("já cadastrado").
 * Como cCodIntPed=AFI-<id> é estável, isso significa que o PV JÁ existe (corrida
 * disparo×cron ou retry pós-crash) → tratamos como reconciliação, não falha.
 */
export function isOmiePedidoJaCadastrado(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  // "pedido ... já/ja (foi) cadastrad..." | "...integra... cadastrad..." | "already registered/exists"
  if (/j[áa]\s+(foi\s+)?cadastrad/.test(m)) return true;
  if (/integra\w*/.test(m) && /cadastrad/.test(m)) return true;
  if (/already\s+(registered|exists)/.test(m)) return true;
  return false;
}

/** Extrai { id, numero } do cabeçalho retornado por ConsultarPedCompra/PesquisarPedCompra. */
export function extrairPedidoOmie(
  resp: unknown,
): { id: string; numero: string } | null {
  if (!resp || typeof resp !== 'object') return null;
  const r = resp as Record<string, unknown>;
  const cab = (r.pedido_compra_cabecalho ??
    r.cabecalho ??
    r.cabecalho_consulta ??
    r) as Record<string, unknown>;
  const idRaw = cab?.nCodPed ?? r.nCodPed;
  if (idRaw == null) return null;
  const numeroRaw = cab?.cNumero ?? r.cNumero;
  return { id: String(idRaw), numero: numeroRaw != null ? String(numeroRaw) : '' };
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `heavy bun run test -- src/lib/reposicao/__tests__/omie-disparo-helpers.test.ts`
Expected: PASS (todos os casos).

- [ ] **Step 5: Typecheck + lint**

Run: `heavy bun run typecheck && bun lint`
Expected: 0 erros.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reposicao/omie-disparo-helpers.ts src/lib/reposicao/__tests__/omie-disparo-helpers.test.ts
git commit -m "feat(reposição): helpers puros de idempotência do disparo Omie (detecta 'já cadastrado' + extrai pedido)"
```

---

## Task 2: Reconciliação no `processarPedido` (edge) — "já cadastrado" → `disparado`

**Files:**
- Modify: `supabase/functions/disparar-pedidos-aprovados/index.ts` (espelhar helpers + catch `:711-725`)

> A edge Deno não tem teste unitário no projeto (validação é deploy + smoke). A correção é COMPORTAMENTAL e os helpers já estão testados na Task 1.

- [ ] **Step 1: Espelhar os helpers na edge**

Logo após o bloco de tipos/helpers no topo (ex.: depois de `omieCall`, ~linha 153), inserir — VERBATIM da Task 1, com o aviso de espelho:

```ts
// ⚠️ ESPELHADO VERBATIM de src/lib/reposicao/omie-disparo-helpers.ts — mudou lá? Copie aqui.
function isOmiePedidoJaCadastrado(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (/j[áa]\s+(foi\s+)?cadastrad/.test(m)) return true;
  if (/integra\w*/.test(m) && /cadastrad/.test(m)) return true;
  if (/already\s+(registered|exists)/.test(m)) return true;
  return false;
}
function extrairPedidoOmie(resp: unknown): { id: string; numero: string } | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;
  const cab = (r.pedido_compra_cabecalho ?? r.cabecalho ?? r.cabecalho_consulta ?? r) as Record<string, unknown>;
  const idRaw = cab?.nCodPed ?? r.nCodPed;
  if (idRaw == null) return null;
  const numeroRaw = cab?.cNumero ?? r.cNumero;
  return { id: String(idRaw), numero: numeroRaw != null ? String(numeroRaw) : "" };
}
```

- [ ] **Step 2: Reconciliar no catch antes de `falha_envio`**

Substituir o bloco `catch (e) { ... }` de `processarPedido` (atual `:711-725`) por:

```ts
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Idempotência Omie: cCodIntPed=AFI-<id> é estável; o Omie REJEITA duplicado
    // ("já cadastrado"). Isso significa que o PV JÁ existe (corrida disparo×cron
    // ou retry pós-crash) → reconciliar, NÃO falhar. Só em produção (dry_run não
    // cria PV persistente que queiramos reconciliar como disparado real).
    if (modo === "producao" && isOmiePedidoJaCadastrado(msg)) {
      let existente: { id: string; numero: string } | null = null;
      let consultaErro: string | null = null;
      try {
        const consulta = await omieCall(
          OMIE_PEDIDO_COMPRA_URL,
          "ConsultarPedCompra",
          { cCodIntPed: `AFI-${pedido.id}` },
          creds,
        );
        existente = extrairPedidoOmie(consulta);
      } catch (e2) {
        consultaErro = e2 instanceof Error ? e2.message : String(e2);
      }
      await db
        .from("pedido_compra_sugerido")
        .update({
          omie_pedido_compra_id: existente?.id ?? null,
          omie_pedido_compra_numero: existente?.numero ?? null,
          omie_registrado_em: new Date().toISOString(),
          status: "disparado",
          resposta_canal: {
            reconciliado: true,
            motivo: "ja_cadastrado_omie",
            erro_original: msg,
            consulta_falhou: consultaErro,
            ts: new Date().toISOString(),
          },
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", pedido.id);
      console.warn(
        `[disparar-pedidos] Pedido ${pedido.id}: já existia no Omie (cCodIntPed) → reconciliado como disparado (id=${existente?.id ?? "?"})`,
      );
      result.status_final = "disparado";
      result.omie_id = existente?.id ?? "";
      result.omie_numero = existente?.numero ?? "";
      return result;
    }
    console.error(`[disparar-pedidos] Falha pedido ${pedido.id}:`, msg);
    await db
      .from("pedido_compra_sugerido")
      .update({
        status: "falha_envio",
        resposta_canal: { erro: msg, modo, ts: new Date().toISOString() },
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", pedido.id);
    result.status_final = "falha_envio";
    result.erro = msg;
    return result;
  }
```

- [ ] **Step 3: `deno check` da edge (net-zero de erros vs. main)**

Run: `cd supabase/functions/disparar-pedidos-aprovados && deno check index.ts 2>&1 | tail -5; cd -`
Expected: nenhum erro NOVO (o CLAUDE.md §5 nota que o `deno check` pode ter erros pré-existentes de typing do `supabase-js` sem generic `Database` — comparar o set antes/depois; deve ser idêntico).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/disparar-pedidos-aprovados/index.ts
git commit -m "feat(reposição): disparo trata 'já cadastrado' do Omie como reconciliação (anti-duplicação de PV)"
```

---

## Task 3: Endurecer o claim do portal — não rebaixar `enviando_portal`

**Files:**
- Modify: `supabase/functions/disparar-pedidos-aprovados/index.ts` (`iniciarEnvioPortalSayerlack`, `:420-440`)

> Contexto: o UPDATE atual (`:428-440`) seta `pendente_envio_portal` **incondicionalmente** → pode rebaixar um pedido que outra execução já reivindicou (`enviando_portal`), gerando 2ª sessão no Browserless. O claim canônico (`envio_portal_claim_ids`, lista-positiva) já protege o Browserless, mas o rebaixamento da coluna acontece ANTES dele. Fix: pré-check + UPDATE condicional.

- [ ] **Step 1: Pré-check de `enviando_portal`**

Logo após o bloco `if (statusPortalAtual === "aceito_portal_sem_protocolo" || ... )` (atual `:420-426`), adicionar:

```ts
  // Já em voo no portal? NÃO re-enfileirar — evita 2ª sessão Browserless e o
  // rebaixamento enviando_portal → pendente. O claim atômico do envio cobre o
  // Browserless; aqui evitamos tocar a coluna.
  if (statusPortalAtual === "enviando_portal") {
    console.warn(`[disparar-pedidos] Pedido ${pedidoId}: já enviando_portal — não re-enfileirado`);
    return { state: "queued", accepted: true };
  }
```

- [ ] **Step 2: Tornar o UPDATE de pré-claim condicional**

Substituir o `await db.from("pedido_compra_sugerido").update({ status_envio_portal: "pendente_envio_portal", ... }).eq("id", pedidoId);` (atual `:429-440`) por uma versão condicional que NÃO rebaixa um envio concorrente:

```ts
  // Inicia em pendente para o portal aceitar — condicional: se uma execução
  // concorrente já marcou enviando_portal entre o pré-check e aqui, NÃO rebaixar.
  const { data: claimRow } = await db
    .from("pedido_compra_sugerido")
    .update({
      status_envio_portal: "pendente_envio_portal",
      portal_erro: null,
      portal_proximo_retry_em: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    })
    .eq("id", pedidoId)
    .neq("status_envio_portal", "enviando_portal")
    .select("id")
    .maybeSingle();
  if (!claimRow) {
    console.warn(`[disparar-pedidos] Pedido ${pedidoId}: pré-claim do portal perdido (concorrência) — não re-enfileirado`);
    return { state: "queued", accepted: true };
  }
```

- [ ] **Step 3: `deno check` (net-zero)**

Run: `cd supabase/functions/disparar-pedidos-aprovados && deno check index.ts 2>&1 | tail -5; cd -`
Expected: nenhum erro novo.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/disparar-pedidos-aprovados/index.ts
git commit -m "fix(reposição): pré-claim do portal não rebaixa envio em voo (enviando_portal)"
```

---

## Task 4: Validação e handoff de deploy

**Files:** nenhum (validação)

- [ ] **Step 1: Suite completa**

Run: `heavy bun run test && heavy bun run typecheck && bun lint`
Expected: tudo verde (o CI roda isto no PR).

- [ ] **Step 2: Abrir PR**

```bash
git push -u origin claude/fervent-leavitt-37b4b8
gh pr create --title "feat(reposição): idempotência do disparo — reconciliação Omie + claim do portal (Fase 1 PR1)" --body "$(cat <<'EOF'
Fase 1 · sub-PR 1 do programa de unificação da tela de pedidos de compra.
Spec: docs/superpowers/specs/2026-06-05-unificacao-pedidos-compra-design.md §4.3

- (A) Omie: erro "já cadastrado" → reconciliação (cCodIntPed=AFI-<id> é a chave; o Omie rejeita duplicado) — para de virar falha_envio.
- (B) Portal: pré-check enviando_portal + UPDATE de pré-claim condicional (não rebaixa envio em voo).

Edge-only, **sem migration**. ⚠️ **Requer deploy manual do `disparar-pedidos-aprovados` via chat do Lovable APÓS o merge** (verbatim da main).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Após merge — instruir o deploy (founder, chat do Lovable)**

Entregar ao founder o prompt: "Edit the existing edge function `disparar-pedidos-aprovados` and replace its code with the file `supabase/functions/disparar-pedidos-aprovados/index.ts` from the repo (branch main), verbatim. Do not modify the code."

- [ ] **Step 4: Smoke em produção (founder + eu)**

Confirmar **por comportamento** (não pela palavra do Lovable):
1. Pegar um pedido OBEN **já `disparado`** (com `omie_pedido_compra_id`). No SQL Editor, resetar para re-disparo de teste **NÃO** — em vez disso, escolher um pedido `aprovado_aguardando_disparo` de fornecedor não-Sayerlack e dispará-lo 2× rápido (ou disparar 1× e, antes do status virar, o cron pega).
2. **Critério de sucesso:** o 2º disparo resulta em `status='disparado'` com `resposta_canal.reconciliado=true` (NÃO `falha_envio`), e **um único** PV no Omie.
3. **Capturar o `faultstring` real** do erro de duplicado no log da edge (Lovable → Edge functions → logs). Se o texto não casar com `isOmiePedidoJaCadastrado`, abrir follow-up: adicionar um teste com o texto exato + ajustar o regex (Task 1).

---

## Self-Review

**Spec coverage (§4.3):** (A) tratamento "já cadastrado" → reconciliação ✅ Task 2. (B) endurecer claim do portal: (iii) UPDATE condicional ✅ Task 3 Step 2; pré-check `enviando_portal` ✅ Task 3 Step 1. (ii) normalizar NULL→pendente: o `:428` JÁ setava `pendente` (normaliza) e a versão condicional mantém isso (NULL/`nao_aplicavel` ≠ `enviando_portal` → passa o `.neq` e é normalizado) ✅. Guard `omie_pedido_compra_id IS NULL` antes de criar — **fora deste sub-PR** (a reconciliação já fecha o caso real; o guard pré-criação é defesa-extra opcional, registrar pra um sub-PR menor se quiser).

**Placeholder scan:** sem TBD/TODO; todo código é completo. As 2 dependências de implementação (texto do erro, `ConsultarPedCompra` aceita `cCodIntPed`) têm fallback explícito e são confirmadas no smoke — não são placeholders, são pontos de verificação com caminho definido.

**Type consistency:** `isOmiePedidoJaCadastrado(string|null|undefined): boolean` e `extrairPedidoOmie(unknown): {id,numero}|null` — assinaturas idênticas no helper (Task 1) e no espelho da edge (Task 2). `ProcessResult.status_final/omie_id/omie_numero` já existem (`:228`, usados em `:707-709`).

**Escopo:** edge-only, sem migration, mergeável sozinho. O 2º ponto de entrada (`DispararAgoraButton` → portal direto) é cortado na Fase 3; aqui o endurecimento cobre o caminho principal (`iniciarEnvioPortalSayerlack`).
