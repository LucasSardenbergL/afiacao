# G1 Fase 3 — Fluidez (painel de contexto + pedido com retorno) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps usam checkbox (`- [ ]`).

**Goal:** Dar fluidez de execução ao Meu Dia — abrir o contexto de um item da fila num painel lateral (sem sair) e montar pedido com cliente pré-selecionado + retorno preservado à fila.

**Architecture:** Tudo **flag-gated** (`useFeatureFlag('filaContextPanel', false)`) e **isolado no painel** — a linha da fila (Fase 2, em piloto) NÃO muda. `FilaContextPanel` (shadcn `Sheet`) abre do item, despacha por `payload.kind`, **reusa** `AcaoOutcomeMenu` (outcomes) + adiciona contexto (ficha/telefone/família) e "Continuar pedido". O pedido vai pra `/sales/new?customer=&returnTo=` (pré-seleção JÁ existe no UnifiedOrder) e o `OrderSuccessDialog` ganha "Voltar pra fila".

**Tech Stack:** React 18 + TS + Vite + react-router-dom + shadcn (`Sheet`) + `@/lib/analytics`. Spec: `docs/superpowers/specs/2026-06-04-g1-fase3-fluidez-design.md`.

**Decisões fechadas (spec + investigação):**
- Formato B (painel sob demanda); split/pin (C) e WhatsApp inline ficam pós-piloto.
- WhatsApp NÃO entra (a fonte está desligada na fila v1) → sem realtime no painel, sem o risco P2.
- Pré-seleção de cliente já existe: `/sales/new?customer=<userId>`. O retorno = `returnTo` lido no UnifiedOrder + botão no OrderSuccessDialog.
- A linha da fila e o `AcaoCta`/`AcaoOutcomeMenu` da Fase 2 ficam **intactos** (a fluidez nova vive só no painel, sob flag).

---

## File Structure
- **Create** `src/components/fila/FilaContextPanel.tsx` — Sheet lateral; contexto + ações por `payload.kind`.
- **Modify** `src/components/fila/FilaDoDia.tsx` — flag + item ativo + abrir/fechar painel + telemetria.
- **Modify** `src/pages/UnifiedOrder.tsx` — ler `returnTo` e repassar ao dialog.
- **Modify** `src/components/OrderSuccessDialog.tsx` — botão "Voltar pra fila" quando `returnTo`.
- **Modify** `src/pages/SettingsConfig.tsx` — toggle da flag `filaContextPanel`.

---

## Task 1: Flag + esqueleto do `FilaContextPanel` + abrir/fechar na FilaDoDia

**Files:** Create `src/components/fila/FilaContextPanel.tsx`; Modify `src/components/fila/FilaDoDia.tsx`.

- [ ] **Step 1: Criar `FilaContextPanel.tsx` (esqueleto)**

```tsx
// src/components/fila/FilaContextPanel.tsx
// Painel lateral de contexto de um item da fila (G1 Fase 3, flag-gated).
// Reusa AcaoOutcomeMenu (outcomes) e adiciona contexto + "Continuar pedido".
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import type { AcaoSugerida, CategoriaAcao } from '@/lib/fila/types';

const CAT_LABEL: Record<CategoriaAcao, string> = {
  prazo: 'Prazo', certo: 'Certo', esperado: 'Oportunidade', risco: 'Risco',
};

interface Props {
  acao: AcaoSugerida | null;
  onClose: () => void;
}

/** Conteúdo por fonte entra na Task 2. Aqui só o casulo (Sheet + header). */
export function FilaContextPanel({ acao, onClose }: Props) {
  return (
    <Sheet open={acao !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {acao && (
          <>
            <SheetHeader>
              <SheetTitle className="text-base">{acao.clienteNome ?? acao.titulo}</SheetTitle>
              <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                <Badge variant="outline" className="text-2xs">{CAT_LABEL[acao.categoria]}</Badge>
                <span>{acao.motivo}</span>
              </div>
            </SheetHeader>
            <div className="mt-4 text-sm text-muted-foreground">{/* conteúdo por kind — Task 2 */}</div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Integrar na `FilaDoDia.tsx`** — imports no topo:
```tsx
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { FilaContextPanel } from './FilaContextPanel';
```
Dentro de `FilaDoDia()`, após o `useState` de `escondidos`:
```tsx
  const [painelOn] = useFeatureFlag('filaContextPanel', false);
  const [itemAtivo, setItemAtivo] = useState<AcaoSugerida | null>(null);
  const abrirPainel = (a: AcaoSugerida) => {
    setItemAtivo(a);
    track('fila.painel_aberto', { fonte: a.fonte, dedupeKey: a.dedupeKey });
  };
