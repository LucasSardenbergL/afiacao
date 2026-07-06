# Spec — F5 Concentração de recebíveis abertos por código Omie (monitor de exposição)

> Frente 5 do pacote "PEGN — 9 erros que estrangulam a margem". Fecha o erro
> **concentração de crédito** (carteira de recebíveis dependente de poucos sacados).
> Money-path: precisão > recall, **ausente ≠ zero**, degradação honesta, nunca fabricar
> número **nem nome** (money-path.md). Design + challenge Codex (`gpt-5.5`, xhigh,
> 2026-07-05) — **veredito CONSTRUIR** (monitor lean; ≠ F4, o sinal EXISTE) com **2 P0 +
> 4 P1, todos acatados** (§10). Não é "alerta de HHI": é monitor honesto de exposição
> aberta por código Omie, com identificação como enriquecimento parcial account-scoped.

## 0. Achado que fixa o desenho (verificado em prod via psql-ro, 2026-07-05)

**O sinal de concentração existe e é limpo; a IDENTIFICAÇÃO do sacado é que é gap.**

- **Recebível ABERTO = `fin_contas_receber WHERE status_titulo IN ('A VENCER','ATRASADO')`.**
  O `saldo` **não zera na baixa** (títulos `RECEBIDO`/`CANCELADO` ficam com `saldo>0`
  histórico) → filtrar por **status**, nunca por `saldo>0`. Em título aberto,
  `saldo ≈ valor_documento` e `valor_recebido ≈ 0`. Volume por empresa (títulos abertos):
  oben 522, colacor 231, colacor_sc 29 — **todos < 1.000** (cap PostgREST não morde hoje;
  o read layer ainda tem de guardar o cap — §7).
- **Concentração por empresa (AR aberto, agrupado por `omie_codigo_cliente`):**

  | empresa | códigos | AR aberto | top1 | top5 | C50 (aprox) | HHI | nº efetivo |
  |---|---|---|---|---|---|---|---|
  | oben | 142 | R$ 380k | 14,3% | 34,1% | ~8–10 | 0,039 | ~25 |
  | colacor | 85 | R$ 144k | 14,0% | 48,4% | ~5–6 | 0,059 | ~17 |
  | colacor_sc | 18 | R$ 8,9k | 33,9% | 68,1% | ~2–3 | 0,156 | ~6 |

  Leitura: oben/colacor **diversificadas hoje** (sem alerta forte); colacor_sc concentra em
  ratio, mas **R$9k é imaterial** — daí o gate de materialidade ser **tom, não alarme**.
- **Nome do sacado é GAP de dado (todos os caminhos vazios ou inseguros):**
  `fin_contas_receber.nome_cliente` **100% vazio**; `cnpj_cpf` **100% vazio** no AR aberto;
  `omie_clientes` é **100% `empresa_omie='colacor'`** (tabela-elo `omie_codigo_cliente`→
  `user_id`, **sem nome/CNPJ**) → joinar por `omie_codigo_cliente` **sem escopo de conta
  FABRICA nome errado** (colisão numérica entre contas Omie). Confirmado pelo helper
  `src/lib/omie/account-coherence.ts` (money-path.md P0-A 2026-07-05): *"oben/colacor_sc
  resolvem o código via API do Omie e podem não estar no espelho local"*.

**Consequência que fixa o desenho:** a chave confiável para **AGREGAR** é
`(company, omie_codigo_cliente)` — um **proxy de cliente**, não CNPJ único nem grupo
econômico. Nome é **enriquecimento parcial** resolvido via Omie API por `(empresa, código)`.
A copy é honesta: **"concentração por código Omie/sacado — não consolida grupo econômico"**.

## 1. O que entra (escopo v1)

| Entrega | Fecha |
|---|---|
| Helper puro `concentracao-helpers.ts` (+ types), por-empresa, vitest | base |
| **Métricas primárias:** `totalAberto`, `maiorExposicao R$`, `top1%`, `top5%`, **`C50`** | concentração de crédito |
| **Tabela top-N** por código: `{código, R$ aberto, R$ vencido, %vencido próprio, share%}` | idem |
| **HHI / nº efetivo — SECUNDÁRIO** (tendência/sanidade, nunca headline nem threshold) | idem |
| **Metadata de fonte** (`ok`/`indisponivel`/`parcial`) → degradação honesta (empty ≠ zero) | money-path (P0-1) |
| **Gate de materialidade = TOM** (`baixo`/`moderado`/`alto` impacto absoluto), **nunca oculta** | money-path (P1-5) |
| **Nome:** enriquecimento parcial `(company,código)`-scoped; degrada "Cliente #código" | identificação (P0-2) |

