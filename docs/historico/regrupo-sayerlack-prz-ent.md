# Regrupo Sayerlack pelo Prz Ent do portal (2026-11-18) — v1 sem herança

**Incidente:** #4505 (YC.1400FP em `sayerlack_normal`, portal mostrou Prz Ent 5 ≠ 8). Precedentes do mesmo estado: #1276, #1497, #2388, #2416, #3169, todos normal→rápido e todos encerrados à mão (cancelar + corrigir o grupo).

**Entrega v1:** edge `enviar-pedido-portal-sayerlack` v1.16 + migration `20261120100000_reposicao_regrupo_por_recusa_portal.sql` + prova `db/test-regrupo-por-recusa-portal.sh` (PG17, 2 locales, 14 sabotagens com controle verde na mesma invocação).

**Desenho:** a edge só grava a prova e passa `(pedido, tentativa)`. A RPC relê tudo do banco, sob o mesmo advisory lock do motor, e é all-or-nothing: corrige o grupo, cancela e avisa, ou não escreve nada além de 1 linha `recusado` com o motivo. A edge segue alertando como antes quando a RPC recusa. O encerramento de 3 dias (`reposicao_encerrar_recusas_definitivas`) continua sendo a rede.

**Decisões do founder:** fatiar (v1 sem herança). A herança fica para a v2: os SKUs do original herdam, os movidos vão já aprovados num pedido separado, teto = qtde aprovada (1,0×), SKU extra sai e volta para aprovação, pp/máx recalculado na hora.

**Por que não a herança agora (Codex xhigh, 4 P0):**
1. O teto 1,0× não chega ao clique (o ajuste de lote mínimo sobe a quantidade e efetiva).
2. "Última tentativa" não tem id de claim (watchdog e Forçar reenvio disputam).
3. Corrida com a recompra do motor (#3169 teve 12/13 recomprados).
4. O split recria a raiz da herança (laço).

**pp/máx:** ficam com o aplicador diário. Ele respeita pinado/segurado/validação e não tem modo de 1 SKU. Um pedido regerado no mesmo dia ainda usa a quantidade do LT antigo, e o founder a vê na aprovação.

**Medir (sinal da fase):** `SELECT resultado, motivo, count(*) FROM reposicao_regrupo_audit GROUP BY 1,2;`. Quantos pedidos foram regrupados e reaprovados versus quantos foram recusados, e por quê. É o dado que justifica, ou não, a v2.