```
(`AcaoSugerida` já está importado; `track` também.)

- [ ] **Step 3: Affordance de abertura (só com flag ON)** — na linha do item, o título hoje é um `<Link>` pro 360. Com a flag ON, trocar o clique do título por abrir o painel; com OFF, manter o `<Link>`. Onde hoje está:
```tsx
{href ? (
  <Link to={href} className="block text-sm font-medium truncate hover:underline">{a.titulo}</Link>
) : (
  <div className="text-sm font-medium truncate">{a.titulo}</div>
)}
```
trocar por:
```tsx
{painelOn ? (
  <button type="button" onClick={() => abrirPainel(a)} className="block text-left text-sm font-medium truncate hover:underline w-full">{a.titulo}</button>
) : href ? (
  <Link to={href} className="block text-sm font-medium truncate hover:underline">{a.titulo}</Link>
) : (
  <div className="text-sm font-medium truncate">{a.titulo}</div>
)}
```

- [ ] **Step 4: Renderizar o painel** — antes do fechamento do componente (depois do `</Card>` do return principal), adicionar:
```tsx
      {painelOn && <FilaContextPanel acao={itemAtivo} onClose={() => setItemAtivo(null)} />}
```
(envolver o return num fragment `<>...</>` se necessário.)

- [ ] **Step 5: Typecheck** — `heavy bun run typecheck` → 0 erros.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(fila): FilaContextPanel (Sheet) flag-gated + abrir do item (G1 Fase 3)"`

---

## Task 2: Conteúdo do painel por `payload.kind` (reusa AcaoOutcomeMenu)

**Files:** Modify `src/components/fila/FilaContextPanel.tsx`.

- [ ] **Step 1: Implementar o corpo por kind.** Substituir o `<div>...conteúdo por kind...</div>` por um bloco que despacha. Imports no topo do arquivo:
```tsx
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { Phone, ExternalLink } from 'lucide-react';
import { AcaoOutcomeMenu } from './AcaoOutcomeMenu';
```
O painel precisa do `onNaoUtilAgora` (mesma semântica da fila) — adicionar à interface `Props`:
```tsx
  onNaoUtilAgora: (dedupeKey: string) => void;
```
Corpo (substitui o placeholder):
```tsx
            <div className="mt-4 space-y-4">
              {acao.telefone && (
                <Button asChild variant="outline" className="w-full justify-start gap-2">
                  <a href={`tel:${acao.telefone.replace(/\D/g, '')}`}><Phone className="w-4 h-4" /> Ligar para {acao.clienteNome ?? 'cliente'}</a>
                </Button>
              )}

              {acao.payload.kind === 'mixgap' && (
                <div className="rounded-md border p-3 text-2xs text-muted-foreground">
                  Oportunidade: oferecer <span className="font-medium text-foreground">{acao.payload.familia}</span>. {acao.motivo}
                </div>
              )}

              {acao.cta === 'pedido' && acao.clienteUserId && (
                <Button asChild className="w-full">
                  <Link to={`/sales/new?customer=${acao.clienteUserId}&returnTo=${encodeURIComponent('/meu-dia')}`}>Continuar pedido</Link>
                </Button>
              )}

              <div className="flex items-center justify-between">
                <AcaoOutcomeMenu acao={acao} onNaoUtilAgora={(k) => { onNaoUtilAgora(k); onClose(); }} />
                {acao.clienteUserId && (
                  <Button asChild variant="ghost" size="sm" className="gap-1 text-2xs">
                    <Link to={`/admin/customers/${acao.clienteUserId}/360`}><ExternalLink className="w-3.5 h-3.5" /> Ver ficha completa</Link>
                  </Button>
                )}
              </div>
            </div>
```

- [ ] **Step 2: Passar `onNaoUtilAgora` da FilaDoDia ao painel** — em `FilaDoDia.tsx`, na renderização do painel:
```tsx
      {painelOn && <FilaContextPanel acao={itemAtivo} onClose={() => setItemAtivo(null)} onNaoUtilAgora={ocultar} />}
```
(`ocultar` já existe na FilaDoDia da Fase 2.)

- [ ] **Step 3: Typecheck** — `heavy bun run typecheck` → 0 erros. Confirmar o discriminated union: `acao.payload.familia` só existe quando `kind === 'mixgap'` (o guard `acao.payload.kind === 'mixgap'` estreita).
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(fila): conteúdo do painel por fonte + Continuar pedido (G1 Fase 3)"`