**Fora da v1** (Codex F): nomes ricos completos; **grupo econômico** (`cliente_grupo_membros`)
— só entra com prova positiva `(company, omie_codigo_cliente) → grupo_id`; **semáforo forte**
(depende de apetite de risco explícito); **concentração de RECEITA** (histórico `RECEBIDO` — é
dependência comercial, não risco de crédito).

## 2. Modelo de dados

**Nenhuma tabela nova.** Lê `fin_contas_receber` direto (read path + RLS já provados — a aba
`contas-receber` do `FinanceiroDashboard` já lê essa tabela). Decisão client-vs-RPC no plano:
- **v1 client-side** (preferido): master lê os títulos abertos por empresa (≤522 linhas hoje)
  sob RLS existente e agrega no helper puro. Simples, sem migration.
- **RPC agregada** só se a leitura client bater RLS/perf/cap — aí `SECURITY DEFINER` + gate
  master, **provada em `prove-sql-money-path`** antes de entregar.

**Pisos de materialidade = POLÍTICA EXPLÍCITA** (Codex C — não há piso "científico"). O tom de
impacto é keyed na **maior exposição absoluta** (`maiorExposicao`, R$) — o dinheiro em risco no
maior sacado, a medida direta da severidade da concentração (um livro grande e pulverizado não
deve "gritar" pelo tamanho total; um sacado de R$54k importa mesmo com top1=14%). **Política v1**
(constante documentada, tunável pelo founder, **nunca número mágico solto**):
**`baixo` < R$ 25.000 · `moderado` R$ 25k–75k · `alto` > R$ 75.000**. Hoje: oben top-1 ≈R$54k →
`moderado`; colacor ≈R$20k → `baixo`; colacor_sc R$3k → `baixo` — **nada `alto`** (honesto, sem
incêndio). Política única (não por-empresa): R$54k de risco é R$54k independente do CNPJ; a
imaterialidade da colacor_sc já vem do próprio valor baixo, não de um piso especial por entidade.

## 3. Indicadores (helper puro `src/lib/financeiro/concentracao-helpers.ts`, vitest)

### Tipos (`concentracao-types.ts`)

```ts
export type Company = 'oben' | 'colacor' | 'colacor_sc';

/** Status da LEITURA da fonte (atestado pela camada de read). O helper NUNCA calcula
 *  sobre fonte não provada — lista vazia pode ser erro/RLS/timeout, não zero (P0-1). */
export type FonteStatus = 'ok' | 'indisponivel' | 'parcial';

/** Título de recebível ABERTO, já filtrado pela camada de leitura. */
export interface TituloAberto {
  omie_codigo_cliente: number | null;
  saldo: number;
  atrasado: boolean; // status_titulo === 'ATRASADO'
}

export type MotivoConcentracao =
  | 'ok'
  | 'sem_carteira'        // fonte ok + 0 títulos válidos → zero PROVADO
  | 'fonte_indisponivel'  // leitura falhou/RLS/timeout → NÃO é zero, não calcula
  | 'fonte_parcial';      // truncada (cap) ou linha(s) inválida(s) → calcula flagueado

export type ImpactoAbsoluto = 'baixo' | 'moderado' | 'alto';

export interface LinhaExposicao {
  codigo: number;
  saldo: number;             // R$ aberto do código
  vencido: number;           // R$ ATRASADO do código
  pctVencidoProprio: number; // vencido/saldo ∈ [0,1]
  share: number;             // saldo/totalAberto ∈ [0,1]
}

export interface ConcentracaoResult {
  motivo: MotivoConcentracao;
  clientes: number | null;                 // nº de códigos distintos válidos
  totalAberto: number | null;              // 0 em sem_carteira; null em indisponivel
  maiorExposicao: number | null;           // R$ do maior código
  top1Pct: number | null;
  top5Pct: number | null;
  c50: number | null;                      // menor nº de códigos que somam ≥50%
  hhi: number | null;                      // SECUNDÁRIO
  nEfetivo: number | null;                 // 1/hhi, SECUNDÁRIO
  impactoAbsoluto: ImpactoAbsoluto | null; // TOM de materialidade (nunca oculta topN)
  topN: LinhaExposicao[];                  // [] fora de ok/parcial; sempre VISÍVEL na UI
  linhasInvalidas: number;                 // saldos/códigos inválidos (dispara fonte_parcial)
}
```

