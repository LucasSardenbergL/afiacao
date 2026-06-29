# Projeto Verificado Sayerlack — MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o núcleo de domínio puro e testável do "Projeto Verificado" (escada de estados, Check de Proporção, faixa de consumo) que serve simultaneamente de substrato anti-desvio e de registro do programa de relacionamento — desacoplado do discovery técnico-jurídico que destrava as fases de persistência/UI.

**Architecture:** Lógica de domínio em `src/lib/projeto-verificado/` (funções puras, sem React/Supabase), no mesmo molde de `src/lib/tint/compute-price.ts` (oráculo puro, testado com vitest, doutrina "ausente ≠ zero"). Persistência/UI/integração Sayersystem ficam em fases posteriores, **bloqueadas pelo discovery (Fase 0)** — não detalhadas aqui porque sua forma depende de como o Sayersystem exporta dados.

**Tech Stack:** TypeScript 5.8 (strict) · vitest (`bun run test`) · sem dependências novas. Fases posteriores: Supabase (ritual `lovable-db-operator`), react-query, PWA Workbox.

**Spec:** [docs/superpowers/specs/2026-06-17-projeto-verificado-sayerlack-design.md](../specs/2026-06-17-projeto-verificado-sayerlack-design.md) (v2, validada por painel tri-modelo).

---

## ⚠️ Gate de escopo (ler antes de executar)

A spec v2 (§9) estabelece um **discovery técnico-jurídico de 1-2 semanas como pré-build**. Este plano respeita o gate:

- **Fase 0 (Discovery)** é o gate. Não é código — é investigação com critérios de "done". Bloqueia as Fases 2+.
- **Fase 1 (Núcleo de domínio puro)** pode rodar **em paralelo** ao discovery: são funções puras parametrizadas cujos *valores* (proporções por sistema, rendimento técnico, bandas) vêm do discovery/Renner, mas cuja *lógica* é verdade desde já. Entrega software testável por si só.
- **Fases 2+ (persistência, balcão, evidências, motor comercial, certificado, Sayersystem)** estão esboçadas em §"Fases pós-gate" mas **não detalhadas em TDD** — sua forma depende do resultado da Fase 0. Serão expandidas num plano próprio após o discovery, para não escrever sobre areia (e violar "No Placeholders").

**Decisões de negócio que o código NÃO crava** (parametrizadas, vêm do discovery): proporção mínima de cada componente por sistema Sayerlack; rendimento técnico (m²/L) por sistema; larguras das bandas de consumo. O código recebe esses valores como input e testa a lógica — nunca hardcoda número de negócio.

---

## File Structure (Fase 1)

- Create: `src/lib/projeto-verificado/check-proporcao.ts` — Check de Proporção (a "cesta": cor + fundo + catalisador + diluente atende a proporção técnica do sistema?). Função pura.
- Create: `src/lib/projeto-verificado/estado.ts` — escada de estados nomeados (`cor_dosada_verificada` → `sistema_documentado` → `evidencia_recebida` → `conformidade_assistida` + exceções). Função pura sobre fatos comprovados.
- Create: `src/lib/projeto-verificado/consumo.ts` — classificação de consumo em bandas amplas (`compativel`/`baixo`/`suspeito`/`indeterminado`). Função pura.
- Create: `src/lib/projeto-verificado/__tests__/check-proporcao.test.ts`
- Create: `src/lib/projeto-verificado/__tests__/estado.test.ts`
- Create: `src/lib/projeto-verificado/__tests__/consumo.test.ts`

Cada arquivo tem uma responsabilidade única e é testável isoladamente, seguindo o padrão de `src/lib/tint/`.

---

## Fase 0 — Discovery (GATE, não-código)

> Não há passos TDD. Cada item tem um critério de "done". As Fases 2+ ficam bloqueadas até estes itens fecharem. Vários são do founder/jurídico, não do engenheiro.

