// hashcache_property_test.go — propriedades do hash de conteúdo (follow-up P2 do
// challenge Codex da Fase 1d, PR #1474: "o golden cobre uma falsificação, não uma
// propriedade").
//
// O hash decide O QUE re-envia ao servidor: colisão (payloads distintos, hash igual)
// deixa o catálogo de produção DESATUALIZADO em silêncio (falso-negativo, o pior
// caso — precisão > recall); instabilidade (mesmo payload, hash diferente) recria o
// re-envio infinito das 485k. Este arquivo prova as propriedades por construção
// dirigida + varredura determinística (seed FIXA — nada de flakiness):
//   P1  determinismo: mesmo payload → mesmo hash, sempre.
//   P2  ordem de chegada dos itens não importa (permutação → hash IGUAL).
//   P3  mutação de qualquer campo escalar/item → hash DIFERENTE (injetividade prática).
//   P4  quantização é política, não bug: ruído < 0.00005 ml → IGUAL; ±0.001 → DIFERENTE.
//   P5  is_base_pura: true ≠ ausente; false ≡ ausente (o campo só viaja quando true).
//   P6  bytes hostis (\x01, '|', ':', dígitos, "5:") em ids não colidem campos nem
//       forjam o sufixo do is_base_pura.
//   P7  varredura: 4.000 payloads canonicamente distintos → 4.000 hashes únicos.
package main

import (
	"fmt"
	"math/rand"
	"testing"
)

func payloadBase() map[string]any {
	return map[string]any{
		"cor_id": "COR1", "cod_produto": "P1", "id_base": "B1", "id_embalagem": "E1",
		"personalizada": false, "nome_cor": "Azul", "subcolecao": "SL", "volume_final_ml": 900.0,
		"itens": []map[string]any{
			{"id_corante": "AX", "ordem": 1, "qtd_ml": 10.0},
			{"id_corante": "VM", "ordem": 2, "qtd_ml": 5.16},
		},
	}
}

func clonePayload(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if itens, ok := v.([]map[string]any); ok {
			ci := make([]map[string]any, len(itens))
			for i, it := range itens {
				c := make(map[string]any, len(it))
				for ik, iv := range it {
					c[ik] = iv
				}
				ci[i] = c
			}
			out[k] = ci
			continue
		}
		out[k] = v
	}
	return out
}

func TestHashProperty_DeterminismoEPermutacao(t *testing.T) {
	m := payloadBase()
	h1 := formulaContentHash(m)
	if h2 := formulaContentHash(payloadBase()); h2 != h1 {
		t.Fatalf("P1 determinismo violado: %s ≠ %s", h1, h2)
	}
	// P2: permutar a ordem de CHEGADA dos itens não muda o hash.
	perm := payloadBase()
	itens := perm["itens"].([]map[string]any)
	itens[0], itens[1] = itens[1], itens[0]
	if hp := formulaContentHash(perm); hp != h1 {
		t.Fatalf("P2 permutação mudou o hash: %s ≠ %s", hp, h1)
	}
}

func TestHashProperty_MutacaoDeCadaCampoMudaOHash(t *testing.T) {
	base := payloadBase()
	h0 := formulaContentHash(base)

	mutacoes := map[string]func(m map[string]any){
		"cor_id":            func(m map[string]any) { m["cor_id"] = "COR2" },
		"cod_produto":       func(m map[string]any) { m["cod_produto"] = "P2" },
		"id_base":           func(m map[string]any) { m["id_base"] = "B2" },
		"id_embalagem":      func(m map[string]any) { m["id_embalagem"] = "E2" },
		"personalizada":     func(m map[string]any) { m["personalizada"] = true },
		"nome_cor":          func(m map[string]any) { m["nome_cor"] = "Azul Claro" },
		"nome_cor ausente":  func(m map[string]any) { delete(m, "nome_cor") },
		"nome_cor vazio":    func(m map[string]any) { m["nome_cor"] = "" }, // presença-vazia ≠ valor
		"subcolecao":        func(m map[string]any) { m["subcolecao"] = "1" },
		"volume":            func(m map[string]any) { m["volume_final_ml"] = 3600.0 },
		"volume ausente":    func(m map[string]any) { delete(m, "volume_final_ml") },
		"item qtd":          func(m map[string]any) { m["itens"].([]map[string]any)[0]["qtd_ml"] = 11.0 },
		"item id":           func(m map[string]any) { m["itens"].([]map[string]any)[1]["id_corante"] = "VM2" },
		"item ordem":        func(m map[string]any) { m["itens"].([]map[string]any)[0]["ordem"] = 3 },
		"item qtd nil":      func(m map[string]any) { m["itens"].([]map[string]any)[0]["qtd_ml"] = nil },
		"item a menos":      func(m map[string]any) { m["itens"] = m["itens"].([]map[string]any)[:1] },
		"itens vazios":      func(m map[string]any) { m["itens"] = []map[string]any{} },
		"item placeholder":  func(m map[string]any) { m["itens"] = append(m["itens"].([]map[string]any), map[string]any{"id_corante": "", "ordem": 3, "qtd_ml": nil}) },
		"is_base_pura true": func(m map[string]any) { m["is_base_pura"] = true },
	}

	vistos := map[string]string{h0: "base"}
	for nome, muta := range mutacoes {
		m := clonePayload(base)
		muta(m)
		h := formulaContentHash(m)
		if h == h0 {
			t.Errorf("P3: mutação %q NÃO mudou o hash (falso-negativo → catálogo desatualizado em silêncio)", nome)
		}
		if outro, ja := vistos[h]; ja {
			t.Errorf("P3: colisão entre mutações %q e %q", nome, outro)
		}
		vistos[h] = nome
	}
}

