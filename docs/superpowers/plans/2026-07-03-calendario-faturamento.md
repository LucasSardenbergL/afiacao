# Calendário de Faturamento (Pedidos Programados) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visão de calendário mensal em `/sales/programados` mostrando, por dia, os envios de pedidos programados (contagem, R$ e status), com painel lateral só-leitura ao clicar no dia.

**Architecture:** Feature 100% frontend de leitura (sem migration, sem edge). Helper puro de agregação por dia (testado com vitest) + hook de query por mês (1 fetch com embed PostgREST) + componente de grade própria (CSS grid 7×6, date-free no helper — datas como string) + toggle Lista|Calendário via `useUrlState`. Spec: `docs/superpowers/specs/2026-07-03-calendario-faturamento-design.md`.

**Tech Stack:** React 18 + TS strict, @tanstack/react-query v5, supabase-js (PostgREST), shadcn (`Sheet`), Tailwind (tokens `status-*`), date-fns/ptBR (só formatação de exibição), vitest.

---

## Regras do repo que VALEM para todas as tasks (CLAUDE.md)

- Responder/commitar em **pt-BR**. Commits terminam com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Comandos pesados SEMPRE prefixados `heavy` (ex.: `heavy bun run test`, `heavy bun run typecheck`). `| tail` engole exit code — use `> log 2>&1; echo $?` se precisar do exit.
- **Money-path — ausente ≠ zero:** valor com preço faltando propaga `null` (UI mostra "—"), NUNCA soma como 0.
- Datas DATE do banco: agrupar/comparar por **string** `YYYY-MM-DD`; exibir via `new Date(\`${d}T12:00:00\`)` (padrão do repo). NUNCA `new Date('YYYY-MM-DD')` cru.
- Status colors: `text-status-success/error/info/warning` — nunca cor crua (`text-red-600` etc.).
- Toast: só `sonner`. Analytics: `track()` de `@/lib/analytics` com `<area>.<action>`.
- NÃO tocar em `supabase/migrations/` nem em edges — esta feature não tem backend.
- Tabelas novas estão FORA dos tipos gerados do Supabase → usar o cast `t()` já existente em `usePedidosProgramados.ts`.

## Estrutura de arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `src/lib/pedidosProgramados/calendario.ts` | Create | Helper PURO (zero imports): tipos, `valorDoEnvio`, `agruparEnviosPorDia`, `gerarDiasDaGrade`, `dataLocalISO` |
| `src/lib/pedidosProgramados/calendario.test.ts` | Create | Testes vitest do helper |
| `src/hooks/usePedidosProgramados.ts` | Modify | + `usePedidosProgramadosCalendario(mes)` (query do mês, normalização na borda, guard de truncamento) |
| `src/components/pedidosProgramados/CalendarioFaturamento.tsx` | Create | Grade, header de navegação, célula, Sheet do dia |
| `src/pages/PedidosProgramados.tsx` | Modify | Toggle Lista\|Calendário via `useUrlState` |

---

### Task 1: Helper puro `calendario.ts` (TDD)

**Files:**
- Create: `src/lib/pedidosProgramados/calendario.ts`
- Test: `src/lib/pedidosProgramados/calendario.test.ts`

- [ ] **Step 1: Escrever os testes (falham — módulo não existe)**

Criar `src/lib/pedidosProgramados/calendario.test.ts` com exatamente:

