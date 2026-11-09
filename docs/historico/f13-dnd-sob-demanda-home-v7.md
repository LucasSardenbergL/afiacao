# F13: o DND do cockpit sai do boot da home (plano v7, lote 6)

**2026-11-06.** Item F13 do plano v7 (`docs/superpowers/plans/2026-11-05-plano-melhoria-v7/README.md`, §2 F e §4 lote 6). A home staff baixava o `@hello-pangea/dnd` em toda carga, mesmo sem ninguém abrir o "Personalizar". O Codex pediu um experimento com laboratório antes/depois, e que o ganho não fosse emprestado do `vite.config.ts` (o bucket que já tinha tirado o recharts da home). **Veredito: MANTIDO.** No mobile o LCP cai ~0,7 s. No desktop nada muda. O custo fica na 1ª abertura da edição.

## O que mudou

- `CockpitGrid.tsx` não importa mais o DND. Fora da edição, ele monta uma grade estática com o **mesmo DOM visível**: mesma `section#cockpit-grid`, mesmas classes e os mesmos refs dos atalhos 1–6.
- A variante arrastável foi para o `CockpitGridArrastavel.tsx` (lazy, `export default`). Ela tem `DragDropContext`, `Droppable` e `Draggable`, e o `handleDragEnd` é o de antes, sem mudança.
- Na 1ª entrada na edição, o `lazy()` baixa o chunk. Enquanto ele baixa, o `Suspense` mostra a grade estática **já em modo edição** (banner, X de esconder e alças), mas as alças só arrastam depois que o chunk chega.
- Depois de carregada, a variante arrastável **fica** montada mesmo fora da edição (`isDragDisabled`), igual era antes do F13. Assim as zonas não remontam a cada entrada e saída. Elas remontam **uma vez**, na 1ª entrada, e os dados vêm do cache do react-query.
- **Sem prefetch especulativo** (hover no "Personalizar"). Um chunk sumido depois de um deploy dispararia o `vite:preloadError` e o reload global (ver `preload-rota.ts`) sem o usuário ter pedido nada.
- O `KanbanBoard` (Admin) continua importando o DND estático. O `GestaoAdmin` também. Não são home.

## Build (o que a home alcança)

| | antes (`65f1284e8`) | depois |
|---|---|---|
| `StaffDashboard-*.js` | 16,3 KB gzip, `import … from "./dnd.esm-*.js"` **estático** | 16,4 KB gzip, `dnd.esm` só na lista de preload do `import()` dinâmico |
| `dnd.esm-*.js` | 30,4 KB gzip (97 KB cru), no boot de `/` | idem, **fora** do boot de `/` |
| `CockpitGridArrastavel-*.js` | não existe | 0,6 KB gzip |
| `app-lib-nav-home-por-persona` (prefetch da rota) | lista o `dnd.esm` | não lista mais |

## Laboratório

**Método:** o do lote 6 do v6 e do F11 (`boot-chunk-paralelo-auth-lote6.md`, `f11-polls-boot-diagnostico-v6.md`). Build de produção servido estático, com sessão falsa de master. O Supabase é interceptado com 400 ms por requisição, o tráfego externo é bloqueado e cada carga começa com contexto frio. São 15 pares alternados mais 1 aquecimento, e o p é de Mann-Whitney. O servidor do lab **não comprime**, então os bytes são crus. Scripts e logs estão na pasta de notas da sessão-mãe (`lab-f13-dnd/`). Não viraram gate nem sensor.

### Boot de `/` (master)

| perfil | métrica | antes p50 [IQR] | depois p50 [IQR] | Δ pareado p50 [IQR] | p |
|---|---|---|---|---|---|
| mobile (Slow 4G + CPU 4×) | **LCP** (ms) | 9.688 [9.624–9.892] | 8.888 [8.730–9.128] | **−696** [−952 a −552] | <0,001 |
| mobile | FCP (ms) | 7.672 | 7.600 | −44 | 0,95 |
| desktop (10 Mbps, 40 ms) | LCP (ms) | 3.108 [2.500–3.606] | 3.124 [2.432–3.572] | −16 [−182 a +288] | 0,79 |
| ambos | JS baixado | 84 arquivos, 1.564.643 B | 83 arquivos, 1.467.557 B | −1 req, −97.086 B (cru) | — |
| ambos | `dnd.esm` baixado no boot | 15/15 | **0/15** | — | — |

O LCP do mobile é o `<p>` do dashboard. Ele pinta quando chegam o chunk do `StaffDashboard` **e as dependências estáticas dele**. Antes, o `dnd.esm` era uma dessas dependências, e no Slow 4G ele disputava a banda no caminho crítico. O auth (`primeiraAuth`) e o FCP não mudam, o que localiza o ganho no chunk da home. No desktop a banda sobra e não há diferença.

### Fluxo de edição (6 pares por perfil)

| perfil | 1ª entrada → alça arrastável (ms) | maior evento ≥16 ms (proxy de INP) | reordenação por teclado (espaço, →, espaço) | persistiu após reload |
|---|---|---|---|---|
| desktop | 47 → **212** (+144, p=0,003) | 56 → 64 (p=0,26) | 6/6 → 6/6 | 6/6 → 6/6 |
| mobile | 173 → **945** (+776, p=0,003) | 96 → 100 (p=0,94) | 6/6 → 6/6 | 6/6 → 6/6 |

- **O custo foi para a 1ª abertura da edição:** o chunk baixa nessa hora, e no mobile emulado isso leva ~0,8 s com bytes crus. Em produção o chunk vai comprimido (~30 KB), então a espera tende a ser menor. Durante a espera o banner e os X já respondem, e só o arrasto espera.
- **O clique em si não fica mais lento:** o maior evento é igual nos dois lados (proxy de INP).
- **O comportamento do DND é o mesmo:** reordenação por teclado, ordem resultante e persistência no `localStorage` saíram idênticas antes e depois. A 1ª tentativa no mobile usou `ArrowDown`, que não move nada numa lista `direction="horizontal"`. Ela falhou **igual** antes e depois (erro do script, não do código) e foi refeita com `→`.

**Troca aceita:** ~0,7 s a menos no LCP de toda carga mobile da home, contra ~0,1–0,8 s a mais na 1ª vez que alguém abre o "Personalizar", que é raro.

## Testes

`CockpitGrid.dndSobDemanda.test.tsx` cobre dois casos. Fora da edição, o módulo arrastável **não é importado** e a grade não tem atributos `data-rfd-*`. Ao entrar na edição, a alça ganha os props do DND, e ao sair a grade continua arrastável, mas travada, sem reimportar. **Falsificado:** com um `import './CockpitGridArrastavel'` estático no `CockpitGrid`, os 2 testes ficam vermelhos, e o controle (sem sabotagem) passa verde na mesma invocação. O `CockpitGrid.atalhos.test.tsx` continua verde.

## Limites

- O lab mede o mecanismo, não o usuário real: o campo tem 1 usuário (ver §1 do plano).
- Com 400 ms fixos por requisição, o auth domina o boot. O ganho é sobre o chunk que vem **depois** do auth.
- **Deploy:** só front. Mergeado no #3649 (`4fc3888`). **Publish conferido no bundle servido** em 2026-11-06 (`steu.lovable.app`): o `StaffDashboard-Bq1c6pgY.js` não tem mais `import … from "./dnd.esm-*.js"` e aponta para o `CockpitGridArrastavel-C8YkM9hM.js`, e o prefetch da rota (`app-lib-nav-home-por-persona`) não lista o `dnd.esm`. O SW troca de build quando o cliente clica: bytes = disponibilidade, não adoção.
