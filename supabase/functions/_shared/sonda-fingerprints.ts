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
  "analyze-services": "70f5030001c8e6170c0ac731c21ac85b58e5e6e79ac2044b4c92e224b93cfffe",
  "analyze-unified-order": "0989262a17cd078c02782a7968964480a8da4e85a88c6d46ad2c7ac619cd9fd8",
  "calculate-scores": "9d5e83b0793bfc7768e66becba5f2c5cb47c53522f1a500b3653a8bbd9a9a3fe",
  "carteira-positivacao-snapshot": "29a243f5830de7fd5e9a8bb67c76b17663d635319690bcda80b662efbd7ae23a",
  "carteira-rebuild": "8d2589d04aa1188000c918f88967030ea0b26ff54aa7f642c4f50727986eb78a",
  "cmc-snapshot-backfill": "4fba1259c114fb955430b440f65e8344c6e9bc29ca92292d094c3c4b4e601d06",
  "conciliar-pedido-portal": "c5e8f0f688486a6dcedfdc459e675e8827db712668d26c14dd197ad8db49ee6d",
  "copilot-analyze": "df49e9763781f176b91808c5cf98b2d9f5d70b276b00977c31c5227d62886e0a",
  "disparar-pedidos-aprovados": "407d8efff32d96387c554ed6ad6bd5f095be236b77ebe4d682dcc130ed9815b5",
  "dispatch-notifications": "b46aa29eabbd5164d1270768ebd65b31a09bdf1da9359c3f4f2c92b5ef6a8f89",
  "elevenlabs-transcribe": "c61046b0523d8e2196fd8eda02e4238040180b1a14be68aab4ca5135fbcbb0e0",
  "enviar-pedido-portal-sayerlack": "bebeb30068ef02f2eed8ef4087c0ef5f9e0d298e4d73ae7c3ebf5fd3e8643797",
  "enviar-push": "38302707026818b24e43f4936dea80f7648c68b2c1351385c7ddd5e396bdd9d5",
  "fin-cashflow-engine": "23728836f0e8eb9410b85c3ec406ba6ef92b269dcddf040123d208ca3f9e402d",
  "fin-funding": "710664f5c02945c32c74f1a4847d120575165435d4ee8f6257a98e3673714c6a",
  "fin-valor-cockpit": "1ed02206fb6b033ec92d351a8595dc0b92ac39f9e99e485d5491047f8d58aa29",
  "generate-bundle-argument": "c8088c32e078e2bd7ac73103882cec7f41be8675bc36199744f201bc4876b701",
  "generate-tactical-plan": "69ebb00cbc46ffb99302c5332f0cd6ec8597593318b90eecb6db0251c2568b42",
  "gerar-pedidos-diario": "ed7524d4ffe9de36e6b79c9a9b3832aba427e62d15dcc38076b191ded1f43e0c",
  "identify-tool": "d503dd923e2e73b5e200c0b8fed700b6c938d0313e92ec6d6203b2c4b59f45a9",
  "monthly-report": "578a6e8963a0f1fd0fee9bc8fbd971892b9cdae5128894e40e74d9989cc4d7ab",
  "nvoip-calls": "2b3934215e43fae406b6c270bd6a319f9cef3b91c02d02c25bf6890fe2657435",
  "omie-analytics-sync": "86611f00e1f34965179f8b6a6c5bac38bc01a240b677b296182304046e7472e5",
  "omie-aplicar-parametros": "132174780a3175d470853b88833b8e366fcce36cfa2608ec3308bea2cb75518c",
  "omie-cliente": "fade69529ee1b7d62c65c640c98af721bf9df1030c078c93ec5c9dd55eaae92f",
  "omie-cron-diario": "0bc7f2b02ce1be0d11b791a665bf5ba44494e90488205474ad38a49fa14fa4f3",
  "omie-desconto-backfill": "3a9a5716aeb427b9ae36919bcfa95a736f5d046d344d6350cbc4ced95ca711f5",
  "omie-financeiro": "c2d0cb4f1a98d55e2eb71098906c4a98953f883d801d474f8f2a9f4e958eef93",
  "omie-malha-sync": "346aaa13fa16bab1f19085e39e2461e23a5d9ca189ef9afaf25030f163ec44cb",
  "omie-nfe-recebimento": "e69f5f4fe0c581043237e33d55bef413b245f7e264ae88138f5439a1f49cdb4c",
  "omie-nfe-recebimento-sync": "e4290e7b6610824d367b256198280d1acd846cf5af83443143fc0a001712aef7",
  "omie-nfe-reconcile": "844e96d1d018a01374951da346d5d3d267b12431ebab1f7b8f032d117414e3c0",
  "omie-nfe-webhook": "c2267dae835b18c9f4214a6c9621f530a384e150e345cbbcecb7b2eca0e5d319",
  "omie-sync": "0f675337b50a933d3cfbd87a42346e15c25d195d6ffcce2d546fd75d94945e87",
  "omie-sync-ctes-recebidos": "bc8533b737d175adbca4a6ab49f2ec1dc385670f919368db53fe9b4f00c8d9b2",
  "omie-sync-estoque": "402b010fd5d8a6f1b71b71422a6e310d7e25ddc6f4a79176d589e133555cba44",
  "omie-sync-metadados": "5f7e44072fd1de1b46bccca20f812312c5e173d6e7541cf82d1d7b5bfb78f9a6",
  "omie-sync-nfes-recebidas": "9fdb19a30bf3e0c0b295de056da98f1b387519bf8d549b6f62d362ac223388c6",
  "omie-sync-pedidos-compra": "43445982069bbdc6d4136aa24fe6969c675526a111bfb9eb24c659329c0d4feb",
  "omie-sync-sku-items": "8c321a930cf54fb8fc62464337542cf5e679f0d05c28b0f5b9931e985e4a6091",
  "omie-sync-status-produtos": "9ad6546de095335c66c160af39f6f91e51d006b375501575aa253766aed57a45",
  "omie-sync-vendas-items": "56a22cc97bdb12e9b60e374c18f8c4443e2dbe9159ca36067f1de9cf7adbce22",
  "omie-vendas-sync": "4c883755756ed6ee3896999465cbafe4b0a5c8ad3e079998ee2c75780a878066",
  "omie-webhook": "08cdf40788b99bc6096e17ac7166ded10896cbf37339743ecbe46d799805f266",
  "pedido-programado-enviar": "c4e2a9ed647e5fc0096b55ddcce3e20668d0f88363eeda82e1909962d3b178a0",
  "pedido-programado-extrair": "4247029f63e91504aea35de1d943d39580b534ee7bde57e8710a6e2cb14a7555",
  "process-nfe": "e00a9048f96b00d79b8270460ccc47cef00a3b35ab3218988324df355b35f80f",
  "process-recurring-orders": "f7860da917f827ccbec9a52a069e618b6fadd18fe31491a97f1757971cbc534c",
  "recommend": "ecaa23882a393d5f46f0bd1d36c1e97467cf5f743f6821d22716f28e9da749ea",
  "reposicao-depara-sayerlack-auto": "d08f9e56ca21f97883c52e148c615626f9429ff4a59c34256ea0eb0cf3d3f60a",
  "sayerlack-captura-precos": "067de5a255cf9b09e7d73995f2f6986d14cf1869dbfaf7242317866b3a263e1c",
  "scoring-recalc-batch": "3899eef2be43073b93b47445f4b36f29860c29f00b6d244cd2cffd0092bce4c6",
  "sonda-relay": "c91cdfa9d3d24850d5c7b219e03830c9ecfc572f48e9f662bd046b83ead924bb",
  "sync-reprocess": "1f4f1b554a25776e16fb05b1ad180024ef96808b28236ddeac083ea8c1102a6e",
  "tactical-plans-batch": "6d882834d7cef695d9879e1498b1b4e8cc9073bc50906279982a8cc015d6a8be",
  "visit-score-recalc-batch": "fc6e87d83a3d700cf802731a40ac10098be412a11e6e95e7826efb1364114a95",
  "whatsapp-inbound": "dff68bcafe9edc89673ce4cd7755c721b87a1ffa833eea6874f3a7214c2d17a7",
  "whatsapp-send": "dea0911c8768412918d9730b76b0f8231ef74042715a587c003dd80f00917ecf",
  "whatsapp-send-template": "a4fec739b2c2695fe4954c03c6c7b134f41bba910eec8e2769427a4a5dfa7f02",
};
