# Redesign "Visitas em campo" — 7 pontos de uso real — Design

**Data:** 2026-06-14 · **Status:** design APROVADO pelo founder (brainstorming + 2ª opinião do Codex nas cores do mapa)
**Decisores:** founder (produto/escopo) · Claude (arquitetura) · Codex/gpt-5.5 (esquema de cores)
**Tela:** `/admin/route-planner`, contexto **campo** (modo `prospeccao`) — gate `isStaff` + `pode_ver_carteira_completa`.

> Continuação do Roteirizador do Hunter (specs `2026-06-13-roteirizador-prospects-radar-design.md` e `2026-06-14-roteirizador-visitas-campo-design.md`, já entregues). Aqui o founder usou de verdade e trouxe **7 atritos**; escolheu **redesenhar os 7 juntos** num desenho coeso, implementado em **sub-PRs**.

---

## 1. Os 7 pontos (feedback de uso + diagnóstico no código)

| # | Sintoma relatado | Causa-raiz |
| --- | --- | --- |
| **A** | "Está aparecendo tudo como prospects, **zero clientes**" | `loadCarteiraDaCidade` (`useRoutePlanner.ts:820`) usa `addresses.ilike('city', city.nome)` — case-insensitive mas **sensível a acento**. O nome RFB do município (ex.: `DIVINÓPOLIS`) não casa com o `addresses.city` de texto livre quando há diferença de acento/grafia. O próprio comentário admite "imprecisão aceita na v1". |
| **B** | "Clico no nome da pessoa e **não consigo ver os dados**" | `FieldTargetCard`/`RouteStopCard` só mostram nome + endereço + telefone + "Adicionar". Não há tela de detalhe — apesar de a RPC já devolver CNPJ, razão social, nome fantasia, 2 telefones e status. |
| **C** | "Divinópolis tem **600+** prospects e aparecem **50**" | `loadProspectStops` pede `p_limit: 50`. A RPC `radar_prospects_para_rota` capa em 200 (`LEAST(p_limit,200)`). Sem virtualização nem filtros. |
| **D** | "Às vezes queria **um seletor de estado** antes — demora abrir todas as cidades" | Não há filtro por UF; o seletor lista todas as cidades do Radar de uma vez. |
| **E** | "Queria **cor no mapa por recência**: visitou há pouco / faz tempo / nunca" | Pino colorido por **tipo** (`STOP_CONFIG[stopType].markerColor`: carteira laranja, prospect amarelo), não por recência/urgência. |
| **F** | "Queria **remover quem não quero** e marcar quem quero — montar a minha lista" | Não há curadoria: a lista é o despejo cru da RPC. |
| **G** | "Mostra os 50 no mapa, mas fica **girando embaixo do mapa, geocodificando** os endereços" | Geocoding Nominatim sob-demanda (~1,1 s/req, `.slice(0,15)` por ciclo) com spinner visível e lento. |

## 2. Decisões fechadas (founder + Codex)

| Tema | Decisão |
| --- | --- |
| **Curadoria (F)** | "Remover" é **só da sessão** — Set em memória, sem gravar no banco, com desfazer. |
| **Geocoding (G)** | Mantém **endereço exato**; elimina o spinner. Cacheados aparecem na hora; os demais geocodificam em **segundo plano** com indicador discreto. |
| **Volume (C)** | Mostrar **todos**, com **teto pragmático de ~1.000** por cidade (ordenados por prioridade) + aviso "1.000 de N" + filtros. Divinópolis (600) cabe inteira; metrópole mostra os 1.000 mais quentes. |
| **Cores (E)** | **Cor = prioridade da próxima ação** (não recência literal); **forma = tipo** (círculo = carteira, losango = prospect). Vermelho = "vá agora". |
| **Nunca visitado** | Cliente da carteira sem visita registrada = **cinza** ("sem dado"), não vermelho — o histórico `route_visits` é novo; ausência de dado ≠ urgência (evita afogar o mapa em vermelho). |

## 3. Modelo da tela (o "para quê")

A tela deixa de **despejar 50 prospects** e vira uma **bancada de caça por região**: o hunter escolhe `UF → cidade(s)`, vê **carteira + prospects juntos** (todos, com teto), **filtra e cura** a lista de trabalho, e o mapa funciona como **mapa de calor de onde agir** (cor = urgência). A rota se monta com o que ele marcar.

## 4. Esquema de cores do mapa (E) — travado

Cor codifica **uma** dimensão (urgência de agir); forma codifica o **tipo**.

