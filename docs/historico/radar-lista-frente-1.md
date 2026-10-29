# Radar: tela da lista (frente 1 do brainstorm de uso, 2026-10-29)

> Só front, **sem migration e sem RPC**. Deploy = **Publish** no Lovable (founder clica). Contexto:
> `radar-uso-e-recorte-cnae-2026-10-28.md` (o Radar não tem uso; o próximo passo é um piloto com dono).
> Esta frente arruma a tela que o vendedor vai abrir quando a frente 2 der o acesso.

## O que mudou

| Item | Antes | Agora |
| --- | --- | --- |
| Barra em lote | "Criar tarefas" | Saiu (módulo `tarefas` congelado até 2027-01-10). Entrou **Comparar** (2 a 3 selecionados). |
| Modos | "Melhores leads" · "Novas do lote" | **"Maior score"** · **"Abertura mais recente"** (o modo só ordena por `data_abertura`, não filtra o lote). Rótulos em `ROTULO_PRESET`. |
| Região | Brasil inteiro | Abre em **MG e vizinhos** (`regiao=atuacao`); **Brasil** a 1 clique; UF escolhida vence. |
| Sem contato | Entrava | Lead sem telefone **e** sem e-mail fica fora; toggle **"Incluir sem contato"**. |
| Favoritos | — | Filtros nomeados no `localStorage`, por usuário (`radar.favoritos.v1:<user_id>`). |
| CNAE | Só código | Código **ou** nome da atividade (catálogo dos 21 CNAEs-alvo). |
| Placar | 5 cards | 3 cards: **lote vigente**, **a contatar**, **viraram cliente (mês)**. Inéditos e sugeridos viraram **chips de filtro**. |

## Decisões e números

- **Região de atuação = MG + SP, RJ, ES, BA, GO, DF, MS** (`UFS_ATUACAO`). Derivada da carteira
  (psql-ro, 2026-10-29): dos 3.013 leads `ja_cliente` do Radar, **3.003 são de MG (99,7%)**. Os outros
  10 ficam em 8 UFs. Os vizinhos entram porque a rota alcança, não porque haja carteira lá. Leads
  ativos não-cliente na região: MG 59.273 · SP 121.187 · RJ 31.946 · BA 22.897 · GO 21.819 ·
  ES 15.272 · MS 7.832 · DF 6.238. **Se o founder quiser só MG**, a mudança é 1 linha (a constante).
- **"Sem contato"**: na região, ~98% dos leads ativos têm telefone ou e-mail, e há **0 strings vazias**
  nessas colunas (NULL é a única ausência). O filtro é positivo (`telefone1|telefone2|email not null`),
  não negação NULL-blind.
- **Campos novos em `RadarFiltros` são OPCIONAIS** (`regiao?`, `incluirSemContato?`). Ausente = recorte
  antigo (Brasil, com sem-contato). Assim ranking, mapa e os testes da frente 4 seguem compilando e
  com o mesmo comportamento. **Limitação:** o ranking de cidades e o mapa usam a RPC
  `radar_contagem_por_municipio`, que só aceita `p_uf`. Com "MG e vizinhos" e sem UF, eles contam o
  Brasil enquanto a lista mostra a região. A correção é da frente 4 (RPC + `useRadarContagemMunicipios`).
- **Chips fora do gate do placar.** O placar depende de `radar_kpis` (gestor/master). Os chips leem as
  próprias contagens e são o único controle de "só inéditos" e "só sugeridos" (os switches duplicados
  saíram de `RadarFiltros`). Se a frente 2 abrir a tela para vendedor sem abrir `radar_kpis`, o filtro
  continua lá.
- **"A contatar" é do Radar inteiro** (hint no card). O número vem de `radar_kpis` e não respeita os
  filtros da tela.
- **CNAE por nome não vai à URL.** Só a escolha de uma sugestão aplica o código. Sair do campo sem
  escolher volta o texto ao filtro real, para a URL nunca guardar um texto que não filtra nada.
  `CNAES_ALVO` é uma cópia estática de `scripts/radar/cnaes-alvo.txt`, e o teste de `ui-helpers`
  compara as duas listas (código e nome).
- **Favoritos** guardam os filtros da URL, sem a vista. Na leitura, só chaves conhecidas e com o tipo
  do default entram. Storage bloqueado ou JSON quebrado = lista vazia. Falha ao gravar = toast.
  Identidade = `useAuth()` real (preferência de quem está no teclado, não da lente).

## Sensores (`track()`)

`radar.comparar_aberto {total}` · `radar.favorito_salvo {total, substituiu}` ·
`radar.favorito_aplicado {total}` · `radar.favorito_removido {total}` ·
`radar.cnae_escolhido {codigo, por_nome}` · `radar.regiao_trocada {regiao, uf}` ·
`radar.sem_contato_toggle {ativo}`. Os sensores de inéditos e sugeridos continuam os mesmos
(`radar.ineditos_filtro` e `radar.sugeridos_filtro`, origem `card`).

⚠️ O PostHog é bloqueado no Chrome do founder (`analytics.md` §4). Enquanto o único usuário for ele,
a fonte de abertura continua sendo o ledger server-side (`navegacao.rota_servida`). Os sensores acima
passam a contar quando houver vendedor (frente 2).

## Quando medir

Depois do piloto com vendedor (frente 2): `radar.favorito_salvo` e `radar.cnae_escolhido` com
denominador de titulares que abriram `/radar` no ledger. Sem ≥1 favorito salvo por um não-master em
30 dias, os favoritos são candidatos a sair.