### Função principal

```ts
export function concentracaoEmpresa(
  titulos: TituloAberto[],
  fonte: FonteStatus,
  opts: { topN?: number; pisoModerado: number; pisoAlto: number },
): ConcentracaoResult
```

**Ordem de gates (money-path):**
1. `fonte === 'indisponivel'` → tudo `null`, `motivo:'fonte_indisponivel'`, `topN:[]`. **Não
   calcula nada** (P0-1: empty pode ser falha, não zero).
2. Particiona linhas: **válida** = `omie_codigo_cliente != null && Number.isFinite(saldo) &&
   saldo > 0`. `linhasInvalidas = total − válidas`. Linha inválida **nunca some silenciosa** —
   conta e, se houver ≥1, força `fonte_parcial` (Codex E).
3. Sem linha válida **e** `fonte === 'ok'` **e** `linhasInvalidas === 0` → `motivo:'sem_carteira'`,
   `totalAberto: 0`, demais métricas `null`, `topN:[]` (zero **provado**).
4. Sem linha válida mas `fonte === 'parcial'` ou `linhasInvalidas>0` → `fonte_parcial` com métricas `null`.
5. Com linha válida → agrega por código, calcula, e
   `motivo = (fonte === 'parcial' || linhasInvalidas > 0) ? 'fonte_parcial' : 'ok'`. Métricas
   não-nulas, **flagueadas** quando parcial.

**Métricas (funções puras separadas, testáveis):**
- `totalAberto = Σ saldo (válidos)`; `clientes = nº códigos distintos`.
- Agrega saldo e vencido (`atrasado`) por código; ordena desc por saldo.
- `maiorExposicao`, `top1Pct = maior/total`, `top5Pct = Σ top5/total`.
- **`c50`** = menor nº de códigos (ordenados desc) cujo share acumulado **≥ 0,5** (um código
  >50% → C50=1). Melhor que HHI no viés de cauda e legível (Codex P1-4/B).
- `hhi = Σ share²` (secundário); `nEfetivo = 1/hhi` (secundário).
- `impactoAbsoluto` (keyed na **`maiorExposicao`**, não no total — é o risco single-name):
  `maiorExposicao < pisoModerado → 'baixo'`; `< pisoAlto → 'moderado'`; senão `'alto'`.
  Política v1: `pisoModerado=25000`, `pisoAlto=75000` (tunável). É **tom**, nunca oculta o `topN` (P1-5).
- `topN[i]`: `{codigo, saldo, vencido, pctVencidoProprio: vencido/saldo, share: saldo/total}`.
  Código sem vencido → `vencido:0`, `pctVencidoProprio:0` (não `null` — zero real).

**Nome NÃO entra no helper puro** — é enriquecimento de apresentação (assíncrono, API,
`(company,código)`-scoped). O helper opera só sobre códigos. Isola money-path de I/O.

## 4. A armadilha (o que fixa o método) — identificação vs agregação

**Análogo à armadilha-mãe do F1 (double-count), aqui é dupla:**
1. **`empty` fabricando zero** — o helper puro não distingue "carteira zerada" de
   "query falhou / RLS / timeout / filtro errado / sync parcial". Sem metadata de fonte, um
   `sem_carteira` é um zero inventado (P0-1).
2. **Nome cross-account fabricado** — resolver por código puro devolve nome de OUTRA conta
   Omie (colisão numérica). Só `(company, código)` + cache por par + guard account-coherence
   é seguro; ausência local **não valida** identidade (P0-2).

**Decisão v1 (3 camadas):**
1. Helper recebe **`FonteStatus`** atestado pela camada de leitura; só calcula com fonte
   provada; `sem_carteira` exige `fonte='ok'` + 0 inválidas.
