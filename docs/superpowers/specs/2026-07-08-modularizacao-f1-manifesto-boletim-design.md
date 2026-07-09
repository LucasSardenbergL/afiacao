# Modularização do Afiação — F1: manifesto de módulos + boletim de saúde (design)

> Spec da **Fase 1** do programa de modularização. Decidido em sessão 2026-07-08 com 2ª opinião Codex (`gpt-5.5`, reasoning `high`, consult de metodologia — parecer integral no histórico da sessão). Fases seguintes têm spec próprio quando chegarem.

## Contexto e problema

O founder quer "separar o app em módulos granulares para avaliar problemas de bug em cada um deles", com ganho de qualidade de entrega e velocidade. O mapeamento da sessão mostrou que **a separação física por domínio já existe em boa parte** (`src/lib/<dominio>`, `src/components/<dominio>`, ~14 módulos de negócio já descritos em `docs/agent/mapa-do-app.md`), mas:

- **Não há fonte declarativa** de "quais paths pertencem a qual módulo" — o mapa é prosa, não é verificável nem consumível por tooling.
- **Não dá para avaliar um módulo isolado**: vitest roda os 574 arquivos de teste num bloco só; typecheck é um único programa (`tsc -p tsconfig.app.json`, `include: ["src"]`); não existe "saúde do módulo X".
- Partes do código são **flat** (173 pages, 222 hooks) — pertencimento a módulo é implícito no prefixo do nome.

## Programa (4 fases) e por que fasear

| Fase | Entrega | Risco de conflito (≈24 worktrees paralelas) |
|---|---|---|
| **F1 (este spec)** | Manifesto declarativo + gate anti-apodrecimento + boletim de saúde por módulo | ~zero (só arquivos novos) |
| F2 | Fronteiras anti-vazamento (dependency-cruiser/eslint sobre o manifesto da F1) | baixo-médio |
| F3 | Mover código físico para `src/modules/` | **altíssimo** — exige janela coordenada |
| F4 | Perf/bundle por módulo (code-splitting, chunks) | baixo |

Ordem comprometida com o founder: F1→F2→F3→F4. **Parecer Codex a revisitar após a F2:** inverter para F1→F2→F4→F3 e tratar F3 como *opcional* — "manifesto + fronteiras resolvem 80% do problema; mover código é o maior risco de merge e talvez não seja necessário". A decisão só se torna real depois da F2; registrada aqui para não se perder.

F1 **não move código e não toca arquivo quente**. Nada de mudanças em `package.json`/lockfile (ímã de conflito e é desnecessário — bun invoca script direto), nem em workflows de CI (o gate é um teste vitest comum, entra no `bun run test` existente).

## Decisões de design (Claude × Codex — convergência)

### 1. Granularidade: híbrido, negócio-primeiro

- **Eixo principal: ~14 módulos de negócio** do `mapa-do-app.md` (financeiro, reposicao, tint, estoque-recebimento, vendas, farmer, admin-crm, knowledge-base, producao, telefonia-whatsapp-rota, caca, tarefas, loja-afiacao, governanca — lista final definida na implementação, ancorada no mapa). É a fronteira em que rota, gate, usuário e "onde o bug dói" coincidem.
- **`plataforma` é módulo próprio** (kind `plataforma`): ui/shadcn, shell, auth, contexts, integrations, logger, format, postgrest, test-utils etc. Contar código compartilhado dentro dos módulos de negócio poluiria o boletim.
- Campo `submodulos` existe no schema mas nasce vazio — povoar apenas quando o boletim provar que um módulo virou caixa-preta (candidatos óbvios pela evidência de churn: reposicao, financeiro). Ir direto a ~50 módulos (1 por pasta de `src/lib`) = precisão falsa e manutenção cara.

### 2. Ownership: 1 dono primário, sem dupla contagem

- Cada arquivo de `src/` tem **exatamente um** módulo dono. Sobreposição de globs = **erro** (gate vermelho). Efeito cruzado entre módulos é assunto de *dependência* (F2), não de dupla posse.
- Órfão (arquivo sem dono) = **erro**, exceto se listado em **`naoClassificados`**: lista explícita no manifesto, com justificativa e data (`{ path, motivo, desde }`). Dívida visível e queimável — nunca bucket `unknown` silencioso. O bootstrap pode nascer com uma lista grande (hooks/pages flat sem prefixo limpo); o gate impede que **cresça**.

### 3. Formato: TypeScript type-safe

`src/lib/modulos/manifesto.ts` exporta `MODULOS: ModuloApp[]` + `NAO_CLASSIFICADOS`. TS (e não JSON) porque a F2 importa a MESMA fonte para gerar regras de fronteira, e o gate/boletim importam sem parse. Precisar de JSON um dia → gerar a partir do TS.

Schema mínimo:

```ts
type ModuloApp = {
  id: string;               // "financeiro"
  nome: string;             // "Financeiro"
  kind: "negocio" | "plataforma";
  rotaPrefixos: string[];   // ["/financeiro"]
  gates: string[];          // ["RequireFinanceiroAccess"]
  codigo: string[];         // globs: ["src/lib/financeiro/**", "src/pages/Financeiro*.tsx", ...]
  testes: string[];         // globs dos arquivos de teste do módulo
  submodulos?: SubmoduloApp[]; // reservado; nasce vazio
  risco: { moneyPath: boolean; offlineFirst: boolean; authSensitive: boolean };
};
```