| Pino | Forma | Cor (token) |
| --- | --- | --- |
| Carteira visitada há ≤30 dias | círculo | `success` (verde) |
| Carteira visitada há 31–90 dias | círculo | `warning` (âmbar) |
| Carteira visitada há >90 dias | círculo | `error` (vermelho) |
| Carteira **nunca** visitada | círculo | `neutral` (cinza) |
| Prospect `a_contatar` | losango | `info` (azul) |
| Prospect `contatado_sem_resposta` | losango | `warning` (âmbar) |
| Prospect `em_conversa` | losango | `error` (vermelho) |
| Dado desconhecido/inválido | — | `neutral` (cinza) |

- **Daltonismo:** não depender só da matiz — forma distingue tipo; borda/ênfase reforça o nível (ex.: vermelho com borda dupla, âmbar borda sólida, azul com ponto central, verde vazado).
- **Clusters** (600+ pinos): **não** usar cor média/majoritária. O cluster mostra **total no centro**, **borda na maior urgência presente** e **badge `!N`** (quantos vermelhos) — assim 1 urgente entre 80 cobertos não vira "tudo vermelho".
- **Armadilha aceita (do Codex):** recência fixa (30/90) não é prioridade universal — é a primeira política; refino por segmento/SLA fica fora do v1.

## 5. Solução por ponto (detalhe técnico)

### A — Carteira normalizada (RPC server-side)
Nova RPC `carteira_por_municipio(p_municipio_codigo text)` `SECURITY DEFINER`, gate `pode_ver_carteira_completa((SELECT auth.uid()))` no topo (1×). Resolve `(nome, uf)` do município em `radar_municipios` pelo código e casa `addresses` por **`norm(city) = norm(nome) AND upper(state) = uf`**, onde `norm()` = `lower(unaccent(trim(...)))` (extensão `unaccent` se disponível; senão wrapper imutável via `translate()` com o mapa de acentos PT). Faz `JOIN profiles` (filtra `is_employee` verdadeiro) e **já traz a recência** (ver E). Substitui o `ilike` do `loadCarteiraDaCidade`. `addresses` é pequena (clientes, não os 526k do Radar) → seq scan filtrado é aceitável; sem índice novo no v1.

### B — Sheet de detalhe do alvo
Componente `FieldTargetDetailSheet` (shadcn `Sheet`), abre ao clicar no card **ou** no pino. Para **prospect**: nome fantasia + razão social, CNPJ formatado, badge de status, endereço completo, **telefone1 e telefone2** (botões ligar via `useCallBackend`/WebRTC + WhatsApp `wa.me`), e ações (adicionar/remover da rota, remover da sessão). Para **carteira**: nome, telefone, endereço, **última visita / dias** e atalho ligar/WhatsApp. Requer preservar a linha crua: um `Map<stopId, ProspectRow>` (e equivalente da carteira) no hook — hoje `prospectRowToStopDraft` colapsa razão/fantasia/tel2/cep.

### C — Todos os prospects + filtros + virtualização
- **RPC:** subir o teto de `200` → `2000` (teto duro no SQL); o client pede `p_limit: 1000` (default). Ordenação estável já existe (`a_contatar` → mais novos → cnpj).
- **Lista virtualizada:** `@tanstack/react-virtual` no painel de alvos (aguenta milhares de linhas sem travar).
- **Filtros** (helper puro `filtrarAlvos`): tem telefone · status (multi) · bairro (derivado dos dados). Reduzem lista **e** mapa.
- **Aviso "1.000 de N":** o total real vem de `radar_contagem_por_municipio` (já cacheado no seletor); se a lista bate o teto, mostra "mostrando 1.000 de N — refine por bairro/filtro".

### D — Seletor de Estado (UF)
`UfSelector` deriva as UFs distintas da lista de cidades **já cacheada** (`useRadarCidadesRota`, campo `uf`) — sem ida ao banco. Selecionar UF filtra o `CityMultiSelector`. Persiste a última UF em `localStorage`.

### E — Cores/formas (função pura + recência)
- `markerVisual(stop): { tone, shape }` **puro/testável**: `shape` por `stopType` (prospect→diamond, carteira→circle); `tone` pela tabela da seção 4 (recência da carteira / status do prospect).
- **Recência da carteira:** a RPC de A faz `LEFT JOIN LATERAL` em `route_visits` trazendo `max(check_in_at)` por `customer_user_id` → `dias_desde_visita`. Política: última visita de **qualquer** vendedor (cobertura real do cliente), não só a do logado.
- **Render:** o `divIcon` do Leaflet passa a usar `tone→hex` (mapa coerente com os tokens `--status-*` do `index.css`) + CSS de forma (border-radius círculo / `rotate(45deg)` losango). Pino **na rota** mantém a cor de urgência + badge numerado (corrige o override que pintava tudo de azul).
- **Legenda:** `MapLegend` colapsável com a tabela.

