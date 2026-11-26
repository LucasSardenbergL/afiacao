# Auditoria UX + Redesign visual + Premissas — registro histórico

> Movido do CLAUDE.md (§9-intro, §9b, §11) em 2026-06-14. A auditoria UX (2026-05-13) e o redesign visual v3 foram ENTREGUES — isto é o registro. As **convenções vivas** que saíram disso (useUrlState, text-status-*, PageSkeleton, sonner, etc.) ficaram no CLAUDE.md §9 "Padrões e convenções".

## §9 — Auditoria UX (intro + fases)
## 9. Auditoria UX (entregue)

Quatro fases concluídas. Artefatos em `docs/ux-audit/`:

- ✅ **Fase 0** — Setup + este CLAUDE.md
- ✅ **Fase 1** — Inventário de telas em [docs/ux-audit/01-inventario.md](../ux-audit/01-inventario.md)
- ✅ **Fase 2** — Auditoria heurística (Nielsen + critérios de domínio D1-D6) das 10 telas top em [docs/ux-audit/02-heuristica.md](../ux-audit/02-heuristica.md)
- ✅ **Fase 3** — Roadmap ICE com top 20 intervenções em [docs/ux-audit/03-roadmap.md](../ux-audit/03-roadmap.md)
- ✅ **Fase 4** — Execução completa em [docs/ux-audit/04-execucao.md](../ux-audit/04-execucao.md) (20/20 itens entregues; alguns como scaffold pendente decisão de produto/schema)


## §9b — Redesign visual + telemetria
## 9b. Redesign visual + telemetria (entregue após a auditoria UX)

Trabalho posterior à Fase 4, no mesmo branch. Artefatos em `docs/visual-direction/`:

- ✅ **Direção visual** — reposicionamento "fintech/SaaS premium" (Vercel/Mercury/Stripe Dashboard). Tokens v3 em `src/index.css`, Geist + Newsreader, dark mode, sidebar light, paleta low-fatigue. Spec em `01-direcao.md` / `02-tokens.md`
- ✅ **Validação** — contraste WCAG calculado (`03-validacao.md`), audit de cores hardcoded (19 telas migradas + sweep de resíduos de sed)
- ✅ **Identidade** — wordmark Colacor, monogramas por empresa, sidebar enxuta (`04-identidade.md`)
- ✅ **Polish via skill `frontend-design`** — 7 quick wins aplicados, 13 itens documentados em `05-revisao-skill.md` (todos implementados em rodada posterior: serif display, atmosphere em cockpits, status-bold, kpi-delta, favoritos, etc.)
- ✅ **Search global no Cmd-K** — `useGlobalSearch` busca clientes/fórmulas/pedidos no Supabase; recentes em localStorage
- ✅ **Telemetria PostHog** — ver §2. Dashboard "Afiação — Adoção UX" criado (project 423408)
- 🟡 **Scaffolds pendentes de sprint próprio**: TouchPickingView **auto-detect mobile** (a confirmação offline de item já está integrada; falta só o roteamento automático mobile vs `/admin/estoque/picking/mobile`), segmentos de cliente / histórico NF-e em schema (hoje localStorage). Recebimento + picking + **envio de pedido (mesma-sessão, #261)** offline já **integrados** (ver §6 item 1). `submitOrder` offline cross-sessão foi avaliado e **deliberadamente não feito** (ver §6 item 1 — ganho marginal × risco no caminho do dinheiro). Scaffolds órfãos (`useBulkSelection`, `useOptimisticMutation`, `useKeyboardShortcuts`, `tint-cache`) foram deletados em PR #25 — re-criar quando voltarem a ter consumidor real.

> PR #4 foi mergeado em 2026-05-14. Auditoria pós-merge (PRs #24-33) capturou 4 issues bloqueantes que o PR #4 introduziu (SQL injection em useGlobalSearch, exposição de profiles sem gate, 66 classes Tailwind quebradas, PostHog DEV pollution) — todos corrigidos. **Lição operacional**: `bun lint && bun build` precisa virar required check no GitHub. ✅ **Feito** — CI (`.github/workflows/ci.yml`) + branch protection exigindo o check `validate` (ver §10). Disciplina: não bypassar com `--admin` de rotina.

> **Esteira PageSkeleton (#1215, jul/2026) — convenção `<Loader2 spin>` full-page → `<PageSkeleton variant>` COMPLETA.** ~70 páginas migradas + o último gate de página inteira, `ProtectedRoute` (branch `loading`), fechado no **#1232** → boot sem flash duplo (skeleton → conteúdo, coeso). Verificação de deploy por bytes calibrada para refactor visual em componente **eager** (entry bundle): a marca removida (`animate-spin text-primary`) não era única globalmente (13 telas lazy), então a prova de versão ancorou o chunk pela string renderizada única + assinatura de ausência **com controle positivo irmão** no mesmo chunk. A técnica virou nuance no Passo 4 da skill `lovable-deploy-verify` (**#1238**, decidida via ritual `/codex` com cross-model agreement).

---


## §11 — Premissas de auditoria + Glossário
## 11. Premissas de auditoria (confirmadas 2026-05-13)

Sem perguntas pendentes. Tudo confirmado pelo briefing oficial:

- **Empresas**: Colacor (indústria, vende industrializados) · Oben (distribuidora, compra e revende) · Colacor SC (serviços). `Afiação Colacor` no código vai virar `Colacor` em rename futuro.
- **5 personas operacionais** mapeadas via roles existentes + `commercial_roles` + futuro "departamento" (ver §5). Auditoria UX assume persona dominante conhecida por tela.
- **Offline-first em picking e recebimento**: ~~gap crítico (Workbox hoje `NetworkOnly`)~~ → ✅ **ENTREGUE** (NetworkFirst + fila offline + optimistic; ver §6 item 1). *[premissa de 2026-05-13, resolvida.]*
- **<100ms percebido em scan de barcode**: zero código. Propor implementação com optimistic UI.
- **Densidade alta operacional**: `density-compact` global é direção correta; auditar onde ainda é "consumer-grade" (`EmptyState.tsx`, `BottomNav.tsx`, `Header.tsx` legado).
- **WCAG AA mínimo, AAA em críticas**: focus-visible OK; **touch-targets 32px globais ficam abaixo** — propor variante 44px+ para telas mobile operacionais (separador, vendedor externo). Confirmado.
- **Mobile-first em chão, desktop-first em analítico**: AppShell hoje é desktop-first em ambos — auditar telas mobile-críticas.
- **Cmd-k global + atalhos consistentes**: `cmdk` instalado, `Command` shadcn presente, nada montado. Propor.
- **Optimistic UI em mutações operacionais**: princípio do briefing — auditar uso de `onMutate`/`onError` rollback no React Query (hoje esparso).
- **RLS em todas as tabelas**: fora do escopo desta auditoria UX. Se cruzar com tabela sem RLS, registro em "Observações fora do escopo" da fase.
- **Inspirações**: Linear · Notion · Carbon (IBM) · Polaris · Retool. DesignSystem.tsx atual declara HubSpot Canvas + Gong — realinhar.

### Glossário — termos que vão aparecer no roadmap

Pra ficar claro quando os termos entrarem na Fase 3:

- **Cmd-K (command palette)** — overlay de busca/comando que abre com `⌘K` ou `Ctrl+K`. Permite navegar para qualquer tela, executar ação ou buscar registro digitando 2-3 letras. É o padrão de Linear, Notion, Slack, Raycast: substitui menu, busca e atalhos numa única superfície. No nosso caso já temos a base (`cmdk` lib + `Command` shadcn), falta montar no AppShell com registry de comandos por persona.
- **BarcodeDetector API** — API nativa do navegador (Chrome/Edge/Android) que lê códigos de barras e QR direto da câmera, sem biblioteca pesada nem servidor. Latência típica <50ms. Substitui ZXing/Quagga e é o caminho moderno pra picking/recebimento. Tem fallback necessário para Safari/iOS onde a API ainda não está estável.
- **Optimistic UI** — atualizar a tela imediatamente como se a operação tivesse dado certo, e só reverter se o servidor recusar. No React Query: `useMutation({ onMutate, onError })`. Crítico para scan/picking — sem isso o usuário espera 200-800ms a cada bipe.
- **FEFO** (First Expire, First Out) — termo já no domínio: priorizar saída do lote com validade mais próxima. Já implementado em `RecebimentoConferencia` e visível como KPI em `AdminEstoquePicking` (lote_fefo).

Tudo isso vira critério ativo da Fase 2 (heurística D1–D6) e priorização ICE da Fase 3.


## Última execução em ações globais (2026-07-18)

Todo botão de ação global (sincronizar/importar/recalcular) passa a mostrar "Última execução:
há X · quem · status" — pedido do founder a partir do print de `/admin/analytics-sync`.
Infra: tabela `acoes_execucoes` (RLS staff-only, provada em PG17 com falsificação em
`db/test-acoes-execucoes.sh`) + primitivos `useMutationComRegistro`/`<UltimaExecucao>`
(`src/components/execucoes/`, módulo plataforma) + registro server-side na edge
(`_shared/registro-execucao.ts`) para actions com cron — o clique manual e o cron 2/2h do
`compute-costs-daily` aparecem na MESMA caption (descoberta que definiu o design: registrar só
cliques mentiria; o cron dos motores vive só no banco, invisível ao grep do repo). Convenção
nova no CLAUDE.md §Design System (**1 escritor por slug**; ação per-registro fica de fora — o
estado vive no próprio registro). Varredura dos demais botões do app (tintImport SyncCard,
GestorExcecoes, AdminReposicaoPedidos, GerarCicloDialog, PrecoEmbalagemDialog) é o PR2.
Spec: `docs/superpowers/specs/2026-07-18-ultima-execucao-acoes-design.md`.

### PR3 — ciclo de oportunidade com escritor SQL (2026-07-20)

O slug `reposicao.gerar_ciclo_oportunidade` ganhou o escritor DEFINITIVO: a própria função
`ciclo_oportunidade_do_dia` (migration `20260722110000`), classificando origem por `auth.uid()`
(NULL = cron das 11:05 → `automatica`; presente = clique staff → `manual` + nome). INSERT único
no FIM da função — rollback do ciclo leva o registro junto (sem linha órfã "executando").
Prova PG17 6/6 (`db/test-ciclo-registro.sh`): cron/manual/rollback/fail-open/invoker preservado
+ falsificação. O harness pegou um bug real de desenho: `auth.uid()` no DECLARE fura o
EXCEPTION (lição nova em `docs/agent/database.md`). Caption na página de Oportunidades fora do
condicional do botão (mostra o "automática" diário). Fecha o programa "última execução".

### Novo Pedido (`/sales/new`) — auditoria Fable + Codex (2026-11-20)

Duas auditorias independentes (Fable: UX/código; Codex gpt-6.2-astra: engenharia) convergiram:
Cliente (passo 1 do stepper) vinha DEPOIS do card da IA; breadcrumb com voltar duplicado
(`routeCrumbs` `/sales/new` sem `backTo`); sidebar acendia "Pedidos" junto de "Novo pedido"
(`startsWith` → `itemNavAtivo`, prefixo mais longo por segmento — também em `/salesforce`);
stepper do modo cliente deslocado em 1. Bugs reais do Codex: resposta de busca de cliente
ANTIGA sobrescrevia a atual e falha virava "lista vazia" (ausente ≠ zero → estado de erro
+ "Tentar de novo"); "Trocar" limpava carrinho sem confirmação; rascunho restaurava carrinho
precificado de OUTRO cliente já selecionado (agora recusa). Resto: aria-label em botões só-ícone
(IA + carrinho), `EmptyState` no carrinho, "Verificando cadastro…" em vez de "Sem cadastro"
transitório, ⌘↵ na IA, catálogo da IA memoizado. Fora: combobox com setas na busca de cliente,
atalhos globais, rótulos do seletor de pagamento (CartSummaryBar).
Fatia 2 (mesmo dia): busca de cliente vira combobox (↑/↓/Enter/Esc, `aria-activedescendant`; Enter
sem destaque só escolhe resultado ÚNICO; nada escolhe com busca em voo), foco vai à busca de
produto após escolher o cliente (só `pointer:fine`), atalhos `c`/`p`/`a` (escopo página) e nome
acessível no seletor de pagamento. Teste falsificado com 2 sabotagens.
Rodada 2 — PR A, robustez do ENVIO (mesmo dia; B = dados errados, C = celular ficam em PRs próprios):
**A1** a OS de Afiação era RECRIADA no reenvio (o `orderId` nascia novo a cada chamada e o
`omie-sync` monta o `cCodIntOS` com `Date.now()` — o Omie não deduplica; a fp do envelope só cobre
PRODUTO) → marca `{assinatura, numero}` no envelope de checkout, gravada por callback no instante
da confirmação; reenvio do mesmo envelope pula ("já enviada") ou, se as ferramentas mudaram,
`afiacao_divergente` (nunca 2ª OS calada). **A2** o ramo `conflict` do envelope deixava
`submittingRef` ligado → "Enviar" morto até recarregar; **A3** "Salvar orçamento" sem guarda de
re-entrância → as duas saem de `executarComTravaDeEnvio` (try/finally, único ponto que liga a
trava). **A4** orçamento misto com uma conta falhando virava "salvo" e limpava tudo → desfecho
por conta (`contasSalvas`/`contasPendentes`), só as linhas pendentes ficam. **A5** editar o
carrinho com envio em voo era apagado pelo `clearCart` → mutadores via `protegerDuranteEnvio`.
**A6** pendência de ERP abria com título de sucesso e apagava o rascunho → título e
`clearTrigger` por `allConfirmed`. **A7** a `ultima_parcela` do histórico sobrescrevia o prazo
escolhido à mão → marca manual por conta com o token da seleção. Codex (P0 0 · P1 11): a
assinatura da OS ganhou pagamento+entrega, OS sem ferramentas não confirma, vias da IA barradas;
os pré-existentes (confirmação perdida na rede = idempotência na edge; descarte/troca × envelope;
duas abas; prazo Colacor sugerido com o código Oben) ficaram como follow-up no PR. Falsificado:
15 sabotagens, uma camada por vez, controle verde na mesma invocação.

**Ciclo único envelope × rascunho (follow-up Codex do #4042, 2026-11-21, decisão do founder:
mesmo ciclo de vida).** O envelope de checkout e o rascunho viviam separados: (1) "Descartar" o
rascunho após envio parcial preservava o envelope → o pedido idêntico seguinte saía `reuse`
("já enviado") e não era criado; (2) "Trocar e limpar" zerava o envelope mas deixava o rascunho →
restaurar e reenviar criava checkout novo e DUPLICAVA o PV Colacor e a OS; (3) orçamento parcial
dependia do debounce de 600 ms (refresh antes restaurava a conta já salva) e o orçamento total
deixava o último rascunho em disco. Agora: descartar com envelope presente pede confirmação
("Descartar mesmo assim") e zera os dois; "Trocar e limpar" apaga o rascunho; o orçamento chama
`aoGravar` antes do `navigate` (total apaga, parcial grava o resto na hora via `gravarAgora`), e
`clear()` cancela o autosave em voo. Codex (P1 7) acrescentou no mesmo eixo: troca de cliente
com envio/orçamento em voo é barrada; orçamento com envio de PEDIDO pendente é barrado (gravaria
2ª linha da conta já enviada); o rascunho é gravado no commit do envelope e apagado no sucesso
total DENTRO do hook (`cicloRascunhoRef` — vale com a tela desmontada e nos reenvios do ATP).
Ficam como follow-up (pré-existentes): envelope com chave global, não por usuário (descarte de B
apaga o de A); `cCodIntOS` da OS com `Date.now()` (resposta perdida = OS duplicada); deep link/IA
trocando o cliente com o restore aberto. Falsificado: 12 sabotagens, controle verde na mesma
invocação, todas vermelhas pela asserção esperada.
Follow-up do PR A — **prazo Colacor com o código Oben** (2026-11-21): a sugestão de prazo da
seleção chamava `buscar_ultima_parcela` na Colacor com `cust.codigo_cliente` (código OBEN), em
paralelo ao lookup do código Colacor. Os códigos colidem entre contas: o 101 da Oben pode ser outro
comprador na Colacor → o PV Colacor do 202 saía com o prazo do 101. Agora a parcela Colacor espera
o MESMO promise do lookup por documento (slot 3, sem `.catch` — o tri-state do auto-cadastro segue
vendo a falha) e usa `codigoParaParcelaColacor` (`parcela-colacor.ts`): lookup > código Colacor do
cadastro > **nada** (não consulta; prazo fica '999'). Seleção trocada durante o lookup não gasta
ListarPedidos. A7 intacto. Só front. Codex: 3 P2 (seleção velha consultando; teste cego à conta do
lookup e a um `.catch`) → corrigidos. Falsificado: 8 sabotagens nos dois locales.
Rodada 2 — PR B, **dados errados ou perdidos** (2026-11-21, só front · Publish): **B1** `notes` ia no
PV/OS/orçamento mas a barra do carrinho não tinha campo → `Textarea` "Observações do pedido".
**B2** dia de entrega e OC vazavam para o próximo pedido (só `setNotes('')` no sucesso) →
`limparCamposDoPedido` no sucesso TOTAL e no orçamento salvo. **B3** "Dia de entrega" montava
seg–sex da semana corrente (`startOfWeek`: na quinta oferecia dias passados) → `proximosDiasUteis`
(hoje entra se útil; `aria-pressed`). **B4** serviço a orçar virava R$ 0,00 no resumo, WhatsApp e
cupom → `precoServicoParaExibicao` (null/≤0 = "A orçar"), `itensAOrcar` no `lastOrderData` e total
"Subtotal conhecido · Total a definir"; produto sem preço na busca = "Sob consulta". O `unitPrice` do
payload da OS NÃO mudou. **B5** estoque null = "Est: 0" vermelho → selo neutro "Est: —". **B6** o
"Horário preferido" da Afiação se perdia → vai na observação da OS (`orderData.notes` → `cObsOS`,
contrato da edge intacto; balcão não leva). **B7** o rascunho não guardava o prazo escolhido à mão
(ATP bloqueia → refresh → restaura → PV com a `ultima_parcela`) → `parcelasManuais` no rascunho
(só a conta marcada NESTA seleção) reaplicado pelos setters exportados; sem cliente na tela fica
pendente até selecionar o cliente DO rascunho (outro = descarta).

Rodada 2 — PR C, **celular e fechamento** (2026-11-21, só front · Publish): **C1/C2** total + Enviar
ficavam no fim da coluna do carrinho (no celular, depois de TODOS os produtos; no desktop, abaixo
da dobra com carrinho longo) → `BarraEnvioPedido` `sticky bottom-0` como filho DIRETO da página
(o bloco que a contém é a página inteira → presa ao fim da tela nos dois tamanhos) com
`env(safe-area-inset-bottom)`; `sticky` ocupa lugar no fluxo, então o próprio espaço da barra é o
padding compensatório e o último item nunca fica coberto (o `fixed` exigiria `pb-*` casado com a
altura). **C3** `max-h`+`overflow-y-auto` aninhados (carrinho 50vh, lista de produtos 400px, cores
320px) prendiam o dedo → a página rola; cores mostram 8 + "Ver mais". A lista do combobox de
cliente segue com `max-h-64`. **C4** "Novo pedido" no diálogo de sucesso — só com envio CONFIRMADO
em todas as contas (pendência de ERP mantém o reenvio que não duplica); zera cliente, buscas e
rascunho sem recarregar. **C5** Enviar cinza diz POR QUÊ: `motivosEnvioBloqueado` é a ÚNICA fonte
do `disabled` (`envioBloqueado`), com `aria-describedby`; o gate ganhou "carregando cliente",
"carregando condições" e "sem condição" (antes só o `submitOrder` barrava com toast, ou nada).
**C6** catálogo que não carregou virava lista vazia ("não existe") → `estadoDoCatalogo` (erro COM
dado em mãos = ok) + `EmptyState` "Não consegui carregar" com "Tentar de novo" ≠ "Nenhum produto
encontrado". **C7** quantidade aplicava cada tecla (`parseInt('')||1`: apagar virava 1, "12" passava
por 1) → `QuantidadeInput` com buffer, commit SÓ no blur (Enter só tira o foco — dois commits no
mesmo evento duplicariam o delta), vazio/0/inválido volta ao anterior, Esc descarta; lixeira com
44px no toque.
Codex (P0 0 · P1 5 · P2 4), corrigidos no PR: "12,5" colado virava 125 (o buffer filtrava dígitos
antes de validar → texto cru até o blur); focar+sair sem editar desfazia mudança feita por fora
(commit só com edição); "Novo pedido" via `clearCustomer` apagava o envelope/rascunho PERSISTIDOS,
que são por usuário — levava o checkout pendente de OUTRA aba → `iniciarNovoPedido` não toca a
persistência (o sucesso já a zerou) e recusa com envelope vivo; a OS seguinte herdava prazo e
modalidade de entrega → voltam ao padrão; "Enviar pedido agora" da reconexão contornava os motivos
→ mesma entrada da barra. P2: catálogo `pending+paused` (sem rede, sem cache) = "falhou", não
"carregando" eterno; busca só com espaços = "sem resultado"; o reset limpa a busca de cores e tira
`?customer`/`?repeat` da URL. Fica de fora: o HUD de ligação (`z-40`, 320px) pode cobrir a barra
num celular de 360px durante a chamada. Falsificado: 7 sabotagens + controle verde na mesma invocação.

**Painel da ligação × barra de envio + `viewport-fit=cover` (follow-up do #4086, 2026-11-21).** O HUD
da ligação (`fixed` 320px no rodapé, `z-40`) cobria o total e o Enviar num celular de 360px → os dois
ficam visíveis: a `BarraEnvioPedido` publica em `--rodape-fixo` (no `<html>`) quanto do rodapé ocupa
— do TOPO dela ao fim da tela, não só a altura, porque no fim da rolagem ela sobe pelo padding
(Codex P2) — e o HUD e o painel de transferência sobem por essa variável; o HUD cabe em
`min(320px, 100vw − 2rem)`. `viewport-fit=cover` ligado: o PWA já usava `black-translucent`, então
o topo ia para baixo da barra de status sem `env()` para compensar. O token `spacing.topbar` virou
`calc(48px + env(safe-area-inset-top))` (h-/pt-/top-topbar acompanham), os cabeçalhos do shell
ganham `pt` da área segura, a topbar e o conteúdo ganham as laterais (notch no paisagem) e o fundo
(indicador de início), o drawer e os sheets (X abaixo da barra de status — Codex P1) idem. Com a faixa
"Ver como", é ELA que cobre a barra de status e a topbar fica com 48px exatos (a área segura entrava
duas vezes — Codex P2). Ficam de fora (já estavam sob a barra de status antes — `black-translucent`
sem `cover`): cabeçalhos `sticky top-0` de página (conferência de NF-e, `/docs`), o "Mostrar
transcrição" em `top-20`, o overlay do scanner de lote, rodapés de recebimento a 16px da borda e os
`calc(100vh − 48px)` do WhatsApp/Ajuda. Sem teste em aparelho.

**Área segura nas páginas que o #4094 deixou de fora (pendências do Codex, 2026-11-21).** Já
existiam antes do `viewport-fit=cover` (não é regressão), mas ficaram visíveis com ele. Um token
novo, `spacing.topo-conteudo` = `topbar` + `var(--faixa-ver-como, 0px)`, marca onde o conteúdo começa.
O shell publica `--faixa-ver-como: 1.75rem` junto do `pt-7` da lente. Assim, sticky, fixed e alturas
acompanham a faixa "Ver como" sem chamar `useImpersonation()`, que lança erro fora do provider e
quebraria os testes de render das páginas. O padrão ternário de `SalesOrders` continua valendo onde
já existe. Mudanças:
- `sticky top-0` → `top-topo-conteudo` em `RecebimentoConferencia` ("Voltar") e `/docs` ("Exportar PDF",
  z-50 → z-20, abaixo da topbar);
- `ScanBar` e `TranscriptionPanel` saem de `top-topbar` para `top-topo-conteudo`, e o painel ganha `pb`/`pr`
  de área segura;
- "Mostrar transcrição" sai de `top-20` para `top-[calc(theme(spacing.topo-conteudo)+2rem)]` (80px no desktop);
- o overlay do scanner de lote ganha pt/pb/pl/pr de `env()`, e "Finalizar Conferência" ganha
  `pb-[calc(1rem+env(safe-area-inset-bottom))]`;
- o WhatsApp passa a `100dvh − topo-conteudo − (2rem | lg:3rem) − inset do fim`, que é o padding do shell;
- a Ajuda deixa a `--topbar-height` indefinida e passa a `100dvh − topo-conteudo − inset do fim`. O `-m-4`
  segue cancelando só o 1rem, e a área segura fica como calha.

O Codex revisou o diff e trouxe mais pontos do mesmo padrão, também corrigidos:
- sob a lente, o `<main>` desconta a faixa do `min-h` (era `min-h-screen` mais o `pt-7`, o que dava 1.75rem de rolagem);
- os painéis laterais da Reposição saem de `lg:top-4`, que ficava sob a topbar, para `topo-conteudo + 1rem`;
- as seções de `/docs` ganham `scroll-margin` abaixo das duas barras;
- `bulk-actions-bar` e "Criar envio" saem de `bottom-4` para `1rem + inset do fim`.

Ficaram fora de escopo, por virem de antes e não serem de área segura:
- o aviso `ExigenciaDeVersao` em fluxo, que é transitório, empurra a Ajuda e o WhatsApp para baixo;
- o scanner de lote em paisagem, com `45vh` fixo para a câmera, corta o "Confirmar Lote";
- o `min-h-[100dvh]` da `SeparacaoV2`, dentro do shell;
- o `sticky top-20` do nav `xl:` em `DesignSystem`/`UXRules`, que é só desktop e sem inset.

Teste: `src/components/shell/__tests__/safe-area-paginas.test.ts`, um teste-texto falsificado com uma
sabotagem por fiação e controle verde na mesma invocação. O CSS gerado foi conferido à mão. Não houve
teste em aparelho.

**Reversão pelo #4105, restauração e Publish (2026-11-22).** O #4102 mergeou às 02:38. Às 02:57, o
squash do #4105 (`claude/clientes-ondas-1-2-a1e5f3`, branch defasada) desfez os 19 arquivos dele. Nesses
arquivos, `git diff 12936e3a1 f4fdcf60a` era byte a byte o inverso do #4102 (22106 B dos dois lados,
as mesmas 138 linhas). Nenhum outro PR recente foi atropelado. O sinal veio do
`git log -S topo-conteudo -- tailwind.config.ts`, que listou o #4105 além do #4102. O #4107 reaplicou nos
19 arquivos o estado de `12936e3a1` (sem tocar o #4105).

Antes do Publish, `deriva:corpo:prod` acusou AUSENTE a `banco_extrato_omie_dia` do #4104, que o front
da main já chama. A sessão a aplicou por `db:aplicar`: pré-voo `psql-ro` 🟢, ensaio com ROLLBACK, recibo
**#1307**, 2ª testemunha (INVOKER, sem EXECUTE para `anon`, tabela com RLS) e deriva em exit 0. Os bytes
foram conferidos em `steu.lovable.app`, onde `index-5h5jQmAL.css` tem `.top-topo-conteudo`,
`--faixa-ver-como` e as alturas `100dvh` (antes, `index-P-eAPjZ9.css` não tinha nenhum dos três).

Armadilha de medição: o CSS de produção é uma linha só. `grep -c` conta linhas, e o minificador
mexe nos espaços (`var(--faixa-ver-como, 0px)` dentro do token × `var(--faixa-ver-como,0px)` fora dele).
Meça com `grep -oF` e um controle positivo no mesmo comando (`faixa-ver-como-top`). No zsh, `$F` sem
aspas não faz word-split, e um `git diff -- $F` vazio se lê como "idêntico". Use `${=F}`.

**Follow-ups do #4068 e do #4087 (2026-11-21, só front).** **A** desde a edge `omie-vendas-sync`
v1.45 o `omie_products.estoque` chega `null` quando falta `nSaldo`, e o front o transformava em 0: a
venda assistida (`UnifiedOrder` → `montarBaseEmbalagens`) mostrava "Encomenda" para saldo que
ninguém leu. Agora o null segue null até o `resolverOpcaoVenda`, que ganhou `STOCK_UNKNOWN`: o preço
fecharia se o saldo desconhecido existir, então o selo fica neutro ("Est: —", a grafia do
`seloEstoque`) com o MESMO R$/L da encomenda (só o rótulo muda). Saldo INFORMADO ≤ 0 segue
"Encomenda". `Product.estoque` (carrinho e IA) virou `number | null` (o tipo mentia: o banco já
devolvia null), e a edição de pedido parou de fabricar 0. As edges leitoras (`?? 0` no
`analyze-unified-order`) ficam com a sessão das edges. **B1** reconfirmar à mão o prazo já
selecionado não re-renderizava (mesmo valor), então o memo do rascunho seguia sem a marca "manual" →
espelho da marca em state. **B2** código de parcela retirado do Omie entre gravar e restaurar era
reaplicado às cegas (bloqueava o histórico, envio liberado) → `decidirParcelaDoRascunho` confere
contra a lista carregada (degradada = aplica, porque o bloqueio de condição ausente já barra; lista
não carregada = não reaplica e avisa). **B3** preço de serviço negativo somava no subtotal mas a
linha dizia "A orçar" → `subtotalServicosParaExibicao` (só > 0) na tela, no cupom e no resumo
pós-envio; o `subtotal` do payload da OS não mudou. **B4** "hoje" do seletor de entrega congelava no
1º render → `useHojeLocal` (meia-noite + volta da aba) e a data que ficou no passado é desmarcada.
**B5** OS já confirmada + horário trocado caía em "já enviada" seco → a marca do envelope guarda o
`cObsOS` que foi e o resultado avisa que a OS ficou no horário antigo (a assinatura idempotente
segue sem `notes`; OS reconciliada = observação desconhecida, não avisa). Codex (P0 0 · P1 2 · P2 2),
corrigidos no PR: a conferência do B2 usava o `loadingFormas` GLOBAL (a Colacor carregando descartava
o prazo Oben válido) → por conta, e lista ainda chegando reaplica e confere quando chega; o código
PROVADO retirado voltava pela `ultima_parcela` e saía no PV → entra nas condições ausentes enquanto
selecionado (botão e caminho de envio; só com prova positiva, porque a lista é ao vivo do Omie e
nada garante o `999` nela); o aviso do B5 ia dentro de `results`, que vira o "Nº" do cupom e a linha
do WhatsApp → aviso não-bloqueante ("criado com avisos"); o timer da virada acorda com folga → o
envio confere `ready_by_date` pelo relógio de agora. Falsificado: 23 sabotagens, uma camada por vez,
controle verde na mesma invocação, em `C` e `pt_BR.UTF-8`.

### Novo Pedido — Rodada 3, Onda 1: dinheiro e dados (2026-11-22)

**PR 2.1 — parcelas da OS em centavos** (edge `omie-sync` v1.16). A última parcela era calculada em REAIS
inteiros (`total − ⌊total/n⌋·(n−1)`): R$ 100 em 3x ia ao Omie como 33,33 + 33,33 + 34,00 = R$ 100,66.
`ratearTotalEmParcelas` (`omie-sync/parcelas-os.ts`) rateia em centavos com o saldo na última e lança
em entrada inválida. Medido antes em prod (psql-ro sobre `omie_ordens_servico.payload_enviado`): só
7 OS na história (última em 26/02/2026), todas de 1 parcela, **nenhuma com soma errada** — o defeito
estava latente, sem estrago a reparar. Teste de propriedade (≈2.000 totais × n de 1 a 12: soma exata,
centavo exato, saldo em [0, n)). Codex (P0 0 · médio 2 · baixo 2), corrigidos no PR: parcela de R$ 0,00
passava (0,02 em 3x) → recusa `centavos < n` (o Omie exige nValor > 0); meio centavo caía pelo binário
(1,005 → 1,00) → `toFixed(6)` antes do `round`; string numérica no `orderData` virava 500 → `Number()`
na entrada; `nPercentual` (33,33/33,33/33,34) divergia do valor rateado → `parcelasComValor` deriva o
percentual do valor, saldo na última fecha 100,00. Falsificado uma camada por vez, controle verde na
mesma invocação.

**PR 2.2 — PV duplicado entre abas: FECHADO sem merge, adiado para a Onda 3** (#4138, decisão do founder
em 25/11). O P0 era o envelope de envio `{checkoutId, fingerprint, committed}` numa chave FIXA do
localStorage, com o `checkoutId` sorteado no clique: duas abas, ou um refresh que perdesse o envelope,
geravam 2 PVs. A ideia central era derivar o id: `SHA-256(nonce do rascunho, itens)`, com o envelope por
usuário e a reserva feita sob Web Locks. Entre 22 e 25/11 o PR teve 6 versões, e o Codex achou P0 em
todas: 4 → 4 → 6 → 8 → 7 → 6. A última versão separava o id por conta (Oben, Colacor e OS) e criou 6 P0
que deixavam o envio PIOR que a main:
- OS duplicada quando o vendedor muda a quantidade antes de reenviar;
- reenvio do PV Colacor barrado depois do autocadastro;
- 2º PV numa conta já confirmada quando o código do cliente é corrigido;
- id inválido que ainda libera o envio;
- mesma tinta com dois ids entre abas;
- cor com `#` que muda o id da outra conta.

**Lição:** idempotência de dinheiro calculada no navegador, com três contas, várias abas e cadastro que
muda no meio do envio, não fecha. Cada borda corrigida abre outra, porque o navegador não tem uma fonte
única de verdade. A Onda 3 resolve com o rascunho no servidor: "já enviado" é o ESTADO da linha, e o
`nonce` é o id dela. Até lá vale a regra da main. Se a série de P0 por rodada não cai, a saída é mudar de
camada, não fazer a 7ª rodada.

**PR 2.4 — centavos no front: FECHADO sem merge, adiado para a Onda 3** (#4164, decisão do founder em
26/11). Decisão de produto (24/11): o unitário do produto vive ao centavo, inclusive o último praticado
com 4 casas, e o total soma as linhas já arredondadas (`round(q × v, 2)`), como o Omie e o gate de
crédito. O PR teve 5 rodadas do Codex, todas com P0: 1 → 4 → 4 → 4 → 6. Três dos 6 P0 da última rodada
vinham de remendos de rodadas anteriores:
- a guarda "menos de 1 centavo não reprecifica" mantinha um preço vencido;
- a referência da Régua arredondada para baixo reduzia um preço negociado;
- a soma de quantidade normalizada mudava 1,4999999 para 1,5.

Os outros 3 eram superfícies que recalculam a linha com regra própria:
- o admin regravava a OS a R$ 30,22;
- o importador grava o total do PV sem o valor da linha;
- OS antiga em `/sales`.

**Lição:** arredondamento de dinheiro tem UM dono ou nenhum. O total da linha é recalculado em pelo menos
8 lugares, e mudar a regra em parte deles sempre desencontra outro:
- carrinho;
- envio;
- admin;
- importador;
- feed;
- WhatsApp;
- Régua;
- dados já gravados.

A Onda 3 resolve com um único cálculo de linha, consultado pelo front, pelas edges, pelo admin e pelo
importador, mais uma decisão explícita sobre o legado (recalcular ou congelar o que já foi gravado). Até
lá vale a regra da main.

O que serve de base fica na branch `claude/r3-2.4-centavos-front`:
- o helper em decimal exato (`src/lib/centavos.ts`, BigInt sobre `String(x)`, como o `numeric`);
- os testes das 5 rodadas;
- os cenários do Codex (`~/.cache/afiacao-r3-2.4/codex-2.4*.out`).

Mesma regra do 2.2: série de P0 que não cai pede mudar de camada, não uma 6ª rodada.

**PR 2.3 — o que vai ao Omie** (edges `omie-vendas-sync` v1.47 e `omie-sync` v1.17, front 1 campo).
(a) Tinta COM ordem de compra saía SEM a cor no item: `if (ordemCompra) … else if (cor)` — a NF e a
observação do item (a que a produção lê para tingir) perdiam a cor. `infoAdicionalItem`
(`omie-vendas-sync/o-que-vai-ao-omie.ts`) junta as duas: OC inteira em `numero_pedido_compra`,
`"Cor: … | OC: …"` na NF, cor na observação; criação e alteração usam a MESMA regra (a cópia da
alteração esquecia a embalagem em ML). (b) Data prometida: `cabecalho.data_previsao` é, na doc do
Omie, previsão de FATURAMENTO (≥ hoje) e o app a usa como dia do envio (fallback do `order_date_kpi`
e carimbo do sensor `vendas_empurradas_sem_gemeo`) — por isso NÃO mudou. A data prometida
(`sales_orders.ready_by_date`, lida do pedido local) vai em `frete.previsao_entrega` (criação e
alteração) e no `dDtPrevisao` da OP; ausente/ilegível/vencida NÃO vira previsão (ausente ≠ hoje).
Medido: data prometida em 0 de 1.439 pedidos dos últimos 90 dias. (c) A OS gravava
`orders.delivery_option = 'retirada'` fixo, e o roteirizador só lê coleta/entrega — nenhuma OS do
app entrava em rota; o front passa a enviar a modalidade (`modalidade-os.ts`; front antigo segue
'retirada'). `orders` está vazia em prod. Falsificação 16/16 vermelha (8 sabotagens × `C` e
`pt_BR.UTF-8`), controle verde na mesma invocação. Lacuna: a LIGAÇÃO no `index.ts` não tem teste
Deno (a edge inteira não é importável no teste).

**PR 2.5 — reenvio honesto, parte das edges** (edges `omie-vendas-sync` v1.48 e `omie-sync` v1.18;
o front fica para a Onda 3, com o 2.2). Os dois reenvios que reconciliam (PV por duplicata, OS pela
chave) passam a AVISAR o que deste envio não entrou, e o `omie_payload` passa a dizer a verdade.
(A) O PV vinculado só era comparado por SKU e quantidade: a data prometida trocada saía como sucesso.
`compararPrevisaoEntregaPv` (`_shared/atp-pv-omie.ts`) confere `frete.previsao_entrega` (na doc do Omie,
string10 SEM formato documentado; 0 ConsultarPedido real em prod). Só a divergência PROVADA conta —
envio com data legível × PV com outra data legível ou o campo presente e vazio; ausente, ilegível, envio
sem data ou objeto sem `cabecalho` = não conferível, nunca "igual". Ela volta como `aviso_previsao` no
resultado do `criar_pedido` (e log), SEM lançar. O `omie_payload` gravava o payload que o Omie RECUSOU
como duplicata; passa a gravar o PV que o Omie tem (`pedido_venda_produto` da consulta, mesmo objeto da
comparação; `null` sem `cabecalho`), no write-back atômico e no legado. (B) No reenvio que reconcilia a
OS, o upsert `ignoreDuplicates` de `orders` mantinha o endereço/turno da tentativa anterior em silêncio;
`avisoEnderecoTurnoOs` (`omie-sync/reenvio-os-local.ts`) devolve `aviso_local` quando o deste envio
difere (só com a modalidade declarada e igual à gravada), SEM regravar. Endereço/turno seguem FORA da
assinatura da OS. **Por que só avisar** (decisão do founder, 2026-11-25): 2 rodadas do Codex, 3 P0 cada,
todos nas BORDAS da própria correção. Lançar na data pulava a OP da Colacor (o front não cria a OP num
envio com erro, e o clique seguinte cai em "já enviado"); regravar `orders` apagava o endereço quando
o front mandava `null` (bundle antigo ou consulta de endereço que falhou) e dois reenvios concorrentes
se desfaziam mesmo gravando só o campo que mudou. Sem lançar e sem escrever, os 6 somem por construção.
Lacuna: o front ainda não mostra `aviso_previsao`/`aviso_local` (Onda 3); até lá, a trilha é o log e o
`omie_payload`. Falsificação 26/26 vermelha (13 sabotagens, uma por camada e uma por P0/P1 do Codex, × `C`
e `pt_BR.UTF-8`), controle verde na mesma invocação.
