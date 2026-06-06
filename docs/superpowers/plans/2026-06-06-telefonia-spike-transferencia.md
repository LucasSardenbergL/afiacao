# Spike — Transferência ao vivo (`*2`-DTMF / REFER) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Validar EMPIRICAMENTE se o Nvoip transfere uma chamada ativa (do ramal WebRTC) via feature-code `*2`+ramal (DTMF) e/ou via SIP `REFER`, **antes** de construir a Frente 2 (transferência manual). Resultado decide a implementação da F2.

**Architecture:** Spike **isolado e descartável**, atrás da feature flag `telefoniaTransferSpike` (default `false`, localStorage — não afeta ninguém em prod). Adiciona 2 métodos instrumentados ao `SipClient`, expõe um `spikeTransfer` no contexto (com o mesmo guard de lente do `makeCall`) e um painelzinho de teste montado global. A validação é **manual** (runbook do founder com 2 ramais) — não há teste automatizado porque o comportamento do JsSIP+Nvoip real não é mockável com valor. O critério de pronto é o founder reportar os sinais observáveis (Task 4).

**Tech Stack:** JsSIP (`RTCSession.sendDTMF` / `RTCSession.refer`), React, `useFeatureFlag` (localStorage), shadcn `Button`/`Input`.

**Spec:** `docs/superpowers/specs/2026-06-06-telefonia-roteamento-transferencia-design.md` (§4.3, §6).

> ⚠️ **Codex (revisão da sequência):** "enviar DTMF ≠ transferência concluída". O sucesso do spike NÃO é "o método não deu erro" — é o ciclo completo: **(1)** o ramal destino TOCA, **(2)** há ÁUDIO bidirecional depois que o destino atende, **(3)** a chamada original (vendedora↔cliente) ENCERRA corretamente, **(4)** o comportamento em FALHA (ramal inválido / ocupado / não atende) é são. Isso está no runbook (Task 4).

---

### Task 1: `SipClient` — métodos de transferência instrumentados

**Files:**
- Modify: `src/lib/sip/sip-client.ts` (adicionar 2 métodos públicos após `hangUp`, linha ~194)

- [ ] **Step 1: Implementar `transferViaDtmf` e `transferViaRefer`**

Inserir após o método `hangUp()` (depois da linha 194), antes de `getCallDurationSeconds()`:

```ts
  /**
   * SPIKE (descartável — flag telefoniaTransferSpike): tenta transferência via
   * feature-code DTMF do Nvoip (`*2` + ramal). O Nvoip documenta "*2 + ramal".
   * Requer chamada established. NÃO confirma a transferência — só envia os tons;
   * a validação é observar o ramal destino tocar (ver runbook do spike).
   */
  transferViaDtmf(extension: string): void {
    if (!this.currentSession) {
      console.warn('[transfer-spike] DTMF abortado: sem sessão ativa');
      return;
    }
    const tones = `*2${extension}`;
    console.info('[transfer-spike] enviando DTMF', { tones, sipCallId: this.currentSession.id });
    try {
      // JsSIP RTCSession.sendDTMF — RFC2833 por padrão (transport pode precisar de ajuste no spike)
      this.currentSession.sendDTMF(tones, { duration: 160, interToneGap: 120 });
      console.info('[transfer-spike] DTMF despachado (despacho OK ≠ transferência concluída — observe o ramal destino)');
    } catch (e) {
      console.error('[transfer-spike] falha ao despachar DTMF', e);
    }
  }

  /**
   * SPIKE (descartável): tenta transferência cega via SIP REFER p/ o ramal interno.
   * Instrumentado: loga a resposta ao REFER (202 vs 4xx/5xx) e os NOTIFY de
   * progresso (sipfrag 100/180/200/4xx). Requer chamada established.
   */
  transferViaRefer(extension: string): void {
    if (!this.currentSession) {
      console.warn('[transfer-spike] REFER abortado: sem sessão ativa');
      return;
    }
    const target = `sip:${extension}@${this.config.sipDomain}`;
    console.info('[transfer-spike] enviando REFER', { target, sipCallId: this.currentSession.id });
    try {
      this.currentSession.refer(target, {
        eventHandlers: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          requestSucceeded: (e: any) => console.info('[transfer-spike] REFER aceito (2xx)', e?.response?.status_code),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          requestFailed: (e: any) => console.warn('[transfer-spike] REFER RECUSADO', { cause: e?.cause, status: e?.response?.status_code }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          accepted: (e: any) => console.info('[transfer-spike] NOTIFY: transferência aceita', e?.request?.body),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          failed: (e: any) => console.warn('[transfer-spike] NOTIFY: transferência FALHOU', e?.request?.body),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          progress: (e: any) => console.info('[transfer-spike] NOTIFY: progresso', e?.request?.body),
        },
      });
      console.info('[transfer-spike] REFER despachado (aguardando NOTIFYs do Nvoip)');
    } catch (e) {
      console.error('[transfer-spike] falha ao despachar REFER', e);
    }
  }
```

