# Sub-PR 3 — "Detalhe + curar" (Visitas em campo) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No contexto "campo" do Roteirizador, fechar os pontos **B** (clico no alvo e vejo os dados) e **F** (curo a lista removendo quem não quero): um `FieldTargetDetailSheet` (shadcn Sheet) que abre ao clicar no card e mostra razão social + CNPJ + status + endereço completo + **telefone1 e telefone2** (ligar/WhatsApp) pro prospect, e nome + telefone + endereço + recência pra carteira; e "remover da sessão" (Set em memória, com desfazer) que some o alvo da lista **e** do mapa sem tocar o banco.

**Architecture:** Um helper puro novo `montarDetalheAlvo` em `src/lib/route/` transforma `(stop, ProspectRow?)` num view-model `AlvoDetalhe` (CNPJ formatado, linhas de endereço, label de recência, contatos com `tel:`/`wa.me` já montados) — testado em vitest. O hook `useRoutePlanner` passa a preservar a linha crua do prospect num `useRef<Map<stopId, ProspectRow>>` (hoje `prospectRowToStopDraft` colapsa razão/tel2), ganha o estado de curadoria `removidos: Set<string>` (filtra lista+mapa via `filteredFieldTargets`), e expõe `removerAlvo`/`detalheDoAlvo`. O `FieldTargetCard` ganha clique-pra-detalhe + um X de remover; a página monta o Sheet. `useFarmerScoring` intocado; nada toca o banco.

**Tech Stack:** React 18 + TS strict, shadcn `Sheet`, helpers existentes reusados (`whatsappLink`/`formatBrPhone`/`normalizeBrPhone` de `@/lib/phone`, `formatarCnpj` de `@/lib/radar/ui-helpers`, `labelProspeccaoStatus` de `@/lib/route/prospect-stop`), `sonner` (toast com desfazer), vitest. Tudo pt-BR.

**Spec:** `docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md` (seções 5B, 5F, 6, faseamento item 3). Decisões travadas: curadoria é **só da sessão** (Set em memória + desfazer, sem banco); o detalhe exige **preservar a linha crua** do prospect (razão social + telefone2 que o draft colapsa).

**Desvio consciente do spec (documentado):** o spec pede preservar a linha crua "e equivalente da carteira". **Não** preservo `CarteiraRow` — o `carteiraRowToStop` já mantém nome/telefone/endereço/`diasDesdeVisita` no próprio `RouteStop`; o único campo a mais no raw é o timestamp `ultima_visita`, que o detalhe mostra como "Visitado há N dias" (derivado de `diasDesdeVisita`, sem risco de bug de fuso ao parsear o ISO). Preservar `CarteiraRow` seria um ref/Map mortos. Pro **prospect** a preservação é necessária (razão social + telefone2).

**Invariantes (não-negociáveis):**
- `useFarmerScoring` **intocado** (money-path).
- Curadoria é **local/sessão** (`Set` em memória) — sem migration, sem escrita no banco, sem vazar entre contas. Reseta ao trocar de cidade (universo novo).
- OpenStreetMap/Nominatim mantidos; o mapa não muda neste sub-PR (cores/clusters/geocoding são o Sub-PR 4). Aqui o "remover" só **filtra** o que já entra no mapa (via `filteredFieldTargets`, que o effect do mapa já consome).
- "Ligar" usa `tel:` (discador nativo — o hunter está no celular em campo); **não** toca a telefonia WebRTC (money-path/write-guard). WhatsApp via `wa.me` (helper `whatsappLink`, que esconde o botão em número inválido).
- Sem Publish automático — o founder publica quando quiser; QA no device fica pendente.

---

## File Structure

**Criar:**
- `src/lib/route/alvo-detalhe.ts` — `AlvoDetalhe`, `ContatoAlvo`, `recenciaLabel(dias)`, `montarDetalheAlvo({stop, prospectRow?})` (puros; espelham os dados do Sheet).
- `src/lib/route/alvo-detalhe.test.ts`
- `src/components/reposicao/routePlanner/FieldTargetDetailSheet.tsx` — Sheet de detalhe (renderiza o `AlvoDetalhe`).

**Modificar:**
- `src/hooks/useRoutePlanner.ts` — `useRef<Map<string, ProspectRow>>` (preserva a linha crua, populado em `loadProspectStops`); estado `removidos: Set<string>` + `removerAlvo`/`restaurarAlvo`; `detalheDoAlvo(stop)`; `filteredFieldTargets`/`resumoAlvos`/`bairrosDisponiveis` passam por `fieldTargetsVivos` (exclui removidos); reset de `removidos` ao trocar cidade; return atualizado.
- `src/components/reposicao/routePlanner/FieldTargetCard.tsx` — área de info clicável (`onAbrirDetalhe`) + botão X (`onRemover`).
- `src/components/reposicao/routePlanner/FieldTargetsList.tsx` — propaga `onAbrirDetalhe`/`onRemover` por stop.
- `src/pages/AdminRoutePlanner.tsx` — estado `alvoAberto`; monta o `detalhe` (memo); renderiza `FieldTargetDetailSheet`; passa os handlers à lista.