```ts
import { describe, it, expect } from 'vitest';
import {
  agruparEnviosPorDia,
  gerarDiasDaGrade,
  valorDoEnvio,
  dataLocalISO,
  type EnvioCalendario,
  type ItemEnvioCalendario,
} from './calendario';

const item = (over: Partial<ItemEnvioCalendario> = {}): ItemEnvioCalendario => ({
  quantidade: 2,
  preco_final: 10,
  account: 'oben',
  ...over,
});

const envio = (over: Partial<EnvioCalendario> = {}): EnvioCalendario => ({
  id: 'e1',
  pedido_programado_id: 'p1',
  numero_pedido_compra: '213294',
  data_envio: '2026-07-16',
  status: 'agendado',
  erro_motivo: null,
  itens: [item()],
  ...over,
});

describe('valorDoEnvio', () => {
  it('soma preco_final × quantidade', () => {
    expect(valorDoEnvio([item(), item({ quantidade: 3, preco_final: 5 })])).toBe(35);
  });
  it('envio sem itens → null (estado anômalo, não fabricar 0)', () => {
    expect(valorDoEnvio([])).toBeNull();
  });
  it('qualquer item sem preço → null (ausente ≠ zero)', () => {
    expect(valorDoEnvio([item(), item({ preco_final: null })])).toBeNull();
  });
  it('preço/quantidade inválidos (0, negativo, NaN) → null', () => {
    expect(valorDoEnvio([item({ preco_final: 0 })])).toBeNull();
    expect(valorDoEnvio([item({ quantidade: -1 })])).toBeNull();
    expect(valorDoEnvio([item({ preco_final: Number.NaN })])).toBeNull();
  });
});

describe('agruparEnviosPorDia', () => {
  it('agrupa por data_envio (string, sem Date)', () => {
    const mapa = agruparEnviosPorDia([
      envio({ id: 'a' }),
      envio({ id: 'b', itens: [item({ preco_final: 100, quantidade: 1 })] }),
      envio({ id: 'c', data_envio: '2026-07-23' }),
    ]);
    expect(mapa.get('2026-07-16')?.ativos).toBe(2);
    expect(mapa.get('2026-07-16')?.totalValor).toBe(120);
    expect(mapa.get('2026-07-23')?.ativos).toBe(1);
    expect(mapa.size).toBe(2);
  });
  it('valor null de um envio ativo propaga para o dia (ausente ≠ zero)', () => {
    const mapa = agruparEnviosPorDia([envio(), envio({ id: 'b', itens: [item({ preco_final: null })] })]);
    expect(mapa.get('2026-07-16')?.totalValor).toBeNull();
    expect(mapa.get('2026-07-16')?.ativos).toBe(2);
  });
  it('cancelado: fora de ativos/soma/dots, mas presente na lista do painel', () => {
    const mapa = agruparEnviosPorDia([envio(), envio({ id: 'b', status: 'cancelado', itens: [item({ preco_final: 999 })] })]);
    const dia = mapa.get('2026-07-16')!;
    expect(dia.ativos).toBe(1);
    expect(dia.totalValor).toBe(20);
    expect(dia.statusPresentes).toEqual(['agendado']);
    expect(dia.envios).toHaveLength(2);
  });
  it('dia com APENAS cancelados: ativos 0 e totalValor null (célula trata como vazio)', () => {
    const dia = agruparEnviosPorDia([envio({ status: 'cancelado' })]).get('2026-07-16')!;
    expect(dia.ativos).toBe(0);
    expect(dia.totalValor).toBeNull();
    expect(dia.statusPresentes).toEqual([]);
  });
  it('temErro quando há envio erro; dots em ordem fixa agendado→enviado→erro', () => {
    const dia = agruparEnviosPorDia([
      envio({ id: 'x', status: 'erro', erro_motivo: 'boom' }),
      envio({ id: 'y', status: 'enviado' }),
      envio({ id: 'z', status: 'agendado' }),
    ]).get('2026-07-16')!;
    expect(dia.temErro).toBe(true);
    expect(dia.statusPresentes).toEqual(['agendado', 'enviado', 'erro']);
  });
  it('empresas: set dos accounts dos itens; item sem mapa (account null) não quebra', () => {
    const dia = agruparEnviosPorDia([
      envio({ itens: [item(), item({ account: 'colacor' }), item({ account: null })] }),
    ]).get('2026-07-16')!;
    expect(dia.envios[0].empresas).toEqual(['oben', 'colacor']);
  });
  it('envio sem itens: semItens true e valor null', () => {
    const dia = agruparEnviosPorDia([envio({ itens: [] })]).get('2026-07-16')!;
    expect(dia.envios[0].semItens).toBe(true);
    expect(dia.envios[0].valor).toBeNull();
    expect(dia.totalValor).toBeNull();
  });
});

describe('gerarDiasDaGrade', () => {
  it('julho/2026 (1º cai na quarta): 42 células dom→sáb, começa 28/jun', () => {
    const dias = gerarDiasDaGrade('2026-07');
    expect(dias).toHaveLength(42);
    expect(dias[0]).toEqual({ data: '2026-06-28', diaDoMes: 28, foraDoMes: true });
    expect(dias[3]).toEqual({ data: '2026-07-01', diaDoMes: 1, foraDoMes: false });
    expect(dias[5].data).toBe('2026-07-03');
    expect(dias[41].data).toBe('2026-08-08');
  });
  it('fevereiro/2026 (1º é domingo): começa no próprio dia 1', () => {
    const dias = gerarDiasDaGrade('2026-02');
    expect(dias[0]).toEqual({ data: '2026-02-01', diaDoMes: 1, foraDoMes: false });
    expect(dias[27].data).toBe('2026-02-28');
    expect(dias[28]).toEqual({ data: '2026-03-01', diaDoMes: 1, foraDoMes: true });
  });
  it('janeiro/2026: vira o ano para trás sem shift de fuso', () => {
    expect(gerarDiasDaGrade('2026-01')[0].data).toBe('2025-12-28');
  });
});

describe('dataLocalISO', () => {
  it('formata Date local como YYYY-MM-DD com zero à esquerda', () => {
    expect(dataLocalISO(new Date(2026, 6, 3))).toBe('2026-07-03');
    expect(dataLocalISO(new Date(2026, 0, 9))).toBe('2026-01-09');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha por módulo inexistente**

Run: `heavy bun run test -- src/lib/pedidosProgramados/calendario.test.ts`
Expected: FAIL — `Cannot find module './calendario'` (ou "Failed to resolve import").

- [ ] **Step 3: Implementar o helper**

Criar `src/lib/pedidosProgramados/calendario.ts` com exatamente:

```ts
// Agregação da visão de calendário (/sales/programados?view=calendario).
// PURO e sem imports: datas viajam como STRING 'YYYY-MM-DD' — nunca new Date('YYYY-MM-DD'),
// que interpreta UTC e desloca o dia no fuso local. Money-path: valor ausente propaga
// null (ausente ≠ zero — CLAUDE.md); soma de estado anômalo não vira 0 fabricado.