- [ ] **D1 — Export do Sayersystem.** Confirmar se/como o Sayersystem expõe os eventos de dosagem (CSV / API / relatório / nada) e a cadência. **Done:** documento com o formato real dos campos disponíveis (fórmula, base, corantes, volume, comprador, data, lote) OU a confirmação de que só há registro manual. *Dependência dura do desenho do vínculo projeto↔dosagem.*
- [ ] **D2 — Cronometragem do balcão.** Medir o tempo real do passo "vincular PID + registrar cesta + imprimir etiqueta" no balcão. **Done:** tempo ≤ ~2 min confirmado ou plano de redução. *Fricção fatal acima disso (spec §8).*
- [ ] **D3 — Parâmetros técnicos por sistema.** Obter da Renner/boletins: proporção mínima de fundo/catalisador/diluente por litro de acabamento, e rendimento (m²/L) por sistema. **Done:** tabela de parâmetros que alimenta Fase 1. *Sem isto, Fase 1 roda só com valores de teste.*
- [ ] **D4 — Jurídico: Assistência de Conformidade.** Parecer sobre redação vinculante sob CDC + tetos + separação distribuidor×fabricante. **Done:** texto aprovado.
- [ ] **D5 — Jurídico: fee do arquiteto + marca.** Parecer sobre "gestão/fiscalização" cobrada do cliente sem recair em RT (CAU/Lei 12.378); confirmar que a marca do programa não menciona honorários. **Done:** parecer + naming aprovado.
- [ ] **D6 — Jurídico: auditoria + LGPD.** Validar visita-surpresa em marcenaria e política de fotos/geolocalização/dados pessoais. **Done:** parecer.
- [ ] **D7 — Naming público.** Resolver "Projeto Verificado" (escada de estados) vs "Certificado de Origem de Insumos". **Done:** decisão do founder após mostrar as 2 versões a ~5 arquitetos (spec §9).

**Saída da Fase 0:** com D1+D3 resolvidos, expandir as Fases 2+ num plano de implementação próprio.

---

## Fase 1 — Núcleo de domínio puro (TDD)

### Task 1: Check de Proporção (a "cesta")

A inovação central da v2: o estado `sistema_documentado` só se sustenta se a compra contém os componentes do sistema na proporção técnica mínima. Função pura sobre a cesta. Doutrina "ausente ≠ zero": componente comprado fora (`externo`) não conta como documentado.

**Files:**
- Create: `src/lib/projeto-verificado/check-proporcao.ts`
- Test: `src/lib/projeto-verificado/__tests__/check-proporcao.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/projeto-verificado/__tests__/check-proporcao.test.ts
import { describe, it, expect } from 'vitest';
import { avaliarProporcao, type ItemCesta, type RequisitoSistema } from '../check-proporcao';

// Sistema-exemplo (valores de TESTE — os reais vêm do discovery D3):
// para cada 1 L de acabamento, exige 1 L de fundo, 0,1 L de catalisador.
const sistema: RequisitoSistema = {
  proporcaoMinima: { fundo: 1.0, catalisador: 0.1 },
};

describe('avaliarProporcao', () => {
  it('atende quando a cesta (toda Colacor) cobre a proporção mínima', () => {
    const cesta: ItemCesta[] = [
      { tipo: 'acabamento', litros: 4, origem: 'colacor' },
      { tipo: 'fundo', litros: 4, origem: 'colacor' },
      { tipo: 'catalisador', litros: 0.5, origem: 'colacor' },
    ];
    const r = avaliarProporcao(cesta, sistema);
    expect(r.litrosAcabamento).toBe(4);
    expect(r.atende).toBe(true);
    expect(r.faltantes).toEqual([]);
    expect(r.temComponenteExterno).toBe(false);
  });

  it('NÃO atende e lista o faltante quando o fundo é insuficiente', () => {
    const cesta: ItemCesta[] = [
      { tipo: 'acabamento', litros: 4, origem: 'colacor' },
      { tipo: 'fundo', litros: 1, origem: 'colacor' }, // exige 4
      { tipo: 'catalisador', litros: 0.5, origem: 'colacor' },
    ];
    const r = avaliarProporcao(cesta, sistema);
    expect(r.atende).toBe(false);
    expect(r.faltantes).toEqual([{ tipo: 'fundo', requeridoL: 4, presenteL: 1 }]);
  });

  it('ignora litros de componente EXTERNO ao checar proporção e sinaliza o externo', () => {
    const cesta: ItemCesta[] = [
      { tipo: 'acabamento', litros: 4, origem: 'colacor' },
      { tipo: 'fundo', litros: 4, origem: 'externo' }, // comprado fora → não conta
      { tipo: 'catalisador', litros: 0.5, origem: 'colacor' },
    ];
    const r = avaliarProporcao(cesta, sistema);
    expect(r.atende).toBe(false);
    expect(r.faltantes).toEqual([{ tipo: 'fundo', requeridoL: 4, presenteL: 0 }]);
    expect(r.temComponenteExterno).toBe(true);
  });

  it('sem acabamento na cesta → não atende, sem inventar (litrosAcabamento 0)', () => {
    const cesta: ItemCesta[] = [{ tipo: 'fundo', litros: 4, origem: 'colacor' }];
    const r = avaliarProporcao(cesta, sistema);
    expect(r.litrosAcabamento).toBe(0);
    expect(r.atende).toBe(false);
    expect(r.faltantes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bunx vitest run src/lib/projeto-verificado/__tests__/check-proporcao.test.ts`