---

## Task 1: Helper puro `montarDetalheAlvo` + `recenciaLabel` (TDD)

**Files:**
- Create: `src/lib/route/alvo-detalhe.ts`
- Test: `src/lib/route/alvo-detalhe.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Create `src/lib/route/alvo-detalhe.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { montarDetalheAlvo, recenciaLabel } from './alvo-detalhe';
import type { ProspectRow } from './prospect-stop';
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

const baseAddr = {
  street: 'Rua A', number: '10', neighborhood: 'Centro',
  city: 'DIVINOPOLIS', state: 'MG', zip_code: '35500-000', complement: 'Sala 2',
};

const stopProspect = (over: Partial<RouteStop> = {}): RouteStop => ({
  id: 'prospect-12345678000190',
  stopType: 'prospect_visit',
  customerUserId: '',
  customerName: 'Móveis Beto',
  phone: '37999990000',
  address: { ...baseAddr },
  timeSlot: null, businessHoursOpen: null, businessHoursClose: null,
  status: 'prospect', visitReason: 'Prospecção',
  priorityScore: 0, priorityLabel: 'baixa', priorityFactors: [],
  radarCnpj: '12345678000190', prospeccaoStatus: 'a_contatar',
  ...over,
});

const stopCarteira = (over: Partial<RouteStop> = {}): RouteStop => ({
  id: 'carteira-cidade-u1',
  stopType: 'sales_visit',
  customerUserId: 'u1',
  customerName: 'Marcenaria Silva',
  phone: '3733334444',
  address: { ...baseAddr },
  timeSlot: null, businessHoursOpen: null, businessHoursClose: null,
  status: 'carteira', visitReason: 'Cliente em Divinópolis',
  priorityScore: 0, priorityLabel: 'baixa', priorityFactors: [],
  diasDesdeVisita: 14,
  ...over,
});

const prospectRow = (over: Partial<ProspectRow> = {}): ProspectRow => ({
  cnpj: '12345678000190',
  razao_social: 'Beto Comercio de Moveis LTDA',
  nome_fantasia: 'Móveis Beto',
  logradouro: 'Rua A', numero: '10', complemento: 'Sala 2', bairro: 'Centro',
  municipio_nome: 'DIVINOPOLIS', uf: 'MG', cep: '35500-000',
  telefone1: '37999990000', telefone2: '3733331111',
  prospeccao_status: 'a_contatar', lat: null, lng: null, geocode_status: null,
  ...over,
});

describe('recenciaLabel', () => {
  it('null → nunca visitado', () => {
    expect(recenciaLabel(null)).toBe('Nunca visitado');
  });
  it('0 → hoje, 1 → ontem, N → há N dias', () => {
    expect(recenciaLabel(0)).toBe('Visitado hoje');
    expect(recenciaLabel(1)).toBe('Visitado ontem');
    expect(recenciaLabel(14)).toBe('Visitado há 14 dias');
  });
});

describe('montarDetalheAlvo — prospect', () => {
  const d = montarDetalheAlvo({ stop: stopProspect(), prospectRow: prospectRow() });

  it('tipo, nome e razão social (subtítulo) distinta do nome', () => {
    expect(d.tipo).toBe('prospect');
    expect(d.nome).toBe('Móveis Beto');
    expect(d.subtitulo).toBe('Beto Comercio de Moveis LTDA');
  });
  it('CNPJ formatado e status', () => {
    expect(d.cnpjFormatado).toBe('12.345.678/0001-90');
    expect(d.statusLabel).toBe('a contatar');
    expect(d.recenciaLabel).toBeNull();
  });
  it('dois contatos (tel1+tel2) com wa.me e tel: corretos', () => {
    expect(d.contatos).toHaveLength(2);
    expect(d.contatos[0].rotulo).toBe('Telefone 1');
    expect(d.contatos[0].whatsappHref).toBe('https://wa.me/5537999990000');
    expect(d.contatos[0].telHref).toBe('tel:37999990000');
    expect(d.contatos[1].rotulo).toBe('Telefone 2');
  });
  it('endereço em linhas (rua+num, complemento, bairro, cidade-UF, CEP)', () => {
    expect(d.enderecoLinhas).toEqual([
      'Rua A, 10', 'Sala 2', 'Centro', 'DIVINOPOLIS - MG', 'CEP 35500-000',
    ]);
  });
  it('razão social igual ao nome → subtítulo null (sem redundância)', () => {
    const d2 = montarDetalheAlvo({
      stop: stopProspect({ customerName: 'Beto LTDA' }),
      prospectRow: prospectRow({ razao_social: 'Beto LTDA', nome_fantasia: null }),
    });
    expect(d2.subtitulo).toBeNull();
  });
  it('sem telefone2 → um contato só', () => {
    const d3 = montarDetalheAlvo({ stop: stopProspect(), prospectRow: prospectRow({ telefone2: null }) });
    expect(d3.contatos).toHaveLength(1);
  });
  it('sem prospectRow (fallback) → usa o phone do stop, sem razão/cnpj do raw', () => {
    const d4 = montarDetalheAlvo({ stop: stopProspect() });
    expect(d4.contatos).toHaveLength(1);
    expect(d4.contatos[0].rotulo).toBe('Telefone');
    expect(d4.cnpjFormatado).toBe('12.345.678/0001-90'); // vem do stop.radarCnpj
    expect(d4.subtitulo).toBeNull();
  });
});

