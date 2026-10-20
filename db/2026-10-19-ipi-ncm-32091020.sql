-- Alíquota de IPI do NCM 32091020 (tintas/vernizes base água — F ACAB BA, verniz BA, fundo bloqueador BA)
--
-- POR QUE: a varredura do portal (2026-10-19 17:30) não importou o pedido 2140762 — CP006 "item sem
-- alíquota de IPI conhecida" (NCM 32091020 fora de ipi_aliquota_ncm; ausente ≠ zero, então a RPC recusa
-- tudo). O backtest de 29 pedidos que semeou as 13 alíquotas não tinha nenhum item deste NCM, e não há
-- NF de recebimento com ele no banco (nfe_recebimento_itens: 0 linhas; xml_completo vazio em todas).
--
-- MEDIDA (fonte 'portal'): "Importar do portal" do 2140762 em 2026-10-19 — pedido de 1 item,
-- YLO1.1118.00BA (PRD03552, NCM 3209.10.20 no cadastro Omie), Preço Venda R$ 954,64 (= Vlr Mercadoria da
-- consulta) e Vlr Total R$ 954,64 ⇒ IPI R$ 0,00. Uma alíquota de 0,01% já daria R$ 0,10 — o zero é exato
-- na resolução de centavos. Controle: pela MESMA consulta, os imports de 16/10 trouxeram IPI > 0 (3669:
-- 32129090=6,5%; 3644: 38140090=6,5%), então o portal calcula IPI nesta tela e o zero não é omissão.
--
-- PRÉ-VOO (psql-ro, 2026-10-19): ipi_aliquota_ncm com 13 linhas, nenhuma para 32091020.
--
-- ENVELOPE: idempotente (ON CONFLICT DO NOTHING); pós-condição exige a linha com 0% — se alguém já tiver
-- cadastrado OUTRO valor, aborta em vez de conviver com ele. Aplicação: `bun run db:aplicar <este arquivo>`
-- (sem BEGIN/COMMIT — a transação é do executor). Depois: reimportar o 2140762 ("Importar do portal").
insert into public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em)
values (
  '32091020', 0, 'portal',
  'pedido portal 2140762 (1 item YLO1.1118.00BA): Preço Venda R$ 954,64 = Vlr Total R$ 954,64, IPI R$ 0,00',
  '2026-10-19'
)
on conflict (ncm) do nothing;

do $post$
begin
  if not exists (
    select 1 from public.ipi_aliquota_ncm
     where ncm = '32091020' and aliquota_pct = 0 and fonte = 'portal'
  ) then
    raise exception 'pós-condição: 32091020 não está com 0%% (fonte portal) — havia outro valor cadastrado?';
  end if;
  raise notice 'IPI-NCM-32091020-OK';
end $post$;
