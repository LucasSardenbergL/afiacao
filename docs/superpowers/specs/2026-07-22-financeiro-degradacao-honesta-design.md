# Degradação honesta no dashboard financeiro (`useFinanceiro`) — PR-A

> **Data:** 2026-07-22 · **Domínio:** money-path (financeiro) · **Origem:** follow-up do #1548 (que fez `getFluxoCaixa` lançar em vez de devolver caixa parcial silencioso).
> **Princípio-guia:** money-path §2 (ausente ≠ zero / degradação honesta) e §7 (consertar o helper não conserta a tela; falha → último dado bom + aviso de stale; sem cache → "indisponível", nunca zero, nunca skeleton eterno).

## Problema

`src/hooks/useFinanceiro.ts` tem ~10 blocos `catch` que fazem `setError(msg)` mas **não limpam o state correspondente**. Num re-load que falhe, o `data` state mantém a carga anterior e a UI renderiza um banner de erro por cima — o gráfico e os KPIs seguem exibindo números velhos como se fossem atuais. Menos grave que o #1548 (lá o número era parcial e se apresentava como completo); aqui o número é íntegro porém desatualizado, com aviso visível. Ainda assim colide com a degradação honesta: a tela deveria dizer "indisponível" em vez de mostrar caixa antigo sob um banner que o usuário pode não ler.

A investigação ampliou o diagnóstico para **quatro defeitos distintos**, confirmados no código (não em relato):