export type StatusEnvio = 'agendado' | 'enviado' | 'erro' | 'cancelado';
export type AccountPP = 'oben' | 'colacor';

export interface ItemEnvioCalendario {
  quantidade: number;
  preco_final: number | null;
  account: AccountPP | null; // null = item sem mapeamento (não derruba a agregação)
}

export interface EnvioCalendario {
  id: string;
  pedido_programado_id: string;
  numero_pedido_compra: string | null;
  data_envio: string; // 'YYYY-MM-DD' direto do banco
  status: StatusEnvio;
  erro_motivo: string | null;
  itens: ItemEnvioCalendario[];
}

export interface EnvioDia extends EnvioCalendario {
  valor: number | null;
  empresas: AccountPP[];
  semItens: boolean;
}

export interface DiaAgregado {
  envios: EnvioDia[]; // todos, inclusive cancelados (painel)
  ativos: number; // status !== 'cancelado'
  totalValor: number | null; // soma dos ativos; null se algum ativo tiver valor null
  temErro: boolean;
  statusPresentes: StatusEnvio[]; // sem 'cancelado', ordem fixa p/ os dots
}

export function valorDoEnvio(itens: ItemEnvioCalendario[]): number | null {
  if (itens.length === 0) return null;
  let total = 0;
  for (const it of itens) {
    if (!(Number.isFinite(it.preco_final as number) && (it.preco_final as number) > 0)) return null;
    if (!(Number.isFinite(it.quantidade) && it.quantidade > 0)) return null;
    total += (it.preco_final as number) * it.quantidade;
  }
  return total;
}

const ORDEM_STATUS: StatusEnvio[] = ['agendado', 'enviado', 'erro'];