func TestHashProperty_QuantizacaoEhPolitica(t *testing.T) {
	base := payloadBase()
	h0 := formulaContentHash(base)
	// Ruído de representação float32→float64 (sub-0.00005 ml) é SUPRIMIDO de propósito
	// (senão o conector re-envia espúrio a cada ciclo — o loop das 485k).
	ruido := clonePayload(base)
	ruido["itens"].([]map[string]any)[1]["qtd_ml"] = 5.159999847412109 // float32(5.16)
	if h := formulaContentHash(ruido); h != h0 {
		t.Fatalf("P4: ruído sub-quantização mudou o hash — re-envio espúrio voltaria")
	}
	// Mudança real de dosagem (0.001 ml, acima da significância de 0.0001) é detectada.
	real := clonePayload(base)
	real["itens"].([]map[string]any)[1]["qtd_ml"] = 5.161
	if h := formulaContentHash(real); h == h0 {
		t.Fatalf("P4: mudança real de dosagem (5.16→5.161) NÃO mudou o hash")
	}
}

func TestHashProperty_IsBasePuraFalseEquivaleAusente(t *testing.T) {
	sem := payloadBase()
	comFalse := clonePayload(sem)
	comFalse["is_base_pura"] = false
	if formulaContentHash(sem) != formulaContentHash(comFalse) {
		t.Fatal("P5: is_base_pura=false deveria hashear IGUAL a ausente (o campo só viaja quando true)")
	}
	comTrue := clonePayload(sem)
	comTrue["is_base_pura"] = true
	if formulaContentHash(sem) == formulaContentHash(comTrue) {
		t.Fatal("P5: is_base_pura=true deveria mudar o hash")
	}
}

func TestHashProperty_BytesHostisNaoColidem(t *testing.T) {
	// Conteúdo controlado pela fonte tentando forjar fronteiras do encoding:
	// length-prefix falso ("5:"), separador de key ("|"), marcador present (\x01),
	// o próprio sufixo do is_base_pura ("\x01true").
	hostis := []string{"5:", "|", "\x01", "\x01true", "6:\x01true", "0:", "AX|1", "1:A"}
	vistos := map[string]string{}
	for i, id := range hostis {
		m := payloadBase()
		m["itens"] = []map[string]any{{"id_corante": id, "ordem": 1, "qtd_ml": 1.0}}
		h := formulaContentHash(m)
		if outro, ja := vistos[h]; ja {
			t.Errorf("P6: ids hostis %q e %q colidiram", id, outro)
		}
		vistos[h] = id
		// E nenhum deles pode colidir com a versão is_base_pura=true de payload sem itens.
		pura := payloadBase()
		pura["itens"] = []map[string]any{}
		pura["is_base_pura"] = true
		if h == formulaContentHash(pura) {
			t.Errorf("P6: id hostil %q forjou o sufixo is_base_pura (caso %d)", id, i)
		}
	}
}

func TestHashProperty_VarreduraSemColisao(t *testing.T) {
	// 4.000 payloads canonicamente DISTINTOS por construção (cada um difere do base em
	// pelo menos um valor derivado do índice — nunca por mera permutação) → 4.000 hashes
	// únicos. Seed fixa: determinístico, sem flakiness.
	rng := rand.New(rand.NewSource(20260720))
	vistos := make(map[string]int, 4001)
	vistos[formulaContentHash(payloadBase())] = -1
	for i := 0; i < 4000; i++ {
		m := payloadBase()
		m["cor_id"] = fmt.Sprintf("COR-%d", i) // distinção canônica garantida
		// Variação estrutural aleatória mas determinística (seed fixa):
		nItens := rng.Intn(7)
		itens := make([]map[string]any, 0, nItens)
		for j := 0; j < nItens; j++ {
			item := map[string]any{
				"id_corante": fmt.Sprintf("C%02d", rng.Intn(40)),
				"ordem":      j + 1,
			}
			switch rng.Intn(4) {
			case 0:
				item["qtd_ml"] = nil
			case 1:
				item["qtd_ml"] = float64(rng.Intn(2000)) / 100.0
			case 2:
				item["qtd_ml"] = -float64(rng.Intn(100)) / 10.0
			default:
				item["qtd_ml"] = float64(rng.Intn(90)) + 0.5
			}
			itens = append(itens, item)
		}
		m["itens"] = itens
		if nItens == 0 && rng.Intn(2) == 0 {
			m["is_base_pura"] = true
		}
		if rng.Intn(3) == 0 {
			delete(m, "subcolecao")
		}
		h := formulaContentHash(m)
		if prev, ja := vistos[h]; ja {
			t.Fatalf("P7: colisão entre payload %d e %d (hash %s)", i, prev, h)
		}
		vistos[h] = i
	}
}
