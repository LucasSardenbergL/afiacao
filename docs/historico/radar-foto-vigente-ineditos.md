# Radar bloco 2 — a fila é a FOTO VIGENTE + card "Inéditos do lote"

**PR:** [#3216](https://github.com/LucasSardenbergL/afiacao/pull/3216) · **Antecessores:** #3163 (cadastro em massa), #3169 (carga mensal automática — [diário](radar-carga-mensal-e-recruzamento-diario.md)).

## O problema (medido, psql-ro 2026-10-19)

A carga agora é automática: a cada mês entra um lote novo em `radar_ingest_state` e cada empresa recebe `ultimo_lote` = o mês em que foi vista pela última vez no dump da RFB. Quem **não veio** no dump novo (fechou, mudou de CNAE, saiu do recorte) fica com o `ultimo_lote` antigo — e **continuava na fila**, porque `useRadarLista` só filtrava `ja_cliente=false` e `status<>descartado`.

| `ultimo_lote` | leads ativos (`ja_cliente=false`, status a_contatar/contatado/em_conversa) |
| --- | --- |
| 2026-05 (saíram do dump) | **52.011** (todos `a_contatar`) |
| 2026-08 (vigente) | 498.624 (498.621 a_contatar · 2 contatado_sem_resposta · 1 em_conversa) |

1 em cada 10 leads da fila era foto velha. Inéditos do lote 2026-08 (`primeira_vista_em >= iniciado_em` do lote **e** `ultimo_lote = '2026-08'`): **27.466** (27.460 na fila; `total_recebido` do lote = 501.380). Hoje o número coincide com o `novos` gravado pela carga — por construção; o card passa a CONTAR na tabela, com denominador.

## O que entrou

1. **Um conceito de lote vigente** — `src/lib/radar/lote-vigente.ts` (`loteVigente`: o maior `mes_referencia` com `status='complete'`, running/error ignorados; `ehInedito`; `saiuDoDump`; `rotuloSaiuDoDump`) e **uma query compartilhada** `useRadarLoteVigente` (`['radar','lote-vigente']`). A lista lê o lote **dentro do `queryFn`** via `lerLoteVigente(queryClient)` — mesma chave e cache; se a leitura do lote falha, a lista erra junto (mostrar a fila sem saber o lote = foto velha de novo). Sem lote `complete` → `null` → a fila roda sem o filtro (espelha o `v_lote IS NULL OR` da RPC `radar_kpis`).
2. **Fila default = foto vigente** (`.eq('ultimo_lote', vigente)`); toggle **"Incluir quem saiu do dump"** (`incluirSaiuDoDump`, `useUrlState`, mesmo idioma do `incluirJaClientes`). Quem saiu do dump aparece, quando incluído, com o selo **"saiu do dump em mai/2026"** na linha e na ficha — só o FATO (não veio no dump); o motivo (baixa) é a entrega da situação cadastral.
3. **Card "Inéditos do lote 2026-08: N de T"** no lugar do antigo "Novos no lote" (mesmo conceito; o antigo era o contador congelado da carga, sem denominador e sem clique). N = `count exact, head:true` com o predicado de `ehInedito` (selo e número não divergem); T = `total_recebido`. **1 clique = filtro "só inéditos"** (`soIneditos`, URL) + selo **"inédito"** na linha. Ausente ≠ zero: sem lote `complete` o card diz "sem lote completo"; count que falhou vira aviso de leitura — nunca `0`.
4. **Sensores com denominador** (nascem com a superfície): `radar.ineditos_filtro` `{ativo, origem: 'card'|'filtro', lote, ineditos, total}` (do card, `ineditos` é o N contado — ou `null` se o count ainda não chegou, nunca 0; do switch "Só inéditos do lote" em RadarFiltros vai `null`) e `radar.saiu_do_dump_toggle` `{ativo, lote}`. Lote vigente lido **uma vez** na página (`useRadarLoteVigente`) e passado por prop a filtros, linha e ficha; a lista o lê pelo cache.

## Provas

- `src/lib/radar/__tests__/lote-vigente.test.ts` — lote vigente com running/error no meio e fora de ordem; predicado inédito (antes do início, outro lote, sem lote → false); rótulo sem motivo.
- `src/queries/__tests__/useRadarLista.lote-vigente.test.tsx` — a query default inclui `eq('ultimo_lote', vigente)`; o toggle solta; "só inéditos" vence o toggle; sem lote completo não filtra; lote falhou → lista erra e **não** consulta `radar_empresas`.
- `src/components/radar/__tests__/RadarLinha.selos.test.tsx` — selo "inédito"; "saiu do dump em mai/2026" sem a palavra baixa; empresa comum sem selo; sem lote vigente não fabrica selo.
- `src/components/radar/__tests__/RadarKpis.estados.test.tsx` — card: "N de T" com o predicado e `count:'exact', head:true` na query; sem lote complete → "sem dado" (nunca 0); count falhou → aviso; clique liga/desliga e emite o sensor.

## Fora do escopo / follow-ups

- **Ranking de cidades e mapa (`radar_contagem_por_municipio`) não filtram lote** — a RPC não recebe o lote (migration manual). Até lá, o totalizador por município conta os 52.011 que saíram do dump. Follow-up com migration.
- Situação cadastral / baixa (selo "baixado") — sessão paralela. Score de lead — bloco 3. Aviso ao gestor quando o lote N+1 fechar.
- **Codex:** cota em 97% (teto 85%) ao abrir — janela só reabre em 24/10 19:09. Caminho B registrado no PR; rodar o adversarial de código no diff quando a cota voltar.