export function agruparEnviosPorDia(envios: EnvioCalendario[]): Map<string, DiaAgregado> {
  const porDia = new Map<string, DiaAgregado>();
  for (const envio of envios) {
    const dia: DiaAgregado = porDia.get(envio.data_envio) ?? {
      envios: [],
      ativos: 0,
      totalValor: 0,
      temErro: false,
      statusPresentes: [],
    };
    const valor = valorDoEnvio(envio.itens);
    const empresas = [...new Set(
      envio.itens.map((i) => i.account).filter((a): a is AccountPP => a !== null),
    )];
    dia.envios.push({ ...envio, valor, empresas, semItens: envio.itens.length === 0 });
    if (envio.status !== 'cancelado') {
      dia.ativos += 1;
      dia.totalValor = dia.totalValor === null || valor === null ? null : dia.totalValor + valor;
      if (envio.status === 'erro') dia.temErro = true;
    }
    porDia.set(envio.data_envio, dia);
  }
  for (const dia of porDia.values()) {
    if (dia.ativos === 0) dia.totalValor = null; // só cancelados: não existe "R$ 0 a faturar"
    dia.statusPresentes = ORDEM_STATUS.filter((s) => dia.envios.some((e) => e.status === s));
  }
  return porDia;
}

export function dataLocalISO(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export interface DiaGrade {
  data: string; // 'YYYY-MM-DD'
  diaDoMes: number;
  foraDoMes: boolean;
}

// Grade fixa de 6 semanas (42 células), domingo→sábado. Date com construtor
// NUMÉRICO é local-time (seguro); o overflow de dia rola mês/ano sozinho.
export function gerarDiasDaGrade(mes: string): DiaGrade[] {
  const [ano, m] = mes.split('-').map(Number);
  const primeiro = new Date(ano, m - 1, 1);
  const offsetDomingo = primeiro.getDay();
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(ano, m - 1, 1 - offsetDomingo + i);
    return { data: dataLocalISO(d), diaDoMes: d.getDate(), foraDoMes: d.getMonth() !== m - 1 };
  });
}
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `heavy bun run test -- src/lib/pedidosProgramados/calendario.test.ts`
Expected: PASS — 14 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pedidosProgramados/calendario.ts src/lib/pedidosProgramados/calendario.test.ts
git commit -m "feat(pedidos-programados): helper puro de agregação do calendário (TDD)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Hook `usePedidosProgramadosCalendario`

**Files:**
- Modify: `src/hooks/usePedidosProgramados.ts` (adicionar no fim do bloco de queries, após `usePedidosProgramadosConfig`, ~linha 133)

- [ ] **Step 1: Adicionar imports novos no topo do arquivo**

Em `src/hooks/usePedidosProgramados.ts`, trocar a linha 4:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
```

por:

```ts
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
```

e adicionar após a linha 8 (`import { ilikeOr, ... }`):

```ts
import type { EnvioCalendario, StatusEnvio } from '@/lib/pedidosProgramados/calendario';
```

- [ ] **Step 2: Adicionar o hook (colar após `usePedidosProgramadosConfig`, antes de `useBuscaProdutoMapeamento`)**

```ts
// Calendário de faturamento: 1 query por mês visível ('YYYY-MM').
// queryKey com prefixo 'pedidos-programados' → invalidação automática pelas
// mutations existentes (invalidar() usa exatamente esse prefixo).
interface EnvioCalendarioRow {
  id: string;
  pedido_programado_id: string;
  data_envio: string;
  status: StatusEnvio;
  erro_motivo: string | null;
  pedido: { numero_pedido_compra: string | null } | null;
  itens: Array<{
    quantidade: number | string;
    preco_final: number | string | null;
    mapa: { omie_products: { account: 'oben' | 'colacor' } | null } | null;
  }>;
}

const CAPA_POSTGREST = 1000;