---

## Task 3: Retorno do pedido (`returnTo` no UnifiedOrder + OrderSuccessDialog)

**Files:** Modify `src/pages/UnifiedOrder.tsx`, `src/components/OrderSuccessDialog.tsx`.

⚠️ Money-path (UnifiedOrder). A mudança é **só navegação** (não toca `submitOrder`/criação). LEIA os dois arquivos antes.

- [ ] **Step 1: `UnifiedOrder.tsx` — ler `returnTo`.** Onde hoje há `const preselectCustomerId = searchParams.get('customer');` (L53), adicionar:
```tsx
  const returnTo = searchParams.get('returnTo');
```
No `<OrderSuccessDialog .../>` (≈L332), passar a prop nova:
```tsx
          returnTo={returnTo}
          onVoltarFila={() => { h.setOrderSuccessOpen(false); if (returnTo) h.navigate(returnTo); }}
```

- [ ] **Step 2: `OrderSuccessDialog.tsx` — botão condicional.** LEIA o componente pra ver as props/estrutura dos botões. Adicionar à interface de props:
```tsx
  returnTo?: string | null;
  onVoltarFila?: () => void;
```
No rodapé de ações do dialog, quando `returnTo` existe, renderizar como **ação primária** (antes do "Ver pedido"):
```tsx
      {returnTo && onVoltarFila && (
        <Button onClick={onVoltarFila}>Voltar pra fila</Button>
      )}
```
(usar o mesmo `Button` que o componente já importa; manter os botões existentes — "Ver pedido"/"Compartilhar" — inalterados.)

- [ ] **Step 3: Typecheck** — `heavy bun run typecheck` → 0 erros.
- [ ] **Step 4: Smoke manual mental / test:** confirmar que sem `returnTo` o dialog é idêntico ao atual (o botão novo não aparece). Sem `returnTo`, `onVoltarFila` não é chamado.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(pedido): retorno à fila no OrderSuccessDialog via returnTo (G1 Fase 3)"`

---

## Task 4: Toggle da flag em /settings + telemetria de pedido + gate

**Files:** Modify `src/pages/SettingsConfig.tsx`; (telemetria já em FilaContextPanel via o Link — ver step 2).

- [ ] **Step 1: Telemetria do "Continuar pedido"** — no `FilaContextPanel.tsx`, no botão "Continuar pedido", adicionar `onClick={() => track('fila.pedido_iniciado', { fonte: acao.fonte, dedupeKey: acao.dedupeKey })}` (import `track` de `@/lib/analytics`).
- [ ] **Step 2: Toggle em `SettingsConfig.tsx`** — LEIA como outras flags são expostas (`useFeatureFlag`). Adicionar um toggle pra `filaContextPanel` (label: "Painel de contexto na fila (Meu Dia) — experimental"), seguindo o padrão visual das flags existentes na página. Se a página já tem uma seção de flags, acrescentar lá; senão, espelhar o padrão de `newVisual`/`useWebRTCCall`.
- [ ] **Step 3: Gate completo (FOREGROUND, aguardar cada um):**
  - `heavy bun run typecheck` → 0 erros
  - `heavy bun run test` → suite inteira verde
  - `heavy bun run build` → ok
  - `bun lint` → sem novos errors
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(fila): toggle da flag filaContextPanel em /settings + telemetria pedido (G1 Fase 3)"`

---

## Validação final (gate)
- [ ] Flag OFF → Meu Dia idêntico ao piloto (Fase 2): título volta a ser `<Link>` 360, sem painel.
- [ ] Flag ON → clicar no título abre o Sheet com contexto + outcomes + "Continuar pedido" (que pré-seleciona o cliente e volta pra fila ao finalizar).
- [ ] typecheck 0 · test verde · build ok · lint 0 errors.
- [ ] Revisão: nada money-path além da navegação do dialog; UnifiedOrder sem `returnTo` é idêntico ao atual.

## Não-objetivos (v1)
Pin/split persistente (C); WhatsApp inline no painel; fechar pedido dentro do painel; ficha rica com histórico/queries novas (o painel usa o que o item já tem + link 360); resize. Tudo guiado pelo sinal do piloto.

## Handoff
Abrir PR `feat/g1-fase3-fluidez` → main. **Sem migration, sem edge.** Mergear é seguro (flag OFF por padrão) — **NÃO ligar a flag durante o piloto**. Pós-piloto: ligar em `/settings` pra a vendedora e calibrar (se ela vive no WhatsApp → avaliar pin/split C + WhatsApp inline).