- [ ] **Step 2: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS (sem novos erros). `currentSession` é `any` (já é no arquivo), então `.sendDTMF`/`.refer` não geram erro de tipo.

- [ ] **Step 3: Commit**

```bash
git add src/lib/sip/sip-client.ts
git commit -m "spike(telefonia): SipClient.transferViaDtmf/Refer instrumentados (flag-gated)"
```

---

### Task 2: `WebRTCCallContext` — expor `spikeTransfer` com guard de lente

**Files:**
- Modify: `src/contexts/WebRTCCallContext.tsx` (interface ~linha 59; implementação perto de `makeCall`; objeto `value` do Provider)

- [ ] **Step 1: Adicionar à interface `WebRTCCallContextValue`**

Após a linha do `toggleMute` na interface (`toggleMute: () => void;`, ~linha 59), adicionar:

```ts
  /** SPIKE (flag telefoniaTransferSpike): dispara transferência da chamada ativa p/ um ramal. */
  spikeTransfer?: (extension: string, method: 'dtmf' | 'refer') => void;
```

- [ ] **Step 2: Implementar o callback**

Logo após a definição de `makeCall` (após a linha 381, antes de `endCall`), adicionar — **mesmo guard de lente do `makeCall`** (CLAUDE.md §5: mutação SIP fura o write-guard do client, então gateia na fonte):

```ts
  const spikeTransfer = useCallback((extension: string, method: 'dtmf' | 'refer') => {
    if (isLensActive()) {
      toast.error('Transferência indisponível na lente (somente leitura).');
      return;
    }
    if (!clientRef.current) return;
    if (method === 'dtmf') clientRef.current.transferViaDtmf(extension);
    else clientRef.current.transferViaRefer(extension);
  }, []);
```

- [ ] **Step 3: Adicionar `spikeTransfer` ao objeto `value`**

No objeto passado ao `Provider` (onde `toggleMute` é incluído no value), adicionar `spikeTransfer,` na lista.

- [ ] **Step 4: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contexts/WebRTCCallContext.tsx
git commit -m "spike(telefonia): WebRTCCallContext.spikeTransfer (guard de lente)"
```

---

### Task 3: Painel de spike (UI) montado global

**Files:**
- Create: `src/components/call/TransferSpikePanel.tsx`
- Modify: `src/components/AppShellLayout.tsx` (montar junto do `IncomingCallModal`, linha ~60)

- [ ] **Step 1: Criar `TransferSpikePanel.tsx`**

```tsx
import { useState } from 'react';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { useWebRTCCallContextOptional } from '@/contexts/WebRTCCallContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * SPIKE (descartável, flag `telefoniaTransferSpike`): valida empiricamente se o Nvoip
 * transfere a chamada ativa via *2-DTMF ou REFER. Aparece SÓ durante chamada established
 * + flag ligada. Abra o DevTools console e filtre por "transfer-spike" pra ver as
 * respostas do Nvoip. Pra ligar a flag: console → localStorage.setItem('feature_flag_telefoniaTransferSpike','1')
 */
export function TransferSpikePanel() {
  const [enabled] = useFeatureFlag('telefoniaTransferSpike', false);
  const ctx = useWebRTCCallContextOptional();
  const [ext, setExt] = useState('');

  if (!enabled || !ctx?.isEstablished || !ctx.spikeTransfer) return null;

  return (
    <div className="fixed bottom-24 right-4 z-50 w-64 space-y-2 rounded-lg border border-status-warning/40 bg-card p-3 shadow-lg">
      <p className="text-xs font-medium text-status-warning">⚠ Spike transferência (teste)</p>
      <Input
        value={ext}
        onChange={(e) => setExt(e.target.value.trim())}
        placeholder="ramal destino (ex: 137973002)"
        className="text-sm"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!ext} onClick={() => ctx.spikeTransfer!(ext, 'dtmf')}>
          *2 DTMF
        </Button>
        <Button size="sm" variant="outline" disabled={!ext} onClick={() => ctx.spikeTransfer!(ext, 'refer')}>
          REFER
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">Console → filtro: transfer-spike</p>
    </div>
  );
}
```

- [ ] **Step 2: Montar no `AppShellLayout.tsx`**

Importar no topo (junto do import do `IncomingCallModal`):

```tsx
import { TransferSpikePanel } from './call/TransferSpikePanel';
```

E renderizar logo após `<IncomingCallModal />` (linha ~60):

```tsx
      <IncomingCallModal />
      <TransferSpikePanel />