Expected: FAIL — `Cannot find module '../check-proporcao'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/projeto-verificado/check-proporcao.ts
// Check de Proporção ("cesta"): a compra de um projeto contém os componentes do
// sistema Sayerlack na proporção técnica mínima? É a trava que transforma "o ledger
// só vê a cor" numa prova de SISTEMA (spec v2 §5). Doutrina "ausente ≠ zero":
// componente comprado fora da Colacor (`externo`) NÃO conta como documentado.
// Os VALORES de proporção vêm do discovery (D3); aqui só vive a lógica.

export type TipoComponente = 'acabamento' | 'fundo' | 'catalisador' | 'diluente';
export type ComponenteNaoAcabamento = Exclude<TipoComponente, 'acabamento'>;

/** Um item comprado e vinculado ao projeto. */
export interface ItemCesta {
  tipo: TipoComponente;
  litros: number;
  /** 'colacor' = vendido/dosado por nós (conta); 'externo' = comprado fora (não conta). */
  origem: 'colacor' | 'externo';
}

/** Requisito técnico do sistema: litros mínimos de cada componente por litro de acabamento. */
export interface RequisitoSistema {
  proporcaoMinima: Partial<Record<ComponenteNaoAcabamento, number>>;
}

export interface Faltante {
  tipo: TipoComponente;
  requeridoL: number;
  presenteL: number;
}

export interface ResultadoProporcao {
  litrosAcabamento: number;
  atende: boolean;
  faltantes: Faltante[];
  temComponenteExterno: boolean;
}

function somaColacor(cesta: ItemCesta[], tipo: TipoComponente): number {
  return cesta
    .filter((i) => i.tipo === tipo && i.origem === 'colacor')
    .reduce((acc, i) => acc + i.litros, 0);
}

export function avaliarProporcao(
  cesta: ItemCesta[],
  sistema: RequisitoSistema,
): ResultadoProporcao {
  const litrosAcabamento = somaColacor(cesta, 'acabamento');
  const temComponenteExterno = cesta.some((i) => i.origem === 'externo');

  // Sem acabamento Colacor não há o que documentar (ausente ≠ zero): não inventa faltantes.
  if (litrosAcabamento <= 0) {
    return { litrosAcabamento: 0, atende: false, faltantes: [], temComponenteExterno };
  }

  const faltantes: Faltante[] = [];
  for (const [tipo, fator] of Object.entries(sistema.proporcaoMinima) as Array<
    [ComponenteNaoAcabamento, number]
  >) {
    const requeridoL = litrosAcabamento * fator;
    const presenteL = somaColacor(cesta, tipo);
    if (presenteL < requeridoL) {
      faltantes.push({ tipo, requeridoL, presenteL });
    }
  }

  return { litrosAcabamento, atende: faltantes.length === 0, faltantes, temComponenteExterno };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bunx vitest run src/lib/projeto-verificado/__tests__/check-proporcao.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/projeto-verificado/check-proporcao.ts src/lib/projeto-verificado/__tests__/check-proporcao.test.ts
git commit -m "feat(projeto-verificado): Check de Proporção (cesta do sistema)"
```

---

### Task 2: Escada de estados

O coração da v2: dado o conjunto de fatos comprovados de um projeto, retorna o estado nomeado pelo que **de fato** atesta (nunca um "verde" único — spec §4). Função pura. Consome o `ResultadoProporcao` da Task 1 (via os campos `atende`/`temComponenteExterno`, passados como fatos).

