# Picking — Auto-detect Mobile (roteamento touch) — Design Spec

> **Data:** 2026-05-25
> **Status:** aprovado no brainstorming
> **Contexto:** último scaffold pendente do offline-first/picking (§9b do CLAUDE.md). A `TouchPickingView` já confirma item offline (PR #250); falta só rotear o separador automaticamente pra ela.

## Goal

Separador no chão (celular/coletor, touch-primário) que abre `/admin/estoque/picking` deve cair **direto na visão de chão** (`TouchPickingView`, cards grandes, scan-first), sem ter que saber a rota `/mobile`. Gestor no desktop continua na visão de 4 abas. Com escape hatch nos dois sentidos.

## Decisões (brainstorming)

1. **Detecção = `useIsTouchDevice()`** (já existe: `(hover: none) and (pointer: coarse)`). É touch-primário real (celular/coletor), não largura de tela — notebook em janela estreita ou com tela touch **não** casa (o próprio hook documenta por que largura é proxy errado). Alinha com §5 do CLAUDE.md.
2. **Auto-redirect** (não banner de sugestão): separador é o usuário mobile dominante e quer zero toques; gestor no celular é raro e tem o escape hatch.
3. **Escape hatch bidirecional + preferência sticky:** link "Ver versão completa" na mobile força desktop (persistido); link "Versão de chão" na desktop volta pro auto.
4. **Sem migration, sem tocar mutação/dados.** Só roteamento + 1 hook puro + 2 links.

## Arquitetura

### `src/lib/picking/view-pref.ts` (novo)

```ts
const KEY = 'picking_view';

/** True quando o usuário forçou a versão completa (desktop) num dispositivo touch. */
export function getForceFullPref(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'full';
  } catch {
    return false;
  }
}

export function setForceFull(force: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (force) localStorage.setItem(KEY, 'full');
    else localStorage.removeItem(KEY);
  } catch {
    // quota/privacy — ignora
  }
}

/** Decisão pura: separador touch sem preferência forçada → vai pra visão de chão. */
export function shouldRedirectToMobile(opts: { isTouch: boolean; forceFull: boolean }): boolean {
  return opts.isTouch && !opts.forceFull;
}
```

### `AdminEstoquePicking.tsx` (desktop, 4 abas)

- No topo do componente:
  ```ts
  const navigate = useNavigate();
  const isTouch = useIsTouchDevice();
  useEffect(() => {
    if (shouldRedirectToMobile({ isTouch, forceFull: getForceFullPref() })) {
      navigate('/admin/estoque/picking/mobile', { replace: true });
    }
  }, [isTouch, navigate]);
  ```
  `useIsTouchDevice` começa `false` e vira `true` após mount → o redirect dispara quando o sinal confirma touch.
- No header, um link discreto "Versão de chão (mobile) →" que faz `setForceFull(false); navigate('/admin/estoque/picking/mobile')`.

### `TouchPickingView.tsx` (mobile)

- Um link discreto "Ver versão completa →" que faz `setForceFull(true); navigate('/admin/estoque/picking')`. Como `forceFull` fica `true`, a desktop não redireciona de volta.

## Data flow

```
[separador touch abre /admin/estoque/picking]
  → useIsTouchDevice vira true → shouldRedirectToMobile(true, forceFull=false) → navigate(/mobile, replace)
  → TouchPickingView
[separador toca "Ver versão completa"]
  → setForceFull(true) + navigate(/picking) → desktop não redireciona (forceFull=true) → 4 abas
[na desktop, toca "Versão de chão"]
  → setForceFull(false) + navigate(/mobile) → volta pro auto (próxima visita a /picking redireciona)
[gestor desktop (não-touch) abre /picking]
  → shouldRedirectToMobile(false, ...) = false → fica nas 4 abas
```

## Error handling / edge cases

- `localStorage` indisponível (privacidade) → `getForceFullPref` retorna `false` (sempre auto-redireciona em touch); aceitável.
- SSR/sem `window` → `useIsTouchDevice` retorna `false` (sem redirect); só roda no cliente.
- `replace: true` evita poluir o histórico (voltar não fica preso num loop desktop↔mobile).

## Testing

- **`shouldRedirectToMobile` (TDD):** touch + !forceFull → true; touch + forceFull → false; !touch → false.
- **`getForceFullPref`/`setForceFull`:** set true → getForceFullPref true; set false → false; tolera ausência.
- Suíte completa verde.
- **QA manual:** DevTools → emular dispositivo touch (Responsive + touch) → abrir `/admin/estoque/picking` → cai na mobile → "Ver versão completa" → fica na desktop (mesmo touch) → "Versão de chão" → volta. Desktop normal (mouse) → fica nas 4 abas.

## Out-of-scope

- Persistir preferência por usuário no banco (hoje só localStorage por dispositivo — correto, é preferência de device).
- Detecção por departamento/persona (futuro RBAC, §5/§8).
