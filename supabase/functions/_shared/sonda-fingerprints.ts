// GERADO por `bun scripts/sonda-fingerprint.ts --write` — NÃO editar à mão.
//
// Fingerprint da FONTE de cada edge instrumentada: SHA-256 sobre o fecho transitivo dos imports
// LOCAIS a partir do `index.ts`, incluindo `_shared/`. É a metade que o gate `sonda:bump` não
// alcança: ele cobre mudança dentro da pasta da edge, e `_shared/` ficou fora dele de propósito
// (~12 bumps à mão por PR). Aqui o fan-out é de graça porque o CI REGENERA.
//
// Servido por `criarRespostaSonda` no campo `fonte` — é isso que torna a identidade função do
// CONTEÚDO, e não da disciplina de quem bumpa. Regravar este arquivo à mão para calar o gate
// derrota o mecanismo inteiro: rode o `--write`.
//
// ⚠️ Fingerprint da FONTE, não hash do BUNDLE — não há `deno.lock` versionado e há range aberto
// (`npm:@supabase/supabase-js@2`), então a mesma fonte pode resolver dependência externa diferente.

export const FONTE_SHA256: Record<string, string> = {
  "ai-ops-agent": "e332594ddd54f4e42cd18281584d726b95afe11df751943d273b737567825f13",
  "algorithm-a-audit": "81cf9e67d3dcb6e95350f7e09d1116965b538b6a7b80cd64fe02b2b2eac5f4ec",
  "analytics-outbox-drain": "b03bbf880f09d2f08d3320def1f7d617506869d063ca0023af65292511c9fded",
  "analyze-unified-order": "51560d34ee92ebddc17ce8bb949c15ec87ad26ec6b848982372d594323f79171",
  "calculate-scores": "9d7a3da6c61501b6eef858ac5e89e9fe81bca71764a181554d387a929fa09f85",
  "carteira-positivacao-snapshot": "be7d1152c411dfac3eec32dedcbb63e146086e2245bfd2462fac6437f89c175d",
  "carteira-rebuild": "8d2589d04aa1188000c918f88967030ea0b26ff54aa7f642c4f50727986eb78a",
  "cmc-snapshot-backfill": "4fba1259c114fb955430b440f65e8344c6e9bc29ca92292d094c3c4b4e601d06",
  "conciliar-pedido-portal": "c5e8f0f688486a6dcedfdc459e675e8827db712668d26c14dd197ad8db49ee6d",
  "disparar-pedidos-aprovados": "1885293ff4d579fa780172689fef32cd079aa68eb02a4d3adcb2d96af83be487",
  "dispatch-notifications": "f29d8d0a57a4ccfe8f6fd76645d6c76ad13c891460b6913f24b43ae43cdca114",
  "enviar-pedido-portal-sayerlack": "125b26969abd98ee037fbd144bdb37e5b596588fce2d22c5091d04b4d0d0f2a7",
  "enviar-push": "38302707026818b24e43f4936dea80f7648c68b2c1351385c7ddd5e396bdd9d5",
  "fin-cashflow-engine": "5327584f8d1bfc36b2f150428575bc459aafd16df4fae37223a20e89425a9a5d",
  "fin-funding": "740615f4f2e2d469bc2e4930dd742e01733ec4b828f16724d3be818a1d4ac32d",
  "fin-valor-cockpit": "045900ec186c02e6c69e910a8b8eb1903fd3a88b03b6410dde6ba5007ede970e",
  "generate-bundle-argument": "4368540ba93070dcb327af584a7ca20294b398aff27adb167928e0fb43256703",
  "generate-tactical-plan": "e222fae4f63084da3981ad48b01742d6a544565e42b8d65248c72950a6396229",
  "gerar-pedidos-diario": "445e8028fe4f6fa01dcdd65774e0a51121905fe1fd1c0596047c34a04aa36411",
  "monthly-report": "29e973d17ecec9a110ae48919fc6f4a62903168cb2011586f4372e092df1da30",
  "nvoip-calls": "5a136e22d19fbb0682c5669554bcd5912ff9ca186ecb1014b327d49946bba36b",
  "omie-analytics-sync": "86e3dd1c7825db52b200b2db44c9f60602cfb0cb0a146eef705e5bf87051815a",
  "omie-aplicar-parametros": "132174780a3175d470853b88833b8e366fcce36cfa2608ec3308bea2cb75518c",
  "omie-cliente": "fade69529ee1b7d62c65c640c98af721bf9df1030c078c93ec5c9dd55eaae92f",
  "omie-financeiro": "3db22ac3488bdf2c043fbbe3bd81c45ca873fdf351a73be49508334aa60eb930",
  "omie-malha-sync": "346aaa13fa16bab1f19085e39e2461e23a5d9ca189ef9afaf25030f163ec44cb",
  "omie-nfe-recebimento": "035279dacb799470cdd32a7143a6e48d5de9ba4dc5d21909d4a7635551cd2681",
  "omie-nfe-recebimento-sync": "a038cd71e17d02bca2e1fd12e83d97ce33aa52aca96bbf58ee239a5a93300143",
  "omie-nfe-reconcile": "844e96d1d018a01374951da346d5d3d267b12431ebab1f7b8f032d117414e3c0",
  "omie-nfe-webhook": "c2267dae835b18c9f4214a6c9621f530a384e150e345cbbcecb7b2eca0e5d319",
  "omie-sync": "94da305dad42c602aea31addd52300c8a232df289f162d62919314068982019c",
  "omie-sync-ctes-recebidos": "8516f13ecd80ccfcdb052fb19f07611d79ae7cc2cbf9e889087530e137b836c7",
  "omie-sync-estoque": "f440fc710577b62ae593256313c369833a3e2a53847d665ab35459db8d71dbd0",
  "omie-sync-metadados": "1f279e5cf99ad368d769d6bd74e295e19d1cfd1ce2ea160dcf14847bf8b8f122",
  "omie-sync-nfes-recebidas": "4ed7bfebece477481cb8b94512bc44d144ae26a4d02df81af7261ce7d6b4a45c",
  "omie-sync-pedidos-compra": "43445982069bbdc6d4136aa24fe6969c675526a111bfb9eb24c659329c0d4feb",
  "omie-sync-sku-items": "b19805d273783fc16ac01d33272b84d775482fe76195b94fa950cbb6bb1da7c3",
  "omie-sync-status-produtos": "9ad6546de095335c66c160af39f6f91e51d006b375501575aa253766aed57a45",
  "omie-sync-vendas-items": "56a22cc97bdb12e9b60e374c18f8c4443e2dbe9159ca36067f1de9cf7adbce22",
  "omie-vendas-sync": "2ade94c2afceb98e562f6bbf4ef979b80e5c50746dba1616e8bd76bf528a2dc8",
  "omie-webhook": "08cdf40788b99bc6096e17ac7166ded10896cbf37339743ecbe46d799805f266",
  "pedido-programado-enviar": "c4e2a9ed647e5fc0096b55ddcce3e20668d0f88363eeda82e1909962d3b178a0",
  "pedido-programado-extrair": "909dc036d026d0fe9f4d1b4202f943d0d4d89fc72e650fced4f57f276c9f225f",
  "process-nfe": "e00a9048f96b00d79b8270460ccc47cef00a3b35ab3218988324df355b35f80f",
  "process-recurring-orders": "b9e8af9ec31123a0f8f80100fb13bbef650cede8bc5632e59eb0b6fa088e051a",
  "recommend": "b48e49f794fd1752a4f7d8f891ba8716a47aed8b6722978a4cdff01ce039baa8",
  "reposicao-depara-sayerlack-auto": "2ed8e16bf731ee216b3c378e62a0bd2123ce06c1f25123fe60b3edacbc767298",
  "sayerlack-captura-precos": "067de5a255cf9b09e7d73995f2f6986d14cf1869dbfaf7242317866b3a263e1c",
  "scoring-recalc-batch": "3899eef2be43073b93b47445f4b36f29860c29f00b6d244cd2cffd0092bce4c6",
  "sync-reprocess": "9b405591b5fab8c42800e2dc228d5d9cddddbece378e22820f7b380187643c77",
  "tactical-plans-batch": "6d882834d7cef695d9879e1498b1b4e8cc9073bc50906279982a8cc015d6a8be",
  "visit-score-recalc-batch": "fc6e87d83a3d700cf802731a40ac10098be412a11e6e95e7826efb1364114a95",
  "whatsapp-send": "dea0911c8768412918d9730b76b0f8231ef74042715a587c003dd80f00917ecf",
  "whatsapp-send-template": "c05231ef490b58717b03f8e85de333d10ed4a5d0d113ed592ad78d9ab234ed12",
};