**Files:**
- Create: `src/lib/projeto-verificado/estado.ts`
- Test: `src/lib/projeto-verificado/__tests__/estado.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/projeto-verificado/__tests__/estado.test.ts
import { describe, it, expect } from 'vitest';
import { calcularEstado, type FatosProjeto } from '../estado';

const base: FatosProjeto = {
  corDosadaVinculada: false,
  proporcaoAtende: false,
  temComponenteExterno: false,
  evidenciasMinimasRecebidas: false,
  revisaoHumanaConcluida: false,
  divergencia: false,
};

describe('calcularEstado', () => {
  it('divergência é exceção terminal, vence tudo', () => {
    expect(calcularEstado({ ...base, corDosadaVinculada: true, proporcaoAtende: true, divergencia: true }))
      .toBe('divergencia_encontrada');
  });

  it('sem cor vinculada → pendente_incompleto', () => {
    expect(calcularEstado(base)).toBe('pendente_incompleto');
  });

  it('cor vinculada, sem sistema → cor_dosada_verificada', () => {
    expect(calcularEstado({ ...base, corDosadaVinculada: true })).toBe('cor_dosada_verificada');
  });

  it('cor + proporção OK (tudo Colacor) → sistema_documentado', () => {
    expect(calcularEstado({ ...base, corDosadaVinculada: true, proporcaoAtende: true }))
      .toBe('sistema_documentado');
  });

  it('componente externo TETA em componente_externo_declarado, mesmo com proporção e evidência', () => {
    expect(calcularEstado({
      ...base, corDosadaVinculada: true, proporcaoAtende: true,
      temComponenteExterno: true, evidenciasMinimasRecebidas: true,
    })).toBe('componente_externo_declarado');
  });

  it('sistema + evidências → evidencia_recebida', () => {
    expect(calcularEstado({
      ...base, corDosadaVinculada: true, proporcaoAtende: true, evidenciasMinimasRecebidas: true,
    })).toBe('evidencia_recebida');
  });

  it('evidência sem sistema (proporção falha) NÃO eleva: fica cor_dosada_verificada', () => {
    expect(calcularEstado({
      ...base, corDosadaVinculada: true, proporcaoAtende: false, evidenciasMinimasRecebidas: true,
    })).toBe('cor_dosada_verificada');
  });

  it('revisão humana concluída → conformidade_assistida (topo)', () => {
    expect(calcularEstado({
      ...base, corDosadaVinculada: true, proporcaoAtende: true,
      evidenciasMinimasRecebidas: true, revisaoHumanaConcluida: true,
    })).toBe('conformidade_assistida');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bunx vitest run src/lib/projeto-verificado/__tests__/estado.test.ts`
Expected: FAIL — `Cannot find module '../estado'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/projeto-verificado/estado.ts
// Escada de estados do Projeto Verificado (spec v2 §4). Substitui o "verde" único
// por estados nomeados pelo que CADA UM atesta — anti-sobrevenda. Função pura.
// Ordem (compra → execução → auditoria):
//   pendente_incompleto < cor_dosada_verificada < sistema_documentado
//   < evidencia_recebida < conformidade_assistida
// Exceções (não-ordinais): divergencia_encontrada (terminal), componente_externo_declarado.

export type EstadoProjeto =
  | 'pendente_incompleto'
  | 'cor_dosada_verificada'
  | 'sistema_documentado'
  | 'evidencia_recebida'
  | 'conformidade_assistida'
  | 'divergencia_encontrada'
  | 'componente_externo_declarado';

/** Fatos comprovados sobre o projeto (alimentados pela persistência + Check de Proporção). */
export interface FatosProjeto {
  /** Há ao menos uma dosagem Sayersystem/Colacor vinculada ao projeto. */
  corDosadaVinculada: boolean;
  /** Check de Proporção atende (ResultadoProporcao.atende). */
  proporcaoAtende: boolean;
  /** Algum componente foi comprado fora da Colacor (ResultadoProporcao.temComponenteExterno). */
  temComponenteExterno: boolean;
  /** Chegaram as fotos mínimas (lacre/etiqueta + lata aberta na peça). */
  evidenciasMinimasRecebidas: boolean;
  /** Passou por revisão humana / amostra-testemunha / auditoria. */
  revisaoHumanaConcluida: boolean;
  /** Há divergência registrada (contestação, lote incompatível, etc.). */
  divergencia: boolean;
}

export function calcularEstado(f: FatosProjeto): EstadoProjeto {
  if (f.divergencia) return 'divergencia_encontrada';
  if (!f.corDosadaVinculada) return 'pendente_incompleto';

  // Cor vinculada, mas comprou parte fora: reconhece a cor, não sobe a "sistema documentado".
  if (f.temComponenteExterno) return 'componente_externo_declarado';

  // Sem sistema documentado (proporção falha), nada de execução eleva o estado.
  if (!f.proporcaoAtende) return 'cor_dosada_verificada';

  if (f.revisaoHumanaConcluida) return 'conformidade_assistida';
  if (f.evidenciasMinimasRecebidas) return 'evidencia_recebida';
  return 'sistema_documentado';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bunx vitest run src/lib/projeto-verificado/__tests__/estado.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/projeto-verificado/estado.ts src/lib/projeto-verificado/__tests__/estado.test.ts
git commit -m "feat(projeto-verificado): escada de estados (anti-sobrevenda)"
```