### 4. Métricas do boletim: fatos ≠ proxies ≠ desconhecidos (sem score único)

Regra money-path aplicada ao meta-tooling: **métrica sem fonte confiável = `desconhecido`, nunca 0/100 fabricado; teste ausente ≠ sucesso** (status `sem-testes`, jamais "passou").

| Métrica | Classe | Fonte |
|---|---|---|
| nº arquivos de código / de teste | fato | expansão dos globs |
| LOC | fato | contagem mecânica |
| rotas, gates, flags de risco | fato | manifesto |
| órfãos / sobreposições / nº `naoClassificados` | fato | gate |
| resultado de teste por módulo (`passou`/`falhou`/`sem-testes`) | fato | **1 run global** vitest com reporter JSON, atribuído por path |
| erros de typecheck/lint **localizados** no módulo | fato (com ressalva) | tsc/eslint globais 1×, erro atribuído ao dono do path |
| densidade `testes/arquivos` | **proxy fraco** (rotulado) | derivada |
| churn git 30/90 dias por módulo | **proxy** (rotulado) | `git log --name-only` |
| cobertura | **desconhecida** | provider não instalado — e F1 NÃO instala (lockfile = conflito) |
| bugs históricos por módulo | **desconhecido** | `bugs-resolvidos.md` é prosa não-estruturada; atribuição confiável impossível |

**Honestidade do typecheck:** `tsconfig.app.json` é um programa único — "typecheck do módulo X" é ilusório. O boletim reporta o veredito **global** + a *localização* dos erros por dono do path ("erros localizados em: financeiro (3)"), nunca "typecheck do financeiro passou". Typecheck modular de verdade = project references = outra fase (se algum dia).

### 5. Execução de testes: global-atribuído no boletim, filtrado no dev

- **Boletim/CI:** rodar o suite global **uma vez** e atribuir resultados por path. Rodar ~15 vitests separados seria mais lento que o global (overhead de bootstrap por run — e o hardware de referência é M2 8GB; runs pesados com prefixo `heavy`).
- **Dev:** subcomando que expande os globs de teste do módulo e chama `vitest run <lista>` — iterar rápido só no módulo afetado. Módulo sem testes mapeados → `sem-testes` explícito.

## Componentes (tudo arquivo novo)

1. **`src/lib/modulos/manifesto.ts`** — manifesto + tipos + `NAO_CLASSIFICADOS`.
2. **`src/lib/modulos/resolver.ts`** — expansão de globs, `donoDoArquivo(path)`, detecção de órfãos/sobreposições (puro, testável; usado por gate e boletim).
3. **`src/lib/modulos/__tests__/`** — gate anti-apodrecimento (completude/exclusividade sobre a árvore REAL de `src/`) + testes unitários do resolver (edge cases: arquivo em 2 globs, glob que não casa nada, path fora de `src/`, entrada de `naoClassificados` que passou a ter dono — deve acusar para limpeza).
4. **`scripts/boletim-modulos.ts`** (bun, invocação direta — sem mudar `package.json`):
   - `boletim` → tabela no terminal + markdown (`--out <arquivo>`); flags para pular etapas caras (`--sem-testes`, `--sem-typecheck`).
   - `test <id-do-modulo>` → roda só os testes do módulo.
5. **`docs/modulos/boletim-inaugural.md`** — 1º boletim commitado como evidência da entrega (depois: sob demanda; snapshots recorrentes commitados virariam ímã de conflito).

## Critérios de aceite (rubrica da sessão aplicada)

1. `bun run test` verde com os testes novos (gate + resolver, incluindo edge cases acima).
2. Ponta a ponta real: boletim inaugural gerado contra a árvore REAL do repo, com números conferíveis (spot-check de ao menos 2 módulos contra contagem manual).
3. Money-path: nenhuma métrica fabricada — `desconhecido`/`sem-testes` onde não há fonte (verificável no boletim inaugural).
4. Vizinhos intactos: suite global + typecheck + lint verdes (nada de código existente é tocado; prova de não-regressão).
5. `shellcheck` n/a (script é .ts); `bunx knip` sem regressão — o manifesto/resolver são importados pelo gate (não viram deadcode).

## Riscos aceitos / mitigação

- **Manifesto aspiracional** (documenta o desejo, não o repo) → o gate roda no CI a cada PR; divergência = vermelho na hora.
- **`plataforma`/`naoClassificados` viram lixão** → boletim expõe os tamanhos como métrica de capa; queima é backlog explícito.
- **Globs de pages/hooks flat imprecisos no bootstrap** → aceitável: o que não casar com segurança nasce em `naoClassificados` (visível), nunca atribuído errado em silêncio.
- **Custo do boletim completo no M2 8GB** → etapas caras são opt-out por flag e o run global de testes/tsc é 1× (mesmo custo do CI atual).
