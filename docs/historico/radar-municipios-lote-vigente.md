# Radar — ranking de cidades e mapa contam a FOTO VIGENTE (2026-10-20)

**Continuação do bloco 2** ([radar-foto-vigente-ineditos.md](radar-foto-vigente-ineditos.md), PR #3216).
Aquele PR fez a FILA do `/radar` filtrar `ultimo_lote = lote vigente`. O ranking de cidades
(`RadarRankingCidades`) e o mapa (`RadarMapa`), porém, leem a RPC `radar_contagem_por_municipio`,
que não recebia lote. Resultado: o totalizador por município continuava contando os 52.011 leads
que saíram do dump, e a tela mostrava dois universos diferentes.

## A medida (psql-ro, prod, 2026-10-20)

Lote vigente `2026-08`, com 498.624 leads ativos. Outros 52.011 têm `ultimo_lote = 2026-05`.
Top 10 do ranking (ja_cliente=false, sem descartados):

| # | Cidade | Contando tudo | Só o vigente | Saíram | % saiu | Posição no vigente |
|---|---|---:|---:|---:|---:|---:|
| 1 | São Paulo/SP | 26.794 | 24.910 | 1.884 | 7,0 | 1 |
| 2 | Rio de Janeiro/RJ | 11.347 | 9.738 | 1.609 | 14,2 | 2 |
| 3 | Belo Horizonte/MG | 7.323 | 6.587 | 736 | 10,1 | 3 |
| 4 | Brasília/DF | 7.076 | 6.057 | 1.019 | 14,4 | **5** |
| 5 | Curitiba/PR | 6.937 | 6.232 | 705 | 10,2 | **4** |
| 6 | Salvador/BA | 5.475 | 4.770 | 705 | 12,9 | 6 |
| 7 | Goiânia/GO | 5.262 | 4.705 | 557 | 10,6 | 7 |
| 8 | Fortaleza/CE | 4.233 | 3.703 | 530 | 12,5 | 8 |
| 9 | Guarulhos/SP | 3.571 | 3.185 | 386 | 10,8 | **10** |
| 10 | Campinas/SP | 3.516 | 3.237 | 279 | 7,9 | **9** |

- A composição do top 10 não muda (nenhuma cidade entra ou sai). A ordem muda em 2 pares:
  Brasília e Curitiba trocam, e Guarulhos e Campinas também.
- Os números são superestimados em 7–14% por cidade. O "ruído" da foto velha não é uniforme:
  RJ e DF têm o dobro da taxa de SP.
- 5.467 municípios aparecem quando se conta tudo; só 5.446, quando se conta o vigente. **21 municípios
  só existiam no ranking/mapa por causa de quem saiu do dump.** Um pino desses no mapa, ao ser clicado,
  levava a uma fila vazia.

## O que mudou

- **RPC:** `radar_contagem_por_municipio` ganhou `p_lote text` e `p_primeira_vista_min timestamptz`,
  os dois com default NULL. NULL produz exatamente o resultado anterior (provado contra o corpo vivo
  de prod). Por isso o roteirizador (`useRadarCidadesRota`, que não passa lote) não muda. Lote mal
  formado agora dá `RAISE 'lote inválido'`: um typo contaria zero em silêncio, e ausente ≠ zero.
- **Predicado único:** `recorteDeLote(lote, {incluirSaiuDoDump, soIneditos})` em `src/lib/radar/lote-vigente.ts`.
  A fila (`useRadarLista`) e o ranking/mapa (`useRadarContagemMunicipios`) aplicam o mesmo recorte
  sobre o mesmo `lerLoteVigente(queryClient)`, com a mesma chave e o mesmo cache. Assim, "só inéditos"
  também recorta o ranking, como já recortava a fila. Se a leitura do lote falha, o ranking falha
  junto e a RPC nem é chamada.

## Decisões e armadilhas

- **Novo parâmetro = nova assinatura ⇒ DROP + CREATE, não REPLACE.** O briefing pedia "REPLACE para
  preservar ACL". Com lista de argumentos diferente, porém, `CREATE OR REPLACE` cria um **2º overload**
  em vez de substituir a função. O PostgREST recusa chamada que casa com dois overloads (PGRST203), o
  que quebraria ranking, mapa e roteirizador. Por isso a migration faz DROP da assinatura de 8 args e
  CREATE da de 10 na mesma transação, reemitindo `REVOKE … FROM PUBLIC, anon` / `GRANT … TO
  authenticated, service_role`, nomeando as roles (o DROP reseta o ACL). DDL destrutivo ⇒ **é o founder
  quem aplica**, no SQL Editor (`database.md` §1).
- **Molde TRAVA → PRE → DROP/CREATE → ACL → PÓS.** A PRE exige o md5 do corpo vivo de prod
  (`1f1e2494…`, lido em 2026-10-20) na assinatura velha, ou o md5 deste arquivo (`321d07f0…`) na nova.
  Pré-voo contra a prod via psql-ro: a PRE passa, e a PÓS falha só em "assinatura velha ainda existe",
  que é exatamente o predicado que a migration muda.
- **Custo:** o caminho rápido sem lote usava index-only scan no covering `idx_radar_muni_cover`, que
  não carrega `ultimo_lote`. Com `p_lote` (agora o default do `/radar`), o plano vira seq scan. Medido
  em prod (quente): ~0,35 s → ~0,6 s. Ficou aceitável e sem índice novo. Se doer, a saída é um covering
  parcial com `ultimo_lote` no INCLUDE (`CREATE INDEX CONCURRENTLY`, fora de transação).
- **Gate de LIKE cru:** a permissão de `like p_cnae_prefix || '%'` (prefixo validado por `^[0-9]{1,7}$`)
  migrou para a identidade de 10 args em `VIVOS_PERMITIDOS`.

## Provas

- `db/test-radar-contagem-lote.sh` (PG17, no núcleo do CI): 16 asserts, partindo do corpo vivo de prod
  (`db/fixtures/radar-contagem-por-municipio-predecessora-prod-20261020.sql`). Cobre paridade sem lote,
  foto vigente e só inéditos nos dois caminhos, `lote inválido` com SQLSTATE casada, assinatura única,
  ACL e PRE abortando diante de corpo divergente. `--falsificar` mostra controle verde e 12/12
  sabotagens vermelhas, cada uma no assert dela.
- `src/queries/__tests__/useRadarContagemMunicipios.lote-vigente.test.tsx`: `p_lote` = vigente por
  default; null com "incluir quem saiu"; vigente + `p_primeira_vista_min` em "só inéditos"; null sem
  lote completo; erro do lote propaga sem chamar a RPC. Falsificado: com `p_lote: null` fixo no hook,
  2 testes vermelhos.

## Aplicação (2026-10-20, pelo Claude, a pedido explícito do founder)

O founder pediu que a sessão aplicasse a migration ("APLIQUE VOCE A MIGRATION"). DDL destrutivo fica
fora do envelope por padrão, e a autorização dele na conversa é o que cobre este apply. Canal: o
`query_database` do conector Lovable, que roda como `postgres`, o mesmo dono da função, conferido antes
porque `SECURITY DEFINER` roda com os privilégios do dono.

1. **Ensaio:** a mesma SQL, terminando em `RAISE 'ENSAIO_OK'` no lugar do `COMMIT`. PRE, DROP, CREATE,
   ACL e PÓS passaram; dono `postgres`; ACL idêntico ao anterior (inclusive `sandbox_exec_*`, que vem
   dos default privileges). Rollback conferido via psql-ro: a assinatura velha seguia intacta.
2. **Apply** com `COMMIT`. O retorno `{"rows":[]}` não prova nada.
3. **2ª testemunha (psql-ro):** a query de validação dá `✅`. Há uma assinatura só, a de 10 args, com dono
   `postgres` e o mesmo ACL. Os event triggers `pgrst_ddl_watch`/`pgrst_drop_watch` estão ativos, então
   o PostgREST recarrega o schema sozinho.
4. **Sonda funcional como gestor** (claims de um master, reportando por exception, sem rastro):
   São Paulo 26.794 sem lote × 24.910 com `p_lote='2026-08'` (Rio 11.347 × 9.738; BH 7.323 × 6.587),
   iguais à medição. "Só inéditos" em SC: Joinville 228, Blumenau 111.

A migration é retrocompatível: o front publicado hoje (sem `p_lote`) segue funcionando igual. O front
novo entra no Publish seguinte ao merge.