```

- [ ] **Step 3: Typecheck + build**

Run: `heavy bun run typecheck && heavy bun run build`
Expected: PASS. (build garante que o lazy/chunking não quebra.)

- [ ] **Step 4: Commit**

```bash
git add src/components/call/TransferSpikePanel.tsx src/components/AppShellLayout.tsx
git commit -m "spike(telefonia): painel de teste de transferência (flag-gated, global)"
```

---

### Task 4: Runbook de validação (founder) — o CRITÉRIO DE PRONTO

> Esta task não é código — é o experimento. O founder executa e reporta. **Sem isto, o spike não tem valor.**

**Pré-requisitos:**
1. Dois ramais SIP de teste no Nvoip (A e B) cadastrados em `vendor_sip_credentials` e vinculados a 2 usuários (ver `/admin/sip-credentials`). A e B logados em 2 navegadores (ou 2 perfis/abas anônimas) diferentes.
2. Frontend publicado no Lovable (o spike está no bundle só após Publish).
3. Em cada navegador: abrir DevTools → Console. Ligar a flag: `localStorage.setItem('feature_flag_telefoniaTransferSpike','1')` e recarregar.

- [ ] **Cenário 1 — `*2` DTMF (caminho feliz):** A liga pra um celular real (do founder). Atende. Com a chamada established, no painel de spike de A: digitar o ramal de **B** → clicar **`*2` DTMF**. **Observar e anotar:**
  - O telefone/navegador de **B toca**? (sinal nº 1)
  - B atende → há **áudio** entre o celular e B? (sinal nº 2)
  - A chamada de **A encerra** sozinha/corretamente? (sinal nº 3)
  - Copiar as linhas `[transfer-spike]` do console de A.

- [ ] **Cenário 2 — `REFER` (caminho feliz):** repetir o Cenário 1, mas clicar **REFER**. Anotar os mesmos 3 sinais + as linhas `[transfer-spike]` (a resposta `REFER aceito (2xx)` vs `RECUSADO`, e os `NOTIFY`).

- [ ] **Cenário 3 — falhas:** repetir com (a) ramal **inválido**, (b) B **ocupado** (em outra ligação), (c) B **não atende**. Anotar o que acontece com a chamada de A em cada caso (ela volta? cai? trava?).

- [ ] **Reportar:** colar no chat os 3 sinais por cenário + os logs `[transfer-spike]`. **Decisão:**
  - `*2` cumpre os 3 sinais → **F2 usa `*2`-DTMF**.
  - REFER cumpre os 3 sinais (e manda NOTIFYs) → **F2 usa REFER** (melhor rastreio).
  - Nenhum cumpre → **F2 vira handoff + ligar-de-volta** (sem leg ao vivo); o owner-first/transferência ao vivo exigiria o PABX (registrado no spec §3).

---

### Task 5: Registrar resultado e decidir o caminho da F2

**Files:**
- Modify: `docs/superpowers/specs/2026-06-06-telefonia-roteamento-transferencia-design.md` (anotar o resultado do spike em §6)

- [ ] **Step 1:** Anotar na tabela de gates da §6 o veredito do spike (`*2` / REFER / nenhum) + colar um resumo dos sinais observados.
- [ ] **Step 2:** Commit.

```bash
git add docs/superpowers/specs/2026-06-06-telefonia-roteamento-transferencia-design.md
git commit -m "spike(telefonia): registra resultado do spike de transferência"
```

- [ ] **Step 3 (limpeza, após decidir):** o painel/flag são descartáveis. Quando a F2 for implementada, remover `TransferSpikePanel` + a flag + (se a F2 usar outra abstração) os métodos de spike do `SipClient`, OU promovê-los pra a implementação real da F2 — decidir no plano da F2.

---

## Self-Review

- **Spec coverage:** cobre o gate "`*2`/REFER funciona" da §6 do spec. Os outros gates (evento Nvoip de perdida; filas) são da F1, fora deste plano. ✅
- **Placeholders:** nenhum — todo código é real; a Task 4 é deliberadamente um runbook manual (natureza do spike), não um placeholder.
- **Type consistency:** `spikeTransfer(extension, method: 'dtmf'|'refer')` é idêntico na interface (Task 2.1), no callback (Task 2.2) e no uso (Task 3.1). `transferViaDtmf`/`transferViaRefer` idênticos entre SipClient (Task 1) e o callback (Task 2.2). ✅
- **Escopo:** isolado e descartável (flag), conforme o Codex. Não toca o caminho de produção do `makeCall`/`endCall`. ✅