2. Agregação por `(company, omie_codigo_cliente)` — **proxy de sacado**, não grupo econômico.
   Limitação **explícita** na copy; grupo fora do v1 (P1-6).
3. Nome = enriquecimento parcial `(company,código)`-scoped, degrada "Cliente #código"; guard
   `codeBelongsToWrongAccount` reaproveitado se necessário (P0-2).

## 5. Degradação honesta (invariantes money-path)

- `fonte='indisponivel'` → `null` + motivo; **nunca calcula** (empty ≠ zero — P0-1).
- lista vazia só é `sem_carteira` com **fonte provada `ok`** e zero linha inválida.
- linha com `saldo`/`código` inválido → conta em `linhasInvalidas` + `fonte_parcial`;
  **nunca some silenciosa** (Codex E).
- leitura truncada (cap PostgREST 1.000) → camada de read reporta `fonte='parcial'`.
- nome não resolve `(company,código)` → **"Cliente #código"**, jamais nome de outra conta (P0-2).
- materialidade → **tom** (`baixo`/`moderado`/`alto`), **nunca oculta** o painel (P1-5).
- código ≠ cliente/CNPJ/grupo → copy explícita "por código Omie, não consolida grupo" (P1-3/6).
- HHI/nº efetivo → **secundário**, nunca headline nem threshold antitruste (P1-4).

## 6. Segurança / RLS

- **Master-only** (dado financeiro), padrão do módulo. v1 client-side reusa o read path já
  provado da aba `contas-receber` (RLS existente). Se virar RPC agregada → `SECURITY DEFINER`
  + gate `master` explícito, provada no PG17.
- **Resolver de nome:** credencial/scope por `(empresa, código)`; **cache keyed `(company,código)`**,
  nunca só código; guard account-coherence por prova positiva de conta errada.

## 7. Arquitetura e superfície de UI

- **Helper:** `src/lib/financeiro/concentracao-helpers.ts` + `concentracao-types.ts` (puro, vitest).
- **Camada de leitura (hook `useConcentracaoRecebiveis`):** lê `fin_contas_receber` por empresa
  (filtro por `status_titulo`), **produz o `FonteStatus`**: `ok` só quando a query resolve **e
  não truncou**. Guarda o **cap PostgREST**: se `rows.length === limit` (ou `count ≥ cap`) →
  `fonte='parcial'` (ou pagina com `.range()` estável). Erro/timeout → `fonte='indisponivel'`.
  Chama o helper. Enriquece só o `topN` com nome via resolver `(company,código)`-scoped
  (degrada "Cliente #código").
- **UI:** aba/section **master-only** no `/financeiro` (`FinanceiroDashboard`, padrão de abas
  onde a DRE/F3 vive). Cards de métrica **primária** (maior R$, top5, C50) + **badge de impacto
  absoluto** (tom) + tabela `topN` (R$ aberto, R$ vencido, %vencido, share, nome/"#código") +
  HHI/nº efetivo em bloco **secundário** de tendência. Estados honestos: `fonte_indisponivel`
  → `<EmptyState>` "não foi possível ler a carteira" (não "sem concentração"); `fonte_parcial`
  → banner "leitura parcial — N linhas inválidas/truncada". Copy fixa: **"Concentração por
  código Omie (sacado) — não consolida grupo econômico."**
- House style: `text-status-*`, `useUrlState`, `sonner`, `<PageSkeleton>`, `<EmptyState>`.

## 8. Prova (vitest do helper puro; prove-sql só se houver RPC) + threat-model

**Vitest (helper puro) — asserts:**
- `C50`: 1 código >50% → C50=1; carteira uniforme de N → C50≈N/2; empates estáveis.
- `top1`/`top5`/`share`: corretos; `top5` com <5 códigos = soma dos existentes.
- `hhi`/`nEfetivo`: corretos; secundários.
- **P0-1 (a prova central):** `[] + fonte='ok'` → `sem_carteira`; `[] + fonte='indisponivel'`
  → `fonte_indisponivel` (**NÃO** `sem_carteira`); `[...] + fonte='indisponivel'` → não calcula.