---

### Task 3: Faixa de consumo

Classifica o volume dosado contra o consumo esperado (área ÷ rendimento) em **bandas amplas** — sinal de alerta/seleção de auditoria, nunca critério isolado de aprovação (spec §4). Doutrina "ausente ≠ zero": sem rendimento/área válidos, retorna `indeterminado`, não fabrica classe.

**Files:**
- Create: `src/lib/projeto-verificado/consumo.ts`
- Test: `src/lib/projeto-verificado/__tests__/consumo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/projeto-verificado/__tests__/consumo.test.ts
import { describe, it, expect } from 'vitest';
import { classificarConsumo, type ParametrosConsumo } from '../consumo';

// Sistema-exemplo: rende 10 m²/L. 40 m² → esperado 4 L.
const p = (over: Partial<ParametrosConsumo>): ParametrosConsumo => ({
  areaM2: 40,
  rendimentoM2PorLitro: 10,
  litrosDosados: 4,
  ...over,
});

describe('classificarConsumo', () => {
  it('volume na faixa do esperado → compativel', () => {
    const r = classificarConsumo(p({ litrosDosados: 4 }));
    expect(r.esperadoL).toBe(4);
    expect(r.classe).toBe('compativel');
  });

  it('até 30% abaixo ainda é compativel (banda ampla)', () => {
    const r = classificarConsumo(p({ litrosDosados: 3 })); // razão 0,75
    expect(r.classe).toBe('compativel');
  });

  it('entre 40% e 70% do esperado → baixo', () => {
    const r = classificarConsumo(p({ litrosDosados: 2 })); // razão 0,5
    expect(r.classe).toBe('baixo');
  });

  it('abaixo de 40% do esperado → suspeito', () => {
    const r = classificarConsumo(p({ litrosDosados: 1 })); // razão 0,25
    expect(r.classe).toBe('suspeito');
  });

  it('rendimento inválido → indeterminado (não fabrica classe)', () => {
    const r = classificarConsumo(p({ rendimentoM2PorLitro: 0 }));
    expect(r.classe).toBe('indeterminado');
    expect(r.esperadoL).toBeNull();
    expect(r.razao).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bunx vitest run src/lib/projeto-verificado/__tests__/consumo.test.ts`
Expected: FAIL — `Cannot find module '../consumo'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/projeto-verificado/consumo.ts
// Classificação de consumo em BANDAS AMPLAS (spec v2 §4): rendimento em madeira
// varia demais (substrato, demãos, método, perdas) → serve para ALERTA e seleção
// de auditoria, NUNCA como critério isolado de aprovação. Doutrina "ausente ≠ zero":
// sem rendimento/área válidos → 'indeterminado', não fabrica classe.
// Os limiares são calibráveis (default conservador); valores finais via discovery.

export type ClassificacaoConsumo = 'compativel' | 'baixo' | 'suspeito' | 'indeterminado';

export interface ParametrosConsumo {
  areaM2: number;
  /** Rendimento do sistema (m² por litro), do boletim técnico (discovery D3). */
  rendimentoM2PorLitro: number;
  litrosDosados: number;
  /** Razão abaixo da qual vira 'suspeito' (default 0,4). */
  limiarSuspeito?: number;
  /** Razão abaixo da qual vira 'baixo' (default 0,7). */
  limiarBaixo?: number;
}

export interface ResultadoConsumo {
  esperadoL: number | null;
  razao: number | null;
  classe: ClassificacaoConsumo;
}

export function classificarConsumo(p: ParametrosConsumo): ResultadoConsumo {
  const limiarSuspeito = p.limiarSuspeito ?? 0.4;
  const limiarBaixo = p.limiarBaixo ?? 0.7;

  // Ausente ≠ zero: entradas inválidas não viram classe fabricada.
  if (!(p.areaM2 > 0) || !(p.rendimentoM2PorLitro > 0)) {
    return { esperadoL: null, razao: null, classe: 'indeterminado' };
  }

  const esperadoL = p.areaM2 / p.rendimentoM2PorLitro;
  const razao = p.litrosDosados / esperadoL;

  let classe: ClassificacaoConsumo;
  if (razao < limiarSuspeito) classe = 'suspeito';
  else if (razao < limiarBaixo) classe = 'baixo';
  else classe = 'compativel';

  return { esperadoL, razao, classe };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bunx vitest run src/lib/projeto-verificado/__tests__/consumo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/projeto-verificado/consumo.ts src/lib/projeto-verificado/__tests__/consumo.test.ts
git commit -m "feat(projeto-verificado): faixa de consumo (bandas amplas)"
```