### F — Curar (só sessão)
`removidos: Set<string>` (estado da página). `filtrarAlvos` exclui os removidos; "remover" no card/sheet dispara toast "removido · desfazer". "Marcar pra rota" é a seleção que já existe (`stopsParaRota`/marcados). Nada toca o banco.

### G — Geocoding progressivo (sem spinner)
- **Fila contínua** (substitui o `.slice(0,15)`): worker processa ~1/s, **priorizando** (1) marcados na rota, (2) resto por ordem de prioridade da lista. Cada resultado persiste via `radar_salvar_geocode` (cache cresce; 2ª visita à cidade já vem pronta). *(Priorizar pela viewport do mapa = v1.1.)*
- **Cacheados na hora**; sem-coord ficam na **lista** com "📍 localizando" e entram no mapa ao resolver.
- **Indicador discreto:** chip "localizando N…" no canto do mapa — não o spinner grande embaixo.
- **Carteira:** geocodifica in-memory (poucos clientes/cidade); persistência de geo da carteira fica fora do v1 (YAGNI — `addresses` não tem colunas de geo).

## 6. Módulos (isolados e testáveis)

**Helpers puros (TDD):** `markerVisual`, `recenciaFaixa(dias|null)`, `clusterStats(stops)` (contagens por tone p/ o ícone do cluster), `filtrarAlvos(alvos, filtros)`, `bairrosDe(alvos)`, `ufsDe(cidades)`. Todos em `src/lib/route/`.
**Componentes novos:** `UfSelector`, `FieldTargetDetailSheet`, `MapLegend`, `AlvosFiltros`, lista virtualizada de alvos.
**Banco (migration manual):** RPC `carteira_por_municipio`; `radar_prospects_para_rota` com teto 2000.
**Dependências novas (leves):** `leaflet.markercluster` (+types/CSS) e `@tanstack/react-virtual`.

## 7. Faseamento (4 sub-PRs, cada um verde e mergeável)

1. **Banco** — RPC `carteira_por_municipio` (A + recência p/ E) + teto da RPC de prospects (C). Validação PG17 + apply manual no SQL Editor.
2. **Achar/filtrar** — `UfSelector` (D) + filtros + lista virtualizada + "1.000 de N" (C).
3. **Detalhe + curar** — `FieldTargetDetailSheet` (B) + remover-sessão (F).
4. **Mapa** — `markerVisual` cores/formas + `MapLegend` (E) + clusters `leaflet.markercluster` + geocoding progressivo (G).

## 8. Invariantes e armadilhas (não-negociáveis)

- `useFarmerScoring` **intocado** (money-path). O `priority.ts` local pode ser ajustado, mas não é o foco.
- **OpenStreetMap/Nominatim** mantidos; **Google Maps pago fora**.
- Curadoria é **local/sessão** → sem risco de vazar entre contas; cache de cidades segue isolado por `user.id`.
- **Banco só via Lovable SQL Editor** (founder aplica manual); RPCs `SECURITY DEFINER` com gate avaliado **1× no topo** (não por-linha — lição #792). `REVOKE … FROM PUBLIC, anon` + `GRANT … TO authenticated`.
- **PostgREST** capa em 1.000 linhas silencioso → o teto de 1.000 é também o limite seguro de uma página; acima disso exige `.range()`.
- `CREATE OR REPLACE` da RPC de prospects: comparar a definição **viva de prod** antes (apply manual diverge do repo); preservar ordem das colunas.
- Geocoding em massa proibido pelo Nominatim → **nunca** geocodificar os 526k; só sob-demanda por cidade, persistido.

## 9. Testes

- **Puros (vitest):** `markerVisual` (todas as faixas/tipos, incl. nunca=cinza e dado inválido=cinza), `recenciaFaixa` (limites 30/90, null), `clusterStats`, `filtrarAlvos` (telefone/status/bairro combinados), `ufsDe`/`bairrosDe`.
- **SQL (PG17 local `db/test-*.sh`):** `carteira_por_municipio` — casa com acento divergente (`DIVINÓPOLIS` vs `Divinopolis`), homônimo em UF diferente NÃO casa, recência correta, gate nega não-gestor (`SET ROLE authenticated` + GUC). Prova por falsificação (sabotar e exigir vermelho).
- **Manual no device:** mapa com cores/formas/clusters; geocoding sem spinner; sheet abre pelo card e pelo pino.

## 10. Fora de escopo (YAGNI)

Descartar prospect no banco (curadoria persistente) · geocoding por viewport · persistir geo da carteira em `addresses` · refino de prioridade por segmento/SLA · auto-detect mobile. Cada um vira follow-up se houver demanda real.