describe('montarDetalheAlvo — carteira', () => {
  it('tipo carteira: sem cnpj/status/subtítulo, com recência e um contato', () => {
    const d = montarDetalheAlvo({ stop: stopCarteira() });
    expect(d.tipo).toBe('carteira');
    expect(d.nome).toBe('Marcenaria Silva');
    expect(d.subtitulo).toBeNull();
    expect(d.cnpjFormatado).toBeNull();
    expect(d.statusLabel).toBeNull();
    expect(d.recenciaLabel).toBe('Visitado há 14 dias');
    expect(d.contatos).toHaveLength(1);
    expect(d.contatos[0].rotulo).toBe('Telefone');
  });
  it('nunca visitado → recência "Nunca visitado"', () => {
    const d = montarDetalheAlvo({ stop: stopCarteira({ diasDesdeVisita: null }) });
    expect(d.recenciaLabel).toBe('Nunca visitado');
  });
  it('sem telefone → zero contatos (esconde a seção)', () => {
    const d = montarDetalheAlvo({ stop: stopCarteira({ phone: null }) });
    expect(d.contatos).toHaveLength(0);
  });
  it('telefone fixo válido → tem tel:, whatsappHref pode existir; lixo → whatsappHref null', () => {
    const d = montarDetalheAlvo({ stop: stopCarteira({ phone: '123' }) });
    expect(d.contatos).toHaveLength(1);
    expect(d.contatos[0].whatsappHref).toBeNull(); // < 10 dígitos → sem WhatsApp
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test src/lib/route/alvo-detalhe.test.ts`
Expected: FAIL — módulo `./alvo-detalhe` não existe (TS2307 / "is not a function").

- [ ] **Step 3: Implementar**

Create `src/lib/route/alvo-detalhe.ts`:

```typescript
// Helper PURO do Roteirizador-campo (Sub-PR 3): transforma um alvo (RouteStop) +
// a linha crua do prospect (ProspectRow, quando houver) no view-model do Sheet de
// detalhe. Sem I/O — testável. Reusa os formatadores canônicos de telefone/CNPJ.
//
// Carteira NÃO precisa do raw: o RouteStop já carrega nome/telefone/endereço/
// diasDesdeVisita (ver desvio documentado no plano). Prospect precisa do raw pra
// razão social + telefone2, que o prospectRowToStopDraft colapsa.
import type { RouteStop } from '@/components/reposicao/routePlanner/types';
import type { ProspectRow } from './prospect-stop';
import { labelProspeccaoStatus } from './prospect-stop';
import { formatBrPhone, normalizeBrPhone, whatsappLink } from '@/lib/phone';
import { formatarCnpj } from '@/lib/radar/ui-helpers';

export interface ContatoAlvo {
  rotulo: string;                 // "Telefone 1" | "Telefone 2" | "Telefone"
  display: string;                // (DD) 9XXXX-XXXX
  telHref: string;                // tel:DDDD...
  whatsappHref: string | null;    // wa.me/55... ou null (esconde o botão)
}

export interface AlvoDetalhe {
  tipo: 'prospect' | 'carteira';
  nome: string;
  subtitulo: string | null;       // razão social (prospect, se != nome)
  cnpjFormatado: string | null;   // prospect
  statusLabel: string | null;     // prospect (a contatar / sem resposta / em conversa)
  recenciaLabel: string | null;   // carteira (Visitado há N dias / Nunca visitado)
  enderecoLinhas: string[];
  contatos: ContatoAlvo[];
}

const t = (v: string | null | undefined): string => (v ?? '').trim();

/** Rótulo humano da recência da carteira a partir dos dias desde a última visita. */
export function recenciaLabel(dias: number | null | undefined): string {
  if (dias == null) return 'Nunca visitado';
  if (dias <= 0) return 'Visitado hoje';
  if (dias === 1) return 'Visitado ontem';
  return `Visitado há ${dias} dias`;
}

function montarContato(rotulo: string, telefone: string | null | undefined): ContatoAlvo | null {
  const raw = t(telefone);
  if (!raw) return null;
  const digits = normalizeBrPhone(raw) || raw.replace(/\D/g, '');
  return {
    rotulo,
    display: formatBrPhone(raw),
    telHref: `tel:${digits}`,
    whatsappHref: whatsappLink(raw),
  };
}

function enderecoLinhas(a: RouteStop['address']): string[] {
  const linhas: string[] = [];
  const ruaNum = [t(a.street), t(a.number)].filter(Boolean).join(', ');
  if (ruaNum) linhas.push(ruaNum);
  if (t(a.complement)) linhas.push(t(a.complement));
  if (t(a.neighborhood)) linhas.push(t(a.neighborhood));
  const cidadeUf = [t(a.city), t(a.state)].filter(Boolean).join(' - ');
  if (cidadeUf) linhas.push(cidadeUf);
  if (t(a.zip_code)) linhas.push(`CEP ${t(a.zip_code)}`);
  return linhas;
}

export function montarDetalheAlvo(args: {
  stop: RouteStop;
  prospectRow?: ProspectRow | null;
}): AlvoDetalhe {
  const { stop, prospectRow } = args;
  const endereco = enderecoLinhas(stop.address);

  if (stop.stopType === 'prospect_visit') {
    const razao = t(prospectRow?.razao_social);
    const cnpj = t(prospectRow?.cnpj) || t(stop.radarCnpj);
    const status = t(stop.prospeccaoStatus) || t(prospectRow?.prospeccao_status);
    const contatos = prospectRow
      ? [
          montarContato('Telefone 1', prospectRow.telefone1),
          montarContato('Telefone 2', prospectRow.telefone2),
        ].filter((c): c is ContatoAlvo => c != null)
      : [montarContato('Telefone', stop.phone)].filter((c): c is ContatoAlvo => c != null);
    return {
      tipo: 'prospect',
      nome: stop.customerName,
      subtitulo: razao && razao !== stop.customerName ? razao : null,
      cnpjFormatado: cnpj ? formatarCnpj(cnpj) : null,
      statusLabel: status ? labelProspeccaoStatus(status) : null,
      recenciaLabel: null,
      enderecoLinhas: endereco,
      contatos,
    };
  }

  // Carteira (sales_visit) — só o stop.
  const contatos = [montarContato('Telefone', stop.phone)].filter(
    (c): c is ContatoAlvo => c != null,
  );
  return {
    tipo: 'carteira',
    nome: stop.customerName,
    subtitulo: null,
    cnpjFormatado: null,
    statusLabel: null,
    recenciaLabel: recenciaLabel(stop.diasDesdeVisita),
    enderecoLinhas: endereco,
    contatos,
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test src/lib/route/alvo-detalhe.test.ts`
Expected: PASS (todos os describes verdes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/route/alvo-detalhe.ts src/lib/route/alvo-detalhe.test.ts
git commit -m "feat(roteirizador): montarDetalheAlvo + recenciaLabel — view-model do detalhe (puro)"
```

---

## Task 2: Hook — preservar ProspectRow, estado de curadoria (removidos), detalheDoAlvo

**Files:**
- Modify: `src/hooks/useRoutePlanner.ts`

- [ ] **Step 1: Importar `montarDetalheAlvo` + tipo `AlvoDetalhe`**

Em `src/hooks/useRoutePlanner.ts`, logo após o import de `carteira-stop` (linha ~44), adicione:

```typescript
import { montarDetalheAlvo, type AlvoDetalhe } from '@/lib/route/alvo-detalhe';
```

- [ ] **Step 2: Ref que preserva a linha crua do prospect**

No corpo do hook, junto dos refs de geocoding (o `geocodedCoords` está na linha ~949), declare o ref logo após a declaração dos estados do contexto campo (após `const [loadingProspects, setLoadingProspects] = useState(false);`, linha ~111):

```typescript
  // Linha crua do prospect por stopId — preserva razão social + telefone2 que o
  // prospectRowToStopDraft colapsa. Lido sob-demanda quando o Sheet de detalhe abre
  // (ref, sem re-render). A carteira não precisa (o RouteStop já carrega tudo).
  const rawProspectById = useRef<Map<string, ProspectRow>>(new Map());
```

- [ ] **Step 3: Popular o ref dentro de `loadProspectStops`**

Em `loadProspectStops` (linha ~767), logo após `setLoadingProspects(true);` (dentro do `try`, antes do `Promise.all`), limpe o ref:

```typescript
    setLoadingProspects(true);
    rawProspectById.current.clear();
    try {
```

E dentro do `.map((row) => { ... })` que constrói os stops (após `const draft = prospectRowToStopDraft(row);`, linha ~785), guarde a linha crua:

```typescript
        const draft = prospectRowToStopDraft(row);
        rawProspectById.current.set(draft.id, row);
```

- [ ] **Step 4: Estado de curadoria `removidos` + ações**

Logo após a declaração de `filtros` (linha ~127), adicione o estado e as ações de remover/restaurar:

```typescript
  // Curadoria F: "remover da sessão" — Set em memória, sem tocar o banco. Some da
  // lista E do mapa (via filteredFieldTargets). Reseta ao trocar de cidade.
  const [removidos, setRemovidos] = useState<Set<string>>(new Set());

  const restaurarAlvo = useCallback((id: string) => {
    setRemovidos((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const removerAlvo = useCallback((id: string, nome?: string) => {
    setRemovidos((prev) => new Set(prev).add(id));
    // Se estava marcado pra rota, desmarca (senão seguiria na rota otimizada).
    setSelectedTargetIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    toast(`${nome?.trim() || 'Alvo'} removido da lista`, {
      action: { label: 'Desfazer', onClick: () => restaurarAlvo(id) },
    });
  }, [restaurarAlvo]);
```

- [ ] **Step 5: `detalheDoAlvo` — glue do ref + helper puro**

Logo após `removerAlvo` (mesmo bloco), adicione o leitor de detalhe:

```typescript
  // Monta o view-model do Sheet de detalhe: lê a linha crua do prospect (ref) e
  // delega ao helper puro. Carteira não tem raw → o helper usa só o stop.
  const detalheDoAlvo = useCallback(
    (stop: RouteStop): AlvoDetalhe =>
      montarDetalheAlvo({ stop, prospectRow: rawProspectById.current.get(stop.id) ?? null }),
    [],
  );
```

- [ ] **Step 6: Excluir removidos do universo vivo (lista + mapa + derivados)**

Substitua o bloco `filteredFieldTargets` / `bairrosDisponiveis` / `resumoAlvos` (linhas ~1044-1062) por uma cadeia que passa por `fieldTargetsVivos`:

```typescript
  // Universo "vivo" = alvos que não foram removidos da sessão (curadoria F). Tudo
  // (lista, mapa, contagens, bairros) parte daqui pra ficar coerente com a curadoria.
  const fieldTargetsVivos = useMemo(
    () => fieldTargets.filter((s) => !removidos.has(s.id)),
    [fieldTargets, removidos],
  );

  const filteredFieldTargets = useMemo(
    () => aplicarFiltrosAlvos(fieldTargetsVivos, filtros),
    [fieldTargetsVivos, filtros],
  );

  // Bairros presentes no universo vivo (pro Select de filtro).
  const bairrosDisponiveis = useMemo(() => bairrosDe(fieldTargetsVivos), [fieldTargetsVivos]);

  // Prospects disponíveis no Radar nas cidades (soma do total já cacheado) — base
  // do aviso "1.000 de N" quando o teto trunca a carga.
  const prospectsDisponiveis = useMemo(
    () => selectedCities.reduce((acc, c) => acc + (c.total ?? 0), 0),
    [selectedCities],
  );

  const resumoAlvos = useMemo(() => {
    const { clientes, prospects } = particionarAlvos(fieldTargetsVivos);
    return { totalClientes: clientes.length, totalProspects: prospects.length };
  }, [fieldTargetsVivos]);
```

(Observação: o `stopsParaRota` no contexto campo usa `selectedTargetIds` — como o `removerAlvo` já desmarca, um alvo removido não fica na rota. Sem mudança ali.)

- [ ] **Step 7: Resetar `removidos` ao trocar de cidade**

No effect que reinicia a curadoria (linha ~881), acrescente o reset dos removidos:

```typescript
  // Trocar as cidades reinicia a curadoria e os filtros (universo novo).
  useEffect(() => {
    setSelectedTargetIds(new Set());
    setFiltros(FILTROS_ALVO_INICIAL);
    setRemovidos(new Set());
  }, [selectedCities]);
```

- [ ] **Step 8: Expor no `return`**

No bloco de curadoria do return (linhas ~1281-1290), após `setFiltros,`, acrescente:

```typescript
    filtros,
    setFiltros,
    removerAlvo,
    detalheDoAlvo,
```

- [ ] **Step 9: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS — `ProspectRow` já é importado (linha ~32); `AlvoDetalhe`/`montarDetalheAlvo` resolvem (Task 1). O return só **ganha** chaves; a página não quebra.

- [ ] **Step 10: Commit**

```bash
git add src/hooks/useRoutePlanner.ts
git commit -m "feat(roteirizador): preserva ProspectRow cru + curadoria remover-da-sessão (Set + desfazer)"
```

---

## Task 3: `FieldTargetDetailSheet`

**Files:**
- Create: `src/components/reposicao/routePlanner/FieldTargetDetailSheet.tsx`

- [ ] **Step 1: Criar o componente**

Create `src/components/reposicao/routePlanner/FieldTargetDetailSheet.tsx`:

```tsx
// Sheet de detalhe do alvo (contexto campo, ponto B). Renderiza o view-model
// AlvoDetalhe (montado pelo hook): razão social + CNPJ + status (prospect) ou
// recência (carteira), endereço completo e os telefones com Ligar (tel:) / WhatsApp
// (wa.me). Rodapé: adicionar/remover da rota + remover da sessão (ponto F).
import { Plus, Check, Phone, MessageCircle, Trash2, MapPin } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { STOP_CONFIG } from './constants';
import type { RouteStop } from './types';
import type { AlvoDetalhe } from '@/lib/route/alvo-detalhe';

export function FieldTargetDetailSheet({
  stop,
  detalhe,
  naRota,
  onToggleRota,
  onRemover,
  onOpenChange,
}: {
  stop: RouteStop | null;
  detalhe: AlvoDetalhe | null;
  naRota: boolean;
  onToggleRota: () => void;
  onRemover: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const open = stop != null && detalhe != null;
  const cfg = stop ? STOP_CONFIG[stop.stopType] : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {detalhe && (
          <>
            <SheetHeader className="text-left">
              <div className="flex items-center gap-2 flex-wrap">
                <SheetTitle className="text-lg">{detalhe.nome}</SheetTitle>
                {cfg && (
                  <Badge className={`text-[10px] px-1.5 py-0 ${cfg.bgClass} border-0`}>
                    {cfg.label}
                  </Badge>
                )}
              </div>
              {detalhe.subtitulo && (
                <SheetDescription className="text-xs">{detalhe.subtitulo}</SheetDescription>
              )}
            </SheetHeader>

            <div className="space-y-4 py-4 text-sm">
              {/* Identificação (prospect) / recência (carteira) */}
              <div className="space-y-1.5">
                {detalhe.cnpjFormatado && (
                  <p className="text-muted-foreground">
                    CNPJ <span className="text-foreground tabular-nums">{detalhe.cnpjFormatado}</span>
                  </p>
                )}
                {detalhe.statusLabel && (
                  <p className="text-muted-foreground">
                    Status <span className="text-foreground">{detalhe.statusLabel}</span>
                  </p>
                )}
                {detalhe.recenciaLabel && (
                  <p className="text-muted-foreground">{detalhe.recenciaLabel}</p>
                )}
              </div>

              <Separator />

              {/* Endereço */}
              <div className="flex gap-2">
                <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  {detalhe.enderecoLinhas.length > 0 ? (
                    detalhe.enderecoLinhas.map((linha, i) => (
                      <p key={i} className="text-foreground">{linha}</p>
                    ))
                  ) : (
                    <p className="text-muted-foreground">Endereço não informado</p>
                  )}
                </div>
              </div>

              {/* Contatos */}
              {detalhe.contatos.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    {detalhe.contatos.map((c) => (
                      <div key={c.rotulo} className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] text-muted-foreground">{c.rotulo}</p>
                          <p className="text-foreground tabular-nums truncate">{c.display}</p>
                        </div>
                        <Button size="sm" variant="outline" className="h-8 gap-1 shrink-0" asChild>
                          <a href={c.telHref} aria-label={`Ligar ${c.display}`}>
                            <Phone className="w-3.5 h-3.5" /> Ligar
                          </a>
                        </Button>
                        {c.whatsappHref && (
                          <Button size="sm" variant="outline" className="h-8 gap-1 shrink-0" asChild>
                            <a href={c.whatsappHref} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp ${c.display}`}>
                              <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                            </a>
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <SheetFooter className="flex-row gap-2 sm:flex-row">
              <Button
                variant={naRota ? 'default' : 'outline'}
                className="flex-1 gap-1"
                onClick={onToggleRota}
              >
                {naRota ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {naRota ? 'Na rota' : 'Adicionar à rota'}
              </Button>
              <Button
                variant="ghost"
                className="gap-1 text-muted-foreground hover:text-status-error"
                onClick={onRemover}
                aria-label="Remover da sessão"
              >
                <Trash2 className="w-4 h-4" /> Remover
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Confirmar que `Separator` existe (shadcn)**

Run: `test -f src/components/ui/separator.tsx && echo OK || echo MISSING`
Expected: `OK`. Se `MISSING`, troque os `<Separator />` por `<div className="border-t" />` e remova o import.

- [ ] **Step 3: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS — o componente é novo e isolado; importa o `AlvoDetalhe` (Task 1) e o `STOP_CONFIG` existente. Ainda não é usado (será na Task 4) — export não-usado não quebra typecheck.

- [ ] **Step 4: Commit**

```bash
git add src/components/reposicao/routePlanner/FieldTargetDetailSheet.tsx
git commit -m "feat(roteirizador): FieldTargetDetailSheet — detalhe do alvo (ponto B)"
```

---

## Task 4: Ligar o detalhe + remover no card/lista/página

**Files:**
- Modify: `src/components/reposicao/routePlanner/FieldTargetCard.tsx`
- Modify: `src/components/reposicao/routePlanner/FieldTargetsList.tsx`
- Modify: `src/pages/AdminRoutePlanner.tsx`

- [ ] **Step 1: `FieldTargetCard` — info clicável + X de remover**

Substitua `src/components/reposicao/routePlanner/FieldTargetCard.tsx` inteiro por:

```tsx
// Linha de um alvo (cliente da carteira OU prospect do Radar) no universo de
// alvos do contexto campo. Clicar na info abre o detalhe (Sheet); o X remove da
// sessão (ponto F); o botão à direita marca/desmarca pra rota.
import { Plus, Check, Phone, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { RouteStop } from './types';
import { STOP_CONFIG } from './constants';

export function FieldTargetCard({
  stop,
  naRota,
  onToggleRota,
  onAbrirDetalhe,
  onRemover,
}: {
  stop: RouteStop;
  naRota: boolean;
  onToggleRota: () => void;
  onAbrirDetalhe?: () => void;
  onRemover?: () => void;
}) {
  const cfg = STOP_CONFIG[stop.stopType];
  return (
    <Card className={naRota ? 'border-primary/50 bg-primary/5' : ''}>
      <CardContent className="py-2.5 px-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAbrirDetalhe}
            disabled={!onAbrirDetalhe}
            className="flex-1 min-w-0 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            aria-label={`Ver detalhes de ${stop.customerName}`}
          >
            <div className="flex items-center gap-2">
              <p className="font-medium text-foreground truncate text-sm">{stop.customerName}</p>
              <Badge className={`text-[10px] px-1.5 py-0 ${cfg.bgClass} border-0`}>{cfg.label}</Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {stop.address.street}
              {stop.address.number ? `, ${stop.address.number}` : ''} — {stop.address.neighborhood || stop.address.city}
            </p>
          </button>
          {stop.phone && (
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" asChild>
              <a href={`tel:${stop.phone}`} aria-label="Ligar">
                <Phone className="w-3.5 h-3.5" />
              </a>
            </Button>
          )}
          {onRemover && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-status-error"
              onClick={onRemover}
              aria-label={`Remover ${stop.customerName} da lista`}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant={naRota ? 'default' : 'outline'}
            className="h-8 text-xs gap-1 shrink-0"
            onClick={onToggleRota}
          >
            {naRota ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {naRota ? 'Na rota' : 'Adicionar'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: `FieldTargetsList` — propaga os handlers por stop**

Em `src/components/reposicao/routePlanner/FieldTargetsList.tsx`, troque a assinatura de props e a passagem ao card. Substitua o bloco de `export function FieldTargetsList({ ... }) {` (props) e o `<FieldTargetCard .../>` por:

```tsx
export function FieldTargetsList({
  stops,
  isNaRota,
  onToggleRota,
  onAbrirDetalhe,
  onRemover,
}: {
  stops: RouteStop[];
  isNaRota: (id: string) => boolean;
  onToggleRota: (id: string) => void;
  onAbrirDetalhe: (stop: RouteStop) => void;
  onRemover: (stop: RouteStop) => void;
}) {
```

E o card dentro do `.map`:

```tsx
              <FieldTargetCard
                stop={stop}
                naRota={isNaRota(stop.id)}
                onToggleRota={() => onToggleRota(stop.id)}
                onAbrirDetalhe={() => onAbrirDetalhe(stop)}
                onRemover={() => onRemover(stop)}
              />
```

- [ ] **Step 3: Página — estado do Sheet + render + handlers**

Em `src/pages/AdminRoutePlanner.tsx`:

(a) Ajuste o import do React (linha 1) para incluir `useMemo` e `useState`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
```

(b) Adicione o import do Sheet (junto dos demais de `routePlanner`, após `FieldTargetsList`):

```tsx
import { FieldTargetDetailSheet } from '@/components/reposicao/routePlanner/FieldTargetDetailSheet';
```

(c) Importe o tipo `RouteStop` (se ainda não estiver). Adicione junto aos imports de `routePlanner`:

```tsx
import type { RouteStop } from '@/components/reposicao/routePlanner/types';
```

(d) No destructuring do `useRoutePlanner()`, após `setFiltros,` (linha ~98), acrescente:

```tsx
    removerAlvo,
    detalheDoAlvo,
```

(e) Logo após o destructuring do hook (após a linha `} = useRoutePlanner();`, ~linha 99), adicione o estado do Sheet e o detalhe memoizado:

```tsx
  // Sheet de detalhe do alvo (contexto campo). alvoAberto = qual alvo está aberto.
  const [alvoAberto, setAlvoAberto] = useState<RouteStop | null>(null);
  const detalheAberto = useMemo(
    () => (alvoAberto ? detalheDoAlvo(alvoAberto) : null),
    [alvoAberto, detalheDoAlvo],
  );
```

(f) Passe os handlers à `FieldTargetsList` (bloco ~linha 291):

```tsx
            <FieldTargetsList
              stops={filteredFieldTargets}
              isNaRota={(id) => selectedTargetIds.has(id)}
              onToggleRota={toggleTargetId}
              onAbrirDetalhe={setAlvoAberto}
              onRemover={(stop) => removerAlvo(stop.id, stop.customerName)}
            />
```

(g) Renderize o Sheet junto ao `CheckoutDialog`, logo antes do `</div>` que fecha o container raiz (após o `</CheckoutDialog>`, ~linha 400):

```tsx
      <FieldTargetDetailSheet
        stop={alvoAberto}
        detalhe={detalheAberto}
        naRota={alvoAberto ? selectedTargetIds.has(alvoAberto.id) : false}
        onToggleRota={() => alvoAberto && toggleTargetId(alvoAberto.id)}
        onRemover={() => {
          if (alvoAberto) {
            removerAlvo(alvoAberto.id, alvoAberto.customerName);
            setAlvoAberto(null);
          }
        }}
        onOpenChange={(open) => { if (!open) setAlvoAberto(null); }}
      />
```

- [ ] **Step 4: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS — `onAbrirDetalhe`/`onRemover` agora são obrigatórios na lista e a página os passa; `removerAlvo`/`detalheDoAlvo` vêm do hook (Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/components/reposicao/routePlanner/FieldTargetCard.tsx src/components/reposicao/routePlanner/FieldTargetsList.tsx src/pages/AdminRoutePlanner.tsx
git commit -m "feat(roteirizador): abrir detalhe ao clicar no alvo + remover-da-sessão no card/sheet (B+F)"
```

---

## Task 5: Verde + PR

**Files:** nenhum (gate de qualidade + integração)

- [ ] **Step 1: Suíte completa + typecheck + lint + build**

```bash
heavy bun run typecheck > /tmp/sub3-tc.log 2>&1; echo "tc=$?"
heavy bun run test       > /tmp/sub3-test.log 2>&1; echo "test=$?"
bunx eslint src          > /tmp/sub3-lint.log 2>&1; echo "lint=$?"
heavy bun run build      > /tmp/sub3-build.log 2>&1; echo "build=$?"
```
Expected: `tc=0`, `test=0`, `lint=0`, `build=0`. (NÃO usar `| tail` — engole o exit code. `bunx eslint src` evita as worktrees aninhadas que sujam o `bun lint`.) Se algum ≠0, ler o log e corrigir antes de seguir.

- [ ] **Step 2: Revisão de diff**

Use a skill `/review` (gstack) sobre o diff da branch — trust boundary (o detalhe não expõe dado de outra conta: o universo já é da carteira/Radar do próprio usuário), side effects, XSS (o Sheet renderiza via JSX/React — escapado por padrão, ao contrário do `bindPopup` do mapa). Corrigir o que apontar.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin claude/roteirizador-campo-subpr3
gh pr create --title "feat(roteirizador): Visitas em campo Sub-PR 3 — detalhe do alvo + curar a lista" \
  --body "$(cat <<'EOF'
## O que muda (Sub-PR 3 do redesign "Visitas em campo")

Spec: `docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md`. Pontos B e F.

- **Detalhe ao clicar (B):** `FieldTargetDetailSheet` abre ao tocar no card. Prospect: razão social, CNPJ formatado, status, endereço completo e **telefone1 + telefone2** com Ligar (`tel:`) / WhatsApp (`wa.me`). Carteira: nome, telefone, endereço e recência ("Visitado há N dias" / "Nunca visitado"). O hook passa a **preservar a linha crua do prospect** (`Map<stopId, ProspectRow>`) — antes razão/telefone2 eram descartados no draft.
- **Curar a lista (F):** "Remover da sessão" no card (X) e no Sheet — `Set` em memória **com desfazer** (toast). Some da lista **e** do mapa; reseta ao trocar de cidade. **Nada toca o banco.**

`useFarmerScoring` intocado. OSM/telefonia intocados (Ligar usa o discador nativo `tel:`). Sem migration. Mapa (cores/clusters/geocoding) é o Sub-PR 4.

## Verificação
- `bun run typecheck` ✅ · `bun run test` ✅ · `eslint src` ✅ · `bun run build` ✅
- Teste puro novo: `montarDetalheAlvo` (prospect com 2 telefones/razão/CNPJ; carteira com recência; fallbacks) + `recenciaLabel`.

## Pendências do founder
- **Publish** do frontend no Lovable (este PR é só código).
- **QA no device**: abrir o detalhe pelo card; ligar/WhatsApp; remover + desfazer; trocar de cidade limpa a curadoria.
EOF
)"
```

- [ ] **Step 4: Reportar ao founder**

Renderizar no chat: Sub-PR 3 aberto (link do PR), o que entrega (B+F), e as 2 pendências dele (Publish + QA no device). O Sub-PR 4 (mapa — cores/formas/clusters/geocoding progressivo) é o último.

---

## Self-Review (preencher na execução)

- **Spec coverage:** B detalhe (Tasks 1,3,4) — razão/CNPJ/status/2 telefones/endereço/recência ✓ · F curar (Task 2 estado + Task 4 UI) — remover-da-sessão com desfazer, some de lista+mapa, sem banco ✓. E/G ficam no Sub-PR 4. Desvio do `CarteiraRow` cru documentado e justificado. ✓
- **Type consistency:** `AlvoDetalhe`/`ContatoAlvo` idênticos entre `alvo-detalhe.ts`, hook (`detalheDoAlvo`) e `FieldTargetDetailSheet`. `removerAlvo(id, nome?)` mesma assinatura no hook e nos 2 call-sites (card via lista, sheet). `onAbrirDetalhe`/`onRemover` recebem `RouteStop` (lista→página). ✓
- **Sem placeholder:** todos os steps têm código/comando completo. ✓