- **Codex E:** linha `saldo=NaN/-1/Infinity` ou `codigo=null` → `linhasInvalidas≥1` +
  `fonte_parcial`; a linha **não** entra no total; total dos válidos permanece correto.
- vencido: `pctVencidoProprio` correto; código sem ATRASADO → `vencido:0` (não `null`).
- materialidade: `totalAberto < pisoModerado` → `'baixo'` **e** `topN` continua preenchido.
- **Falsificação:** (a) fazer o helper calcular com `fonte='indisponivel'` → teste fica
  **vermelho**; (b) fazer linha inválida sumir sem `fonte_parcial` → **vermelho**; restaurar → verde.

**Threat-model (1 assert cada):**

| Situação | Default | Racional |
|---|---|---|
| `fonte` não provada `ok` | `null` + motivo, não calcula | empty pode ser falha, não zero (P0-1) |
| lista vazia + `fonte='ok'` | `sem_carteira`, total 0 | zero **provado** |
| saldo/código inválido numa linha | `fonte_parcial` + contagem | linha nunca some (Codex E) |
| AR > 1.000 títulos (cap PostgREST) | `fonte_parcial` | leitura truncada ≠ completa |
| nome não resolve `(company,código)` | "Cliente #código" | jamais nome de outra conta (P0-2) |
| materialidade baixa | tom "baixo impacto", `topN` visível | nunca oculta (P1-5) |
| não-master lê | 0 linhas / bloqueado | financeiro master-only |

Se a leitura virar RPC agregada `SECURITY DEFINER` → **prove-sql-money-path** (asserts +
RLS `SET ROLE` + falsificação) antes de entregar.

## 9. Decisões (resolvidas com o Codex, §10)

1. **Construir vs adiar:** CONSTRUIR (monitor lean) — o sinal existe, ≠ F4. ✅
2. **Headline:** maior R$ + top1/top5 + **C50**; HHI/nº efetivo secundários. ✅ (P1-4)
3. **Materialidade:** **tom** (baixo/moderado/alto) keyed na maior exposição R$; política v1
   25k/75k (única, tunável); nunca oculta o painel. ✅ (P1-5, C)
4. **Chave:** `(company, omie_codigo_cliente)` p/ agregar; grupo econômico **fora do v1**. ✅ (P1-6/D)
5. **Nome:** enriquecimento parcial `(company,código)`-scoped; degrada "Cliente #código". ✅ (P0-2)
6. **Metadata de fonte** no helper (empty ≠ zero; inválida ≠ some). ✅ (P0-1/E)
7. **Copy honesta:** "por código Omie, não consolida grupo econômico". ✅ (P1-3)
8. **Sem tabela nova** (lê `fin_contas_receber`); RPC só se necessário, provada. ✅

## 10. Veredito do challenge Codex (2026-07-05, xhigh — CONSTRUIR + 2 P0 + 4 P1, todos acatados)

- **P0-1** — `empty → sem_carteira` **fabrica zero**. Helper recebe metadata de fonte; só
  calcula com fonte provada; senão `null + fonte_indisponivel/parcial`.
- **P0-2** — nome via API por código puro → **nome de outra conta**. Resolver
  `(company,código)`-scoped + cache por par + guard account-coherence.
- **P1-3** — "cliente" é forte demais → copy "por código Omie/sacado, não consolida grupo".
- **P1-4** — HHI headline dá falsa tranquilidade → primárias maior R$ + top1/top5 + **C50**;
  HHI secundário.
- **P1-5** — materialidade não pode **esconder** o painel → controla tom, não visibilidade.
- **P1-6** — agrupar por código **subconta** grupo econômico → limitação explícita; grupo
  fora do v1 salvo prova positiva `(company,código)→grupo_id`.
- **E** — linha com saldo/código inválido **não some** → `fonte_parcial` + contagem.
- **Veredito literal:** *"CONSTRUIR, mas não como 'alerta de HHI'. Construir como monitor lean
  de exposição aberta por código Omie… Não é F4: aqui o número-base existe; o buraco é
  identificação/semântica, não ausência do sinal."*

**Revisão independente:** ✅ Codex (design) 2026-07-05. Pendente: Codex adversarial **no código**
após implementar (padrão F1 §11) + prove-sql se houver RPC.