export function usePedidosProgramadosCalendario(mes: string) {
  return useQuery({
    queryKey: ['pedidos-programados', 'calendario', mes],
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [ano, m] = mes.split('-').map(Number);
      const ultimoDia = new Date(ano, m, 0).getDate(); // dia 0 do mês seguinte = último do mês
      const { data, error } = await t('pedidos_programados_envios')
        .select(
          'id, pedido_programado_id, data_envio, status, erro_motivo, ' +
            'pedido:pedidos_programados(numero_pedido_compra), ' +
            'itens:pedidos_programados_itens(quantidade, preco_final, mapa:cliente_item_mapa(omie_products(account)))',
        )
        .gte('data_envio', `${mes}-01`)
        .lte('data_envio', `${mes}-${String(ultimoDia).padStart(2, '0')}`)
        .order('data_envio', { ascending: true })
        .limit(CAPA_POSTGREST);
      if (error) throw error;
      const rows = (data ?? []) as unknown as EnvioCalendarioRow[];
      const envios: EnvioCalendario[] = rows.map((r) => ({
        id: r.id,
        pedido_programado_id: r.pedido_programado_id,
        numero_pedido_compra: r.pedido?.numero_pedido_compra ?? null,
        data_envio: r.data_envio,
        status: r.status,
        erro_motivo: r.erro_motivo,
        itens: (r.itens ?? []).map((it) => ({
          // numeric do PostgREST pode vir string — converter na borda (padrão do arquivo)
          quantidade: Number(it.quantidade),
          preco_final: it.preco_final === null ? null : Number(it.preco_final),
          account: it.mapa?.omie_products?.account ?? null,
        })),
      }));
      // Capa silenciosa do PostgREST: impossível no volume atual, mas nunca confiar em silêncio
      return { envios, truncado: rows.length === CAPA_POSTGREST };
    },
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `heavy bun run typecheck`
Expected: exit 0, sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/usePedidosProgramados.ts
git commit -m "feat(pedidos-programados): query do calendário por mês (embed + Number na borda + guard de capa)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Componente `CalendarioFaturamento`

**Files:**
- Create: `src/components/pedidosProgramados/CalendarioFaturamento.tsx`

- [ ] **Step 1: Criar o componente**

Criar `src/components/pedidosProgramados/CalendarioFaturamento.tsx` com exatamente:

```tsx
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { track } from '@/lib/analytics';
import { usePedidosProgramadosCalendario } from '@/hooks/usePedidosProgramados';
import {
  agruparEnviosPorDia,
  dataLocalISO,
  gerarDiasDaGrade,
  type DiaAgregado,
  type StatusEnvio,
} from '@/lib/pedidosProgramados/calendario';

const DOT_CLS: Record<Exclude<StatusEnvio, 'cancelado'>, string> = {
  agendado: 'bg-status-info',
  enviado: 'bg-status-success',
  erro: 'bg-status-error',
};

const BADGE_CLS: Record<StatusEnvio, string> = {
  agendado: 'text-status-info',
  enviado: 'text-status-success',
  erro: 'text-status-error',
  cancelado: 'text-muted-foreground',
};

// Exibição de DATE: sempre via T12:00:00 (padrão do repo — evita shift de fuso)
const d12 = (data: string) => new Date(`${data}T12:00:00`);
const fmtMoeda = (v: number | null, opts?: Intl.NumberFormatOptions) =>
  v === null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', ...opts });
// Célula compacta: sem centavos. Painel: valor completo.
const fmtMoedaDia = (v: number | null) =>
  fmtMoeda(v, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const NOME_EMPRESA: Record<string, string> = { oben: 'Oben', colacor: 'Colacor' };

interface Props {
  mes: string; // 'YYYY-MM' já resolvido pela página
  onMudarMes: (mes: string) => void; // '' = voltar ao mês atual
}

export const CalendarioFaturamento = ({ mes, onMudarMes }: Props) => {
  const { data, isPending } = usePedidosProgramadosCalendario(mes);
  const [diaAberto, setDiaAberto] = useState<string | null>(null);

  const porDia = useMemo(() => agruparEnviosPorDia(data?.envios ?? []), [data?.envios]);
  const grade = useMemo(() => gerarDiasDaGrade(mes), [mes]);
  const hoje = dataLocalISO(new Date());

  const [ano, m] = mes.split('-').map(Number);
  const navegar = (delta: number) => {
    const alvo = new Date(ano, m - 1 + delta, 1);
    onMudarMes(dataLocalISO(alvo).slice(0, 7));
  };
  const tituloMes = format(new Date(ano, m - 1, 1), 'MMMM yyyy', { locale: ptBR });

  const diaSel: DiaAgregado | undefined = diaAberto ? porDia.get(diaAberto) : undefined;
  const mesVazio = !isPending && porDia.size === 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navegar(-1)} aria-label="Mês anterior">
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <span className="text-sm font-medium min-w-32 text-center capitalize">{tituloMes}</span>
        <Button variant="ghost" size="sm" onClick={() => navegar(1)} aria-label="Mês seguinte">
          <ChevronRight className="w-4 h-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => onMudarMes('')}>Hoje</Button>
        <div className="ml-auto flex items-center gap-3">
          {(['agendado', 'enviado', 'erro'] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn('w-1.5 h-1.5 rounded-full', DOT_CLS[s])} />{s}
            </span>
          ))}
        </div>
      </div>

      {data?.truncado && (
        <p className="text-xs text-status-warning">
          Mês truncado em 1.000 envios pela capa do PostgREST — os totais abaixo podem estar incompletos.
        </p>
      )}

      <div className="grid grid-cols-7 gap-1.5">
        {['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].map((d) => (
          <div key={d} className="text-[11px] text-muted-foreground px-1.5 pb-0.5">{d}</div>
        ))}
        {grade.map((dia) => {
          const info = porDia.get(dia.data);
          const clicavel = !dia.foraDoMes && !!info && info.ativos > 0;
          const ehHoje = dia.data === hoje;
          return (
            <button
              key={dia.data}
              type="button"
              disabled={!clicavel}
              onClick={() => {
                setDiaAberto(dia.data);
                track('pedidos_programados.calendario_dia', { data: dia.data });
              }}
              aria-label={
                clicavel
                  ? `${format(d12(dia.data), "EEEE, d 'de' MMMM", { locale: ptBR })} — ${info!.ativos} envio(s), ${fmtMoedaDia(info!.totalValor)}${info!.temErro ? ', com erro' : ''}`
                  : format(d12(dia.data), "d 'de' MMMM", { locale: ptBR })
              }
              className={cn(
                'min-h-[76px] rounded-md border p-1.5 text-left flex flex-col gap-0.5 transition-colors',
                dia.foraDoMes && 'border-transparent',
                clicavel && 'hover:bg-accent/50 cursor-pointer',
                clicavel && info!.temErro && 'border-status-error/50 bg-status-error-bg',
              )}
            >
              <span className="flex items-center justify-between text-xs">
                <span
                  className={cn(
                    dia.foraDoMes ? 'text-muted-foreground/50' : 'text-muted-foreground',
                    ehHoje && 'bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 font-medium',
                  )}
                >
                  {dia.diaDoMes}
                </span>
                {clicavel && info!.temErro && (
                  <AlertTriangle className="w-3.5 h-3.5 text-status-error" aria-hidden="true" />
                )}
              </span>
              {clicavel && (
                <>
                  <span className="text-xs font-medium">
                    {info!.ativos} {info!.ativos === 1 ? 'envio' : 'envios'}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmtMoedaDia(info!.totalValor)}
                  </span>
                  <span className="mt-auto flex gap-1">
                    {info!.statusPresentes.map((s) => (
                      <span
                        key={s}
                        className={cn('w-1.5 h-1.5 rounded-full', DOT_CLS[s as keyof typeof DOT_CLS])}
                      />
                    ))}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {mesVazio && (
        <p className="text-xs text-muted-foreground">Nenhum envio em {tituloMes}.</p>
      )}

      <Sheet open={!!diaAberto} onOpenChange={(open) => { if (!open) setDiaAberto(null); }}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          {diaAberto && (
            <>
              <SheetHeader>
                <SheetTitle className="capitalize">
                  {format(d12(diaAberto), "EEEE, d 'de' MMMM", { locale: ptBR })}
                </SheetTitle>
                <SheetDescription>
                  {diaSel
                    ? `${diaSel.ativos} envio(s) · ${fmtMoeda(diaSel.totalValor)}`
                    : 'Sem envios neste dia.'}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-3">
                {(diaSel?.envios ?? [])
                  .slice()
                  .sort((a, b) => (a.status === 'cancelado' ? 1 : 0) - (b.status === 'cancelado' ? 1 : 0))
                  .map((e) => (
                    <div key={e.id} className="border rounded-md px-3 py-2.5 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">PC {e.numero_pedido_compra ?? '—'}</span>
                        <Badge variant="outline" className={BADGE_CLS[e.status]}>{e.status}</Badge>
                        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
                          {e.semItens ? 'sem itens' : fmtMoeda(e.valor)}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {e.itens.length} {e.itens.length === 1 ? 'item' : 'itens'}
                        {e.empresas.length > 0 &&
                          ` · vira ${e.empresas.length} pedido${e.empresas.length > 1 ? 's' : ''}: ${e.empresas.map((a) => NOME_EMPRESA[a]).join(', ')}`}
                        {!e.semItens && e.valor === null && ' · valor incompleto (item sem preço)'}
                      </div>
                      {e.erro_motivo && <p className="text-xs text-status-error">{e.erro_motivo}</p>}
                      <Link
                        to={`/sales/programados/${e.pedido_programado_id}`}
                        className="text-xs text-primary hover:underline inline-block"
                      >
                        Abrir pedido →
                      </Link>
                    </div>
                  ))}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
};
```

- [ ] **Step 2: Typecheck + lint**

Run: `heavy bun run typecheck && bun lint > /tmp/lint.log 2>&1; echo $?`
Expected: typecheck exit 0; lint sem erro NOVO neste arquivo (warnings pré-existentes de outros arquivos não contam).

- [ ] **Step 3: Commit**

```bash
git add src/components/pedidosProgramados/CalendarioFaturamento.tsx
git commit -m "feat(pedidos-programados): componente do calendário (grade 7×6, célula com R\$/status, Sheet do dia)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Toggle Lista|Calendário na página

**Files:**
- Modify: `src/pages/PedidosProgramados.tsx`

- [ ] **Step 1: Aplicar as modificações**

Em `src/pages/PedidosProgramados.tsx`:

**(a)** Trocar os imports das linhas 1–8 por:

```tsx
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { CalendarClock, CalendarDays, ChevronLeft, FileUp, List, Loader2, Settings2 } from 'lucide-react';
import { usePedidosProgramadosLista, usePedidosProgramadosMutations } from '@/hooks/usePedidosProgramados';
import { PedidosProgramadosConfigDialog } from '@/components/pedidosProgramados/ConfigDialog';
import { CalendarioFaturamento } from '@/components/pedidosProgramados/CalendarioFaturamento';
import { dataLocalISO } from '@/lib/pedidosProgramados/calendario';
import { useUrlState } from '@/hooks/useUrlState';
import { track } from '@/lib/analytics';
```

**(b)** Dentro do componente, logo após `const fileRef = useRef<HTMLInputElement>(null);` (linha 24), adicionar:

```tsx
  const [urlState, setUrlState] = useUrlState({ view: 'lista', mes: '' });
  const view = urlState.view === 'calendario' ? 'calendario' : 'lista';
  const mesResolvido = urlState.mes || dataLocalISO(new Date()).slice(0, 7);
```

**(c)** No header, logo ANTES de `<PedidosProgramadosConfigDialog>` (linha 41), adicionar o toggle:

```tsx
        <div className="flex items-center border rounded-md p-0.5 gap-0.5" role="group" aria-label="Modo de visualização">
          <Button
            variant={view === 'lista' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setUrlState({ view: 'lista' })}
            aria-pressed={view === 'lista'}
          >
            <List className="w-4 h-4 mr-1" />Lista
          </Button>
          <Button
            variant={view === 'calendario' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => { setUrlState({ view: 'calendario' }); track('pedidos_programados.ver_calendario'); }}
            aria-pressed={view === 'calendario'}
          >
            <CalendarDays className="w-4 h-4 mr-1" />Calendário
          </Button>
        </div>
```

**(d)** Envolver o corpo (o bloco `{isPending ? ... : ...}` inteiro, linhas 61–98) na condição de view — o corpo atual vira o ramo `lista`:

```tsx
      {view === 'calendario' ? (
        <CalendarioFaturamento
          mes={mesResolvido}
          onMudarMes={(mes) => setUrlState({ mes })}
        />
      ) : isPending ? (
        <div className="flex items-center justify-center pt-24">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : !pedidos || pedidos.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nenhum pedido programado"
          description="Suba o PDF do pedido de compra da Lider pra começar."
          actionLabel="Subir PDF"
          onAction={() => fileRef.current?.click()}
        />
      ) : (
        <div className="space-y-2">
          {pedidos.map((p) => {
            const st = STATUS_LABEL[p.status] ?? STATUS_LABEL.ativo;
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => navigate(`/sales/programados/${p.id}`)}
                className="w-full text-left border rounded-md px-4 py-3 hover:bg-accent/50 transition-colors flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">
                    PC {p.numero_pedido_compra ?? '—'}{p.versao ? ` · v${p.versao}` : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Emissão {fmtData(p.data_emissao_cliente)} · upload {new Date(p.created_at).toLocaleDateString('pt-BR')}
                  </div>
                  {p.erro_motivo && <div className="text-xs text-status-error mt-1 truncate">{p.erro_motivo}</div>}
                </div>
                <Badge variant="outline" className={st.cls}>{st.label}</Badge>
              </button>
            );
          })}
        </div>
      )}
```

(Obs.: o container da página continua `max-w-4xl` — células de ~120px na grade, adequado.)

- [ ] **Step 2: Typecheck + testes completos**

Run: `heavy bun run typecheck && heavy bun run test > /tmp/test.log 2>&1; echo $?; tail -20 /tmp/test.log`
Expected: exit 0 nos dois; nenhum teste pré-existente quebrado.

- [ ] **Step 3: Commit**

```bash
git add src/pages/PedidosProgramados.tsx
git commit -m "feat(pedidos-programados): toggle Lista|Calendário com estado na URL (useUrlState)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Verificação final + PR

- [ ] **Step 1: Suíte completa + lint + deadcode**

Run: `heavy bun run typecheck && heavy bun run test > /tmp/final.log 2>&1; echo $?; tail -5 /tmp/final.log && bun lint > /tmp/lint-final.log 2>&1; echo $?`
Expected: exit 0 em tudo.

- [ ] **Step 2: Smoke manual (se houver dev server disponível)**

Abrir `/sales/programados?view=calendario` e conferir: grade renderiza o mês atual; navegação ←/→/Hoje atualiza a URL (`?view=calendario&mes=...`); clicar num dia com envio abre o Sheet; "Abrir pedido" navega ao detalhe. Se não houver como rodar, registrar que a verificação visual fica para o Publish.

- [ ] **Step 3: Push + PR (pt-BR; NÃO draft — auto-merge com CI verde)**

```bash
git push -u origin claude/calendario-faturamento-programados
gh pr create --title "feat(pedidos-programados): visão de calendário de faturamento" --body "$(cat <<'EOF'
## O quê
Toggle Lista|Calendário em /sales/programados: grade mensal (dom→sáb, 6 semanas fixas) com envios por dia — contagem, R$ e dots de status; erro domina a hierarquia visual. Clique no dia abre painel lateral só-leitura (PC, status, itens, "vira N pedidos: Oben/Colacor", erro_motivo, link ao detalhe). Estado (view/mês) na URL via useUrlState.

## Como
- Helper PURO `src/lib/pedidosProgramados/calendario.ts` (agregação por dia; datas como string YYYY-MM-DD — zero `new Date('YYYY-MM-DD')`) + 14 testes vitest.
- Money-path: valor ausente propaga null → "—" (ausente ≠ zero); envio sem itens não vira R$ 0; cancelados fora da soma.
- 1 query por mês (embed envios→itens→mapa→account), Number() na borda, guard de capa PostgREST (aviso se 1.000 linhas).
- queryKey `['pedidos-programados','calendario',mes]` — invalidação de graça pelas mutations existentes.

## Design
Spec: docs/superpowers/specs/2026-07-03-calendario-faturamento-design.md (Codex gpt-5.5 × Gemini convergiram na mesma arquitetura; mockup aprovado pelo founder).

## Deploy
Só frontend (Publish no Lovable). Sem migration, sem edge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR criado; auto-merge quando `validate` passar.

---

## Self-review do plano (cobertura da spec)

- Escopo só-envios ✅ (query na tabela de envios) · métrica envios + "vira N pedidos" no painel ✅ (Task 3) · painel só-leitura + link ✅ · toggle na página com URL ✅ (Task 4) · grade própria 7×6 dom→sáb ✅ (Task 1/3) · cancelados fora da soma e no painel ✅ (Task 1) · dia só-cancelados = vazio ✅ (`clicavel` exige `ativos > 0`) · ausente ≠ zero ✅ (valorDoEnvio + propagação + "valor incompleto") · envio sem itens ✅ (null + "sem itens") · truncamento ✅ · timezone ✅ (string keys + `T12:00:00` + `dataLocalISO`) · keepPreviousData ✅ · invalidação por prefixo ✅ · tokens status ✅ · aria-label/botões reais ✅ · mês vazio ✅ · "Hoje" limpa `mes` ✅ · v2 fora ✅.