---

### Task 4: Verificação final da Fase 1

- [ ] **Step 1: Rodar a suíte completa do módulo**

Run: `heavy bunx vitest run src/lib/projeto-verificado`
Expected: PASS (17 tests: 4 + 8 + 5).

- [ ] **Step 2: Typecheck (strict)**

Run: `heavy bun run typecheck`
Expected: sem erros (o módulo é puro, sem dependências externas).

- [ ] **Step 3: Lint**

Run: `bun lint`
Expected: sem erros no diretório novo.

---

## Fases pós-gate (esboço — a detalhar em plano próprio após Fase 0)

> Não detalhadas em TDD aqui de propósito: sua forma depende do resultado do discovery (D1 export do Sayersystem, D3 parâmetros, D4-D6 jurídico). Detalhar agora seria inventar a forma dos dados.

- **Fase 2 — Persistência (ritual `lovable-db-operator`).** Tabelas `pv_projeto`, `pv_cesta_item`, `pv_vinculo_dosagem` (com **trilha append-only**: evento com usuário/hora/origem, retificação não-destrutiva), `pv_evidencia`, `pv_contestacao`. RLS desde a criação. Migration manual no SQL Editor do Lovable (não auto-aplica — CLAUDE.md). Forma do `pv_vinculo_dosagem` depende de **D1**.
- **Fase 3 — Captura no balcão.** Criação de Project ID por link/WhatsApp → QR + memorial + etiquetas destrutíveis; vínculo manual assistido + registro da cesta; dupla conferência acima de limite. Fricção-alvo de **D2**.
- **Fase 4 — Evidências (PWA).** Coleta de fotos (lacre + lata aberta na peça) via link leve, sem login pesado; metadados como suporte. Política de dados de **D6**.
- **Fase 5 — Motor comercial ex-post.** Prazo no boleto + seguro de retrabalho condicionados a estado forte + ticket mínimo; medição contra grupo de controle. Termos de **D4**.
- **Fase 6 — Certificado + alerta de lead-time.** Certificado em camadas (escada de estados, sem "100% verificado") + QR + texto de janela de cura; comunicação conservadora da Assistência (D4) e naming de **D7**.
- **Fase 7 — Integração Sayersystem.** Import CSV/batch diário substituindo o manual, se **D1** permitir.

---

## Self-Review

**1. Spec coverage (Fase 1):** As 3 inovações de domínio da v2 — Check de Proporção (§5), escada de estados (§4), faixa de consumo em bandas (§4) — têm tarefa. Os demais requisitos da spec (motor comercial, evidências, certificado, persistência, balcão, Sayersystem) são explicitamente mapeados às Fases pós-gate, bloqueadas pelo discovery — coerente com o gate da spec §9. Sem gaps silenciosos.

**2. Placeholder scan:** Sem "TBD"/"implementar depois" nas tarefas da Fase 1 — todo código está completo. A Fase 0 tem critérios de "done" concretos. As Fases pós-gate são deliberadamente esboço (justificado), não placeholders disfarçados de tarefa.

**3. Type consistency:** `ResultadoProporcao.atende`/`.temComponenteExterno` (Task 1) alimentam `FatosProjeto.proporcaoAtende`/`.temComponenteExterno` (Task 2) — nomes coerentes. `ItemCesta.origem` ('colacor'|'externo') é a única fonte do conceito "externo", usada nas duas tarefas. `ClassificacaoConsumo` inclui 'indeterminado' consistentemente no tipo e no retorno. Comandos de teste usam o caminho real `src/lib/projeto-verificado/__tests__/`.
