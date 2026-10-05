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
  "algorithm-a-audit": "9c830a537358902edc01e1c279ffaa7f52ece0cac4872ce2cdbcc6a68b105441",
  "analytics-outbox-drain": "b03bbf880f09d2f08d3320def1f7d617506869d063ca0023af65292511c9fded",
  "analyze-services": "fc9fe8712c43bb7f814c3d280c4709ffe7c10be6015bf1d80fafcbbd6d2fda4f",
  "analyze-unified-order": "0989262a17cd078c02782a7968964480a8da4e85a88c6d46ad2c7ac619cd9fd8",
  "calculate-scores": "9d5e83b0793bfc7768e66becba5f2c5cb47c53522f1a500b3653a8bbd9a9a3fe",
  "carteira-positivacao-snapshot": "a71428f575ae38283bca5eacb9cb031ec02892c54bb51d7c457efb39c5316a30",
  "carteira-rebuild": "8d2589d04aa1188000c918f88967030ea0b26ff54aa7f642c4f50727986eb78a",
  "cmc-snapshot-backfill": "4fba1259c114fb955430b440f65e8344c6e9bc29ca92292d094c3c4b4e601d06",
  "conciliar-pedido-portal": "c5e8f0f688486a6dcedfdc459e675e8827db712668d26c14dd197ad8db49ee6d",
  "copilot-analyze": "b3bd44e6e7e434e62ea1bb5077473af8f94fe1d84a8c4959a969e651c905317b",
  "disparar-pedidos-aprovados": "f3c232c77a8a5573b6e54f02b9e69b7b8a0815d47f876bdeccf90e28645244ec",
  "dispatch-notifications": "b46aa29eabbd5164d1270768ebd65b31a09bdf1da9359c3f4f2c92b5ef6a8f89",
  "elevenlabs-transcribe": "6e8f1f351e78f3ab0be470147340f86ce8a3e51d644b5b757f1dd235d9e6a8e2",
  "enviar-pedido-portal-sayerlack": "348c7eca7894b7d49386605f9b5aef4d5c567288cf5d5d829101427a9e2ff1d9",
  "enviar-push": "38302707026818b24e43f4936dea80f7648c68b2c1351385c7ddd5e396bdd9d5",
  "fin-cashflow-engine": "b2ae04967ccc6546bf392700e9d8734c32b82854a523bebfefcf7147de7bbc02",
  "fin-funding": "dc32832bf1785c1cc91a8bbd2daf3a0c025b9627c816faab5a3e3039046180ce",
  "fin-valor-cockpit": "1ed02206fb6b033ec92d351a8595dc0b92ac39f9e99e485d5491047f8d58aa29",
  "generate-bundle-argument": "4d1b5d967a8a4b09837853e16e89aa29e744118348bbc5790c1a404f1e966586",
  "generate-tactical-plan": "69ebb00cbc46ffb99302c5332f0cd6ec8597593318b90eecb6db0251c2568b42",
  "gerar-pedidos-diario": "ed7524d4ffe9de36e6b79c9a9b3832aba427e62d15dcc38076b191ded1f43e0c",
  "identify-tool": "6b4917dfc938e0e34dc7228b290feddbde1548f7385feadc64896571f5391fd1",
  "monthly-report": "578a6e8963a0f1fd0fee9bc8fbd971892b9cdae5128894e40e74d9989cc4d7ab",
  "nvoip-calls": "5a136e22d19fbb0682c5669554bcd5912ff9ca186ecb1014b327d49946bba36b",
  "omie-analytics-sync": "437443269bd79913850e5e3d446455366ab9236879e559b095e35e1c84a48687",
  "omie-aplicar-parametros": "132174780a3175d470853b88833b8e366fcce36cfa2608ec3308bea2cb75518c",
  "omie-cliente": "fade69529ee1b7d62c65c640c98af721bf9df1030c078c93ec5c9dd55eaae92f",
  "omie-cron-diario": "0bc7f2b02ce1be0d11b791a665bf5ba44494e90488205474ad38a49fa14fa4f3",
  "omie-desconto-backfill": "3a9a5716aeb427b9ae36919bcfa95a736f5d046d344d6350cbc4ced95ca711f5",
  "omie-financeiro": "e764fad7965c36a822eb59ba9d60ab64f71aa6886a09b828e87804d1730ceb9d",
  "omie-malha-sync": "346aaa13fa16bab1f19085e39e2461e23a5d9ca189ef9afaf25030f163ec44cb",
  "omie-nfe-recebimento": "e69f5f4fe0c581043237e33d55bef413b245f7e264ae88138f5439a1f49cdb4c",
  "omie-nfe-recebimento-sync": "e4290e7b6610824d367b256198280d1acd846cf5af83443143fc0a001712aef7",
  "omie-nfe-reconcile": "844e96d1d018a01374951da346d5d3d267b12431ebab1f7b8f032d117414e3c0",
  "omie-nfe-webhook": "c2267dae835b18c9f4214a6c9621f530a384e150e345cbbcecb7b2eca0e5d319",
  "omie-sync": "0f675337b50a933d3cfbd87a42346e15c25d195d6ffcce2d546fd75d94945e87",
  "omie-sync-ctes-recebidos": "8516f13ecd80ccfcdb052fb19f07611d79ae7cc2cbf9e889087530e137b836c7",
  "omie-sync-estoque": "d4a75e778a959347e47b740457a7f9388ec6651c5a2221d387ba48e4d94d7154",
  "omie-sync-metadados": "1f279e5cf99ad368d769d6bd74e295e19d1cfd1ce2ea160dcf14847bf8b8f122",
  "omie-sync-nfes-recebidas": "12f9838c4d7ccf68fb4bea2480ae79d8ebb414a1f24bff7607f474990ef213b7",
  "omie-sync-pedidos-compra": "43445982069bbdc6d4136aa24fe6969c675526a111bfb9eb24c659329c0d4feb",
  "omie-sync-sku-items": "abbf1e3a574651e3cb940fb85cbe8813a8a34a3720ad7c2847b55b0340545747",
  "omie-sync-status-produtos": "9ad6546de095335c66c160af39f6f91e51d006b375501575aa253766aed57a45",
  "omie-sync-vendas-items": "56a22cc97bdb12e9b60e374c18f8c4443e2dbe9159ca36067f1de9cf7adbce22",
  "omie-vendas-sync": "a34d5966265f394b77c739ef680557f25f851ee0fe9179288cbfad7e4028aa3c",
  "omie-webhook": "08cdf40788b99bc6096e17ac7166ded10896cbf37339743ecbe46d799805f266",
  "pedido-programado-enviar": "c4e2a9ed647e5fc0096b55ddcce3e20668d0f88363eeda82e1909962d3b178a0",
  "pedido-programado-extrair": "4247029f63e91504aea35de1d943d39580b534ee7bde57e8710a6e2cb14a7555",
  "process-nfe": "e00a9048f96b00d79b8270460ccc47cef00a3b35ab3218988324df355b35f80f",
  "process-recurring-orders": "f7860da917f827ccbec9a52a069e618b6fadd18fe31491a97f1757971cbc534c",
  "recommend": "f9e38ecc222e2c38964268fa3c7cdc040f5c800f0e30462e9e0d00d9b8c58403",
  "reposicao-depara-sayerlack-auto": "d08f9e56ca21f97883c52e148c615626f9429ff4a59c34256ea0eb0cf3d3f60a",
  "sayerlack-captura-precos": "067de5a255cf9b09e7d73995f2f6986d14cf1869dbfaf7242317866b3a263e1c",
  "scoring-recalc-batch": "3899eef2be43073b93b47445f4b36f29860c29f00b6d244cd2cffd0092bce4c6",
  "sonda-relay": "c91cdfa9d3d24850d5c7b219e03830c9ecfc572f48e9f662bd046b83ead924bb",
  "sync-reprocess": "e00db16ccbfcc5bf9709d5598ffbd1190224275f96f41ef9daa68d61d64462ac",
  "tactical-plans-batch": "6d882834d7cef695d9879e1498b1b4e8cc9073bc50906279982a8cc015d6a8be",
  "visit-score-recalc-batch": "fc6e87d83a3d700cf802731a40ac10098be412a11e6e95e7826efb1364114a95",
  "whatsapp-inbound": "dff68bcafe9edc89673ce4cd7755c721b87a1ffa833eea6874f3a7214c2d17a7",
  "whatsapp-send": "dea0911c8768412918d9730b76b0f8231ef74042715a587c003dd80f00917ecf",
  "whatsapp-send-template": "c05231ef490b58717b03f8e85de333d10ed4a5d0d113ed592ad78d9ab234ed12",
};