- **D1 — dado velho sob banner.** Os ~10 `catch` setam `error` e preservam o `data` state anterior. Real, mas o service **lança** de verdade (`throw error` em `financeiroService.ts`), então o `catch` dispara e a correção não é inerte.
- **D2 — `error` é um único string global** para os 10 loaders. Só `syncAll`/`syncSpecific` o limpam. Falha no resumo da Visão Geral → trocar para Fluxo de Caixa (que carrega com sucesso) → o banner continua no topo, agora acusando falsamente a aba certa. E o banner não diz *qual* dataset caiu.
- **D3 — `getAgingReceber`/`getAgingPagar` engolem o erro** e retornam `EMPTY_AGING` (todos zeros) — `financeiroService.ts:307` e `:317` (`if (error || !data) return { ...EMPTY_AGING }`). Falha de consulta vira aging R$ 0,00 em toda a cadeia, **e o `error` do hook nem chega a ser setado**. Consequência em `utils/financeiroAlerts.ts:70`: o alerta de inadimplência só dispara se `vencido_90_plus_valor > 20000` → **o alarme não toca porque o sensor quebrou** (falha aberta). Aqui limpar o state no `catch` seria **inerte** (lição do #1498, §2): o par correto é consumidor **e** produtor.
- **D4 — `FluxoCaixaTab.tsx:38`**: `let acumulado = saldoCC || 0`. Se o resumo falhou (`saldoCC` undefined), a coluna "Acumulado" projeta saldo a partir de zero. O KPI "Saldo CC" já se esconde quando `null` (`:65`), mas o gráfico consome calado.

### Achado estrutural (delimita o escopo)

Só **2 dos 13** consumidores usam de fato o `useFinanceiro`: `FinanceiroDashboard.tsx` e `FinanceiroSync.tsx`. Cockpit (`useFinanceiroCockpit`), Zone (`useFinanceiroZone`) e PosicaoAgora (`usePosicaoAgora`) têm estado próprio e chamam o service direto, com caminhos de zero-fabricado independentes e piores (ex.: `useFinanceiroCockpit:166` — resumo vazio → `riscoLiquidez = 0` → label **"Alto"** em vermelho; `useFinanceiroZone` — 4 `catch {}` vazios → `isError` inalcançável, "Sem inadimplentes críticos." produzido por falha engolida). **Estes ficam para o PR-B** (chip).

## Padrão escolhido: reusar o do #1550, não inventar outro

O #1550 (`IntelligenceManagerialTab.tsx:121`) já implementou exatamente este padrão, com teste que o fixa (`intelligence/__tests__/tabs-erro-honesto.test.tsx`):

```ts
const scoresIndisponivel = isError && !allScores;    // sem dado → "—" + banner error
const scoresDesatualizados = isError && !!allScores; // com dado → mantém + banner warning
const ou = (v: string) => (scoresIndisponivel ? '—' : v);
```

Três estados por dataset:
- **`ok`** — sem erro. Renderiza normal.
- **`stale`** — erro **com** dado anterior. Mostra o último dado bom + aviso amarelo (warning).
- **`unavailable`** — erro **sem** dado. Mostra "—" + aviso vermelho (error). Nunca "R$ 0,00", nunca skeleton eterno.

Inventar um segundo padrão para o mesmo problema, uma semana depois, seria o erro. A alternativa que o pedido levantou — "limpar o state no `catch` (`setFluxoCaixa([])`)" — foi **descartada**: cairia no empty-state do `FluxoCaixaTab` que diz *"Sincronize os dados primeiro."*, trocando um número velho por uma mensagem que **culpa a sincronização** numa falha de consulta.

## Arquitetura da mudança (4 camadas)

### Camada 1 — service (`financeiroService.ts`) — corrige D3
`getAgingReceber`/`getAgingPagar` param de engolir o erro:

```ts
if (error) throw new Error(`Falha ao carregar aging recebíveis: ${error.message}`);
const rows = data ?? [];                    // [] genuíno (empresa sem títulos) → EMPTY_AGING = zero REAL
if (company === 'all') return consolidateAging(rows);
return pickAgingForCompany(rows, company);
```

Distinção que preserva a precisão>recall: aging **genuinamente vazio** (empresa sem títulos) continua virando `EMPTY_AGING` (zeros **reais**, corretos); só a **falha de consulta** lança. Exportar `EMPTY_AGING` (hoje `const` privado no módulo) para os chamadores reusarem sem literal duplicado.

### Camada 2 — os 3 chamadores do aging (só o hook ganha honestidade agora)
Fazer o service lançar pode **regredir** os outros chamadores, que hoje contam com o swallow. Decisão aprovada: só o `useFinanceiro` ganha honestidade neste PR; os outros **preservam o comportamento atual explicitamente**.

- **`useFinanceiro.loadAging` (`:114-126`)** — já tem try/catch em volta do `Promise.all(getAgingReceber, getAgingPagar)`. O catch hoje quase nunca dispara (service engole); após D3, dispara e passa a popular `errors.aging`. ✅ **ganha honestidade.**
- **`useFinanceiroCockpit:69`** — `getAgingReceber('all')` é a **única** das 5 chamadas do `Promise.all` (`:62`) **sem `.catch()`**. Após D3, uma falha de aging faria o `Promise.all` rejeitar → catch de topo (`:134`) → `COCKPIT_VAZIO` → **cockpit inteiro zerado** (regressão: hoje só o aging zera). Adicionar `.catch(() => EMPTY_AGING)` com comentário: comportamento preservado, PR-B trata. 🔒 **anti-regressão obrigatória.**
- **`useFinanceiroZone:32-34`** — já tem `try { getAgingReceber } catch {}` vazio. Após D3, o catch engole a exceção, `aging90` fica 0 (comportamento mantido). **Nada a fazer no PR-A.** PR-B torna honesto.

### Camada 3 — hook `useFinanceiro` — corrige D1 + D2
- Adicionar **`errors: Partial<Record<DatasetKey, string>>`** onde `DatasetKey = 'resumo' | 'contasPagar' | 'contasReceber' | 'aging' | 'dre' | 'fluxoCaixa' | 'inadimplentes'`.
- Cada loader: **sucesso limpa a própria key**, **falha seta a própria key**, e **nunca limpa o `data` state** (é o que preserva o "último dado bom" para o estado `stale`).
- O `error` string passa a valer **só para ações de sync** (`syncAll`/`syncSpecific`/`calcularDRE`/`calcularDREAnual`). O banner do topo do dashboard vira "a sincronização falhou" — semanticamente correto, e mata o D2 (banner grudento que acusava a aba errada). Decisão aprovada pelo founder.
- Helpers internos `setDatasetError(key, msg)` / `clearDatasetError(key)` (imutáveis sobre o objeto).

### Camada 4 — dashboard
Helper **puro** novo, testável isolado, em `src/components/financeiro/dashboard/dataStatus.ts` (junto de `format.ts`): `statusFrom(hasError: boolean, hasData: boolean): 'ok' | 'stale' | 'unavailable'` mais o tipo `DataStatus`. Teste em `src/components/financeiro/dashboard/__tests__/dataStatus.test.ts`.

- **`FluxoCaixaTab`** — prop `status?: DataStatus` (default `'ok'`):
  - `unavailable` → banner vermelho "indisponível" **em vez** do empty-state "Sincronize os dados primeiro". Vazio **genuíno** (`data.length === 0 && status === 'ok'`) mantém a mensagem de sync — resolve o item 3 do pedido.
  - `stale` → renderiza o gráfico + aviso amarelo.
  - D4: quando `saldoCC == null`, a coluna "Acumulado" mostra "—" em vez de projetar a partir de zero.
- **`VisaoGeralTab`** — `KpiCard` ganha prop `unavailable?: boolean` (default false) → renderiza "—" em vez de `fmtCompact(value)`. Sob resumo indisponível: os 4 KPIs + bloco "Indicadores Financeiros" mostram "—". Sob aging indisponível: `AgingCard` e "Risco +90 dias" mostram "—". Banner de indisponibilidade/stale no topo da aba (role="alert").
- **`FinanceiroDashboard.tsx`** — deriva `statusFrom(...)` por dataset e passa aos filhos; o banner do topo passa a renderizar o `error` de sync (não mais o de load).

## Fora de escopo (PR-B, com chip)

`useFinanceiroCockpit` (Risco "Alto" fabricado, 12 números zerados), `useFinanceiroZone` (4 `catch {}` vazios, `isError` inalcançável, alerta de inadimplência suprimido), `usePosicaoAgora` (`setData([])` no catch → "Sincronize o financeiro primeiro" para exceção capturada). Cada um é um caminho independente do hook, com sua própria fabricação de número — merecem PR próprio, revisável e falsificável isoladamente.

## Plano de teste e falsificação (money-path §31/§37)

**Baseline primeiro:** rodar a suíte do domínio com a árvore provada limpa, capturar o **denominador** (total de testes) e o verde — em suíte JS o tell de "não rodou nada" é o total, não o exit code.

Cobertura nova (vitest):
1. **Service** — `getAgingReceber`/`Pagar` **lançam** em `{ error }`; retornam `EMPTY_AGING` em `{ data: [] }` (vazio genuíno = zero real).
2. **Hook** — loader que falha seta `errors[key]` correto e **preserva** o `data` anterior (prova do `stale`); loader que tem sucesso **limpa** só a sua key (prova que o banner não gruda entre abas — D2).
3. **`FluxoCaixaTab`** — `status='unavailable'` mostra "indisponível" e **não** "Sincronize"; `status='ok'` + `data=[]` mantém "Sincronize" (vazio genuíno); `saldoCC=null` → "Acumulado" não fabrica.
4. **`VisaoGeralTab`** — sob indisponível, KPIs mostram "—", **não** "R$ 0,00" / "0%".

**Falsificação:** para cada guard, sabotar (ex.: reverter `throw` para o `return EMPTY_AGING`; `statusFrom` retornar sempre `'ok'`; prop `unavailable` ignorada) e exigir vermelho — **conferindo a contagem e os nomes** dos testes que falham (têm de ser os que a sabotagem mira, e só eles). Ancorar asserções em strings ASCII exclusivas do ramo (não "página N" compartilhado; acento é armadilha de padrão). Baseline verde explícito antes de cada rodada, com árvore limpa no instante da execução (o `heavy` é fila — o relógio mente).

## Registro de módulo

**Sem mudança no manifesto.** O módulo `financeiro` já cobre `src/components/financeiro/**` (`manifesto.ts:108`), e o `manifesto.gate` trata os `__tests__` sob esse glob como dono do próprio código — prova empírica: `FluxoCaixaTab.test.tsx` já existe fora da lista `testes` e o CI está verde. Logo `dataStatus.ts` e `dataStatus.test.ts` (ambos sob `src/components/financeiro/dashboard/`) já têm dono.

## Gates

`heavy bun run typecheck` · `heavy bun run test` · `bun lint` — todos verdes antes do commit (não prever o verde de gate que ainda não fechou). Sem migration, sem edge, sem deploy de banco: é mudança só-frontend (`src/`), então o único passo de produção é **Publish do frontend** no Lovable.

---

## Revisão 2026-10-10 — re-escopo sobre a main atual (1.379 commits depois)

Ao retomar, a main já tinha resolvido parte do spec por outros PRs:

- **D3 resolvido** — `getAgingReceber`/`getAgingPagar` lançam em `error` e em `data=null` (#1564/#2917).
- **Cockpit e Zone resolvidos** — o cockpit faz `.catch(() => null)` no aging (exibe "—"), a Zone deixa `aging90` null.
- **D4 resolvido** — `FluxoCaixaTab` com `saldoCC == null` exibe "—" e avisa "sem âncora".
- **`KpiCard` já aceita `value: number | null`** ("—" para null).

E a main **tomou uma decisão que contradiz o estado `stale` deste spec**: `loadFluxoCaixa` e `loadAging` passaram a **limpar** o dado na falha, com razão documentada — na troca de empresa, o dado "anterior" é de OUTRA empresa e apareceria sob o rótulo da atual (#2459/#2875). O argumento vale igual para `contasPagar`, `contasReceber`, `dre`, `inadimplentes` e as chaves do `resumo`.

**Desenho revisado (substitui as Camadas 1–4):**

1. **Hook** — `errosCarga: Partial<Record<DatasetFinanceiro, string>>`. Cada `loadX`: sucesso limpa a própria chave; falha **limpa o dado daquele dataset** (padrão que a main já adotou em fluxo/aging) e seta a própria chave. O `error` string passa a ser **só de ações** (`syncAll`/`syncSpecific`/`calcularDRE*`) — o banner do topo deixa de acusar a aba errada (D2).
2. **UI** — cada aba recebe `indisponivel?: string | null` e, quando setado, diz "indisponível — a leitura falhou: <motivo>" no lugar de "Sincronize os dados primeiro" / "Clique em Recalcular" / skeleton eterno / card que some. KPIs da Visão Geral deixam de mandar `|| 0` (passam `?? null`).
3. **Sem estado `stale`** — descartado por consistência com a main e YAGNI. O helper `statusFrom` sai do escopo.

Fora de escopo (inalterado): `useFinanceiroCockpit`/`useFinanceiroZone`/`usePosicaoAgora` como PR-B — reavaliar na hora, porque parte já foi resolvida na main.
