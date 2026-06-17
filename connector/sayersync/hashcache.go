// hashcache.go — detecção de mudança de fórmula por HASH DE CONTEÚDO.
//
// Por quê: a tabela FORMULA do SayerSystem tem data_atualizacao SEMPRE NULL, então
// o high-water mark (state.go) nunca avança e o conector re-enviava todas as ~485k
// fórmulas a cada ciclo (loop; staging com 3,3M+ linhas). As demais entidades
// (produto/base/corante/embalagem) têm data preenchida e usam delta por timestamp
// normalmente — só a FORMULA precisa deste mecanismo.
//
// Como: para cada fórmula computamos um hash estável do CONTEÚDO que será POSTado
// (o payload de mapFormula + itens traduzidos) e guardamos em hashes.json ao lado
// do executável. Só enviamos fórmulas cujo hash é novo ou mudou.
//
// Precisão > recall: um FALSO-NEGATIVO (hash igual para conteúdo diferente) deixa o
// catálogo de produção desatualizado (cor/fórmula errada no balcão). Por isso TODO
// campo do payload entra no hash, presença de campo opcional ≠ sua ausência, e a
// quantização de float é uma política de domínio explícita (ver abaixo).
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// formulaHashFloatDecimals — casas decimais usadas para quantizar volume_final_ml
// e qtd_ml antes de hashear.
//
// ⚠️ INVARIANTE DE DOMÍNIO (não verdade técnica — Codex #2): a dosagem tintométrica
// não tem significância abaixo de 0.0001 ml; a dosadora gravimétrica do balcão opera
// na casa de 0.001 ml. Quantizar a 4 casas absorve o ruído de representação
// float32→float64 (visto no staging real: qtd_ml 5.159999847412109 = float32(5.16))
// SEM mascarar mudança real de fórmula: mudança >= 0.0001 ml é detectada; ruído
// < 0.00005 ml é suprimido de propósito (senão o conector re-envia espúrio a cada
// ciclo, recriando o loop).
const formulaHashFloatDecimals = 4

// Marcadores de presença de campo opcional — distinguem ausência de valor vazio.
// As FRONTEIRAS entre campos vêm do length-prefix (writeLP), NÃO de separadores:
// um byte de controle no conteúdo (PostgreSQL text aceita qualquer byte) poderia
// forjar uma fronteira e colidir dois payloads distintos (Codex review P2).
const (
	present = "\x01" // campo opcional PRESENTE (mesmo que vazio)
	absent  = "\x00" // campo opcional AUSENTE
)

// formulaContentHash retorna um hash estável do CONTEÚDO de uma fórmula — o payload
// que mapFormula + traduzItensCorante produzem e que é de fato POSTado em /formulas.
// Determinístico, invariante à ordem de chegada dos itens, e imune ao ruído de ponto
// flutuante (quantização). Hash de 128 bits (SHA-256 truncado): colisão é impossível
// na prática para ~485k entradas.
func formulaContentHash(m map[string]any) string {
	var b strings.Builder

	// Escalares em ordem FIXA, cada um com length-prefix. reqStr = obrigatório
	// (sempre presente pós-mapFormula); optStr/optFloat distinguem ausência de vazio.
	writeLP(&b, reqStr(m, "cor_id"))
	writeLP(&b, reqStr(m, "cod_produto"))
	writeLP(&b, reqStr(m, "id_base"))
	writeLP(&b, reqStr(m, "id_embalagem"))
	writeLP(&b, reqStr(m, "personalizada"))
	writeLP(&b, optStr(m, "nome_cor"))
	writeLP(&b, optStr(m, "subcolecao"))
	writeLP(&b, optFloat(m, "volume_final_ml"))

	// Itens ordenados — a ordem de CHEGADA no array não importa; o VALOR de cada
	// campo (inclusive `ordem`) é conteúdo e entra no hash.
	writeItens(&b, m["itens"])

	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:16])
}

// formulaCacheKey é a identidade da LINHA enviada (por-embalagem): cada fórmula
// fonte é expandida em N embalagens vendáveis, e volume/itens escalam com a
// embalagem, então a chave inclui id_embalagem (Codex #3). NÃO confundir com a chave
// de 4 partes do keys-snapshot (sem embalagem), que é o contrato de DELEÇÃO.
//
// `personalizada` vem PRIMEIRO como prefixo fixo "true|"/"false|" (o conteúdo, que
// vem depois, não pode forjá-lo) — é o que a poda usa para filtrar por namespace.
// Os campos de identidade são length-prefixed → chave injetiva: um "|" dentro de
// um id não colide duas fórmulas distintas (Codex review P2).
func formulaCacheKey(m map[string]any) string {
	var b strings.Builder
	b.WriteString(toString(m["personalizada"]))
	b.WriteByte('|')
	writeLP(&b, toString(m["cor_id"]))
	writeLP(&b, toString(m["cod_produto"]))
	writeLP(&b, toString(m["id_base"]))
	writeLP(&b, toString(m["id_embalagem"]))
	return b.String()
}

// ─────────────────────────────────────────────────────────────
// helpers de canonicalização (puros)
// ─────────────────────────────────────────────────────────────

// writeLP escreve val com o comprimento prefixado ("<len>:<val>") — encoding
// injetivo: o conteúdo não tem como forjar a fronteira entre campos (Codex review
// P2), garantindo que payloads distintos nunca colapsem no mesmo stream de hash.
func writeLP(b *strings.Builder, val string) {
	b.WriteString(strconv.Itoa(len(val)))
	b.WriteByte(':')
	b.WriteString(val)
}

// reqStr: campo obrigatório como string (sempre presente após mapFormula).
func reqStr(m map[string]any, key string) string {
	return toString(m[key])
}

// optStr: campo opcional textual — distingue ausência de presença-vazia.
func optStr(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok {
		return absent
	}
	return present + toString(v)
}

// optFloat: campo opcional numérico — quantizado; ausência distinta de presença.
// Presente-mas-não-parseável degrada para um marcador distinto (nunca vira 0).
func optFloat(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok {
		return absent
	}
	f, fok := toFloat64OK(v)
	if !fok {
		return present + "NaN"
	}
	return present + quantizeFloat(f)
}

// quantizeFloat formata um float com exatamente formulaHashFloatDecimals casas —
// o arredondamento da formatação ('f') É a quantização.
func quantizeFloat(f float64) string {
	return strconv.FormatFloat(f, 'f', formulaHashFloatDecimals, 64)
}

// writeItens serializa os itens de corante de forma estável (ordenada) e injetiva
// (cada item e cada componente com length-prefix). Itens ausentes/vazios → marcador
// determinístico. A ordem de CHEGADA no array não importa; o VALOR de cada campo sim.
func writeItens(b *strings.Builder, v any) {
	itens, ok := v.([]map[string]any)
	if !ok || len(itens) == 0 {
		writeLP(b, absent)
		return
	}
	parts := make([]string, len(itens))
	for i, it := range itens {
		qtd := "NaN"
		if f, fok := toFloat64OK(it["qtd_ml"]); fok {
			qtd = quantizeFloat(f)
		}
		var ib strings.Builder
		writeLP(&ib, toString(it["ordem"]))
		writeLP(&ib, toString(it["id_corante"]))
		writeLP(&ib, qtd)
		parts[i] = ib.String()
	}
	sort.Strings(parts)
	writeLP(b, present)
	for _, p := range parts {
		writeLP(b, p)
	}
}

// ─────────────────────────────────────────────────────────────
// HashCache — persistência em hashes.json (espelha state.go)
// ─────────────────────────────────────────────────────────────

// hashCacheVersion é a versão do formato do hashes.json (permite migração futura).
const hashCacheVersion = 1

// HashCache guarda o hash de conteúdo de cada fórmula JÁ enviada com sucesso ao
// staging, indexado por formulaCacheKey. Persistido em hashes.json ao lado do exe.
//
// ⚠️ O cache espelha o que o conector ENVIOU AO STAGING — NÃO o catálogo de produção
// (Codex #6: o 2xx da edge significa "staged"; a promoção staging→produção é
// server-side). Portanto, ao PURGAR o staging (faxina da fase seguinte), o
// hashes.json TEM que ser apagado junto no balcão — senão o full re-scan acha que
// "já enviou tudo" e não re-popula nada.
//
// ⚠️ Premissa SINGLE-INSTANCE (como o state.json): a gravação é whole-file replace
// SEM lock cross-process. O serviço Windows roda uma instância única (kardianos);
// NÃO rodar `once` manual enquanto o serviço está ativo — um lost-update poderia
// reverter um hash a um valor antigo (Codex review P2). File-lock cross-platform
// fica como dívida (mesma exposição já existente do state.json).
type HashCache struct {
	Version  int               `json:"version"`
	Formulas map[string]string `json:"formulas"`
	dirty    bool              // não serializado; true = há mudança a persistir
}

// newHashCache cria um cache vazio (= full sync na primeira execução).
func newHashCache() *HashCache {
	return &HashCache{Version: hashCacheVersion, Formulas: make(map[string]string)}
}

// Get retorna o hash armazenado para uma chave.
func (hc *HashCache) Get(key string) (string, bool) {
	v, ok := hc.Formulas[key]
	return v, ok
}

// Set grava o hash de uma chave; marca dirty apenas se o valor mudou.
func (hc *HashCache) Set(key, hash string) {
	if old, ok := hc.Formulas[key]; ok && old == hash {
		return
	}
	hc.Formulas[key] = hash
	hc.dirty = true
}

// Delete remove uma chave; marca dirty apenas se a chave existia.
func (hc *HashCache) Delete(key string) {
	if _, ok := hc.Formulas[key]; !ok {
		return
	}
	delete(hc.Formulas, key)
	hc.dirty = true
}

// Len retorna o número de fórmulas no cache.
func (hc *HashCache) Len() int { return len(hc.Formulas) }

// Dirty indica se há mudança não persistida.
func (hc *HashCache) Dirty() bool { return hc.dirty }

// clearDirty zera o flag dirty (chamado após save bem-sucedido).
func (hc *HashCache) clearDirty() { hc.dirty = false }

// hashCachePath retorna o caminho do hashes.json ao lado do executável. Usa o seam
// stateDir (= exeDir em produção; introduzido pelo #919) para que testes que isolam
// stateDir também isolem o hashes.json, em paridade com statePath().
func hashCachePath() string {
	return filepath.Join(stateDir(), "hashes.json")
}

// LoadHashCache carrega o hashes.json ao lado do executável.
func LoadHashCache() (*HashCache, error) {
	return loadHashCacheFrom(hashCachePath())
}

// loadHashCacheFrom carrega o cache de um caminho específico (testável).
//   - arquivo ausente → cache vazio, sem erro (1ª execução = full sync)
//   - JSON malformado → cache vazio + renomeia para .corrupt + loga ALTO
//     (Codex #9: nunca tratar corrupção como vazio em silêncio; o full resend é
//     seguro, mas o operador precisa saber). NÃO é erro fatal.
//   - erro de I/O real → propaga (não é seguro adivinhar)
func loadHashCacheFrom(path string) (*HashCache, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return newHashCache(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("erro ao ler hashes.json: %w", err)
	}
	var hc HashCache
	if jErr := json.Unmarshal(data, &hc); jErr != nil {
		corruptPath := path + ".corrupt"
		logger.Errorf("hashes.json corrompido (%v) — renomeando para %s e fazendo full resend", jErr, corruptPath)
		if rnErr := os.Rename(path, corruptPath); rnErr != nil {
			logger.Errorf("falha ao preservar hashes.json corrompido: %v", rnErr)
		}
		return newHashCache(), nil
	}
	if hc.Formulas == nil {
		hc.Formulas = make(map[string]string)
	}
	if hc.Version == 0 {
		hc.Version = hashCacheVersion
	}
	return &hc, nil
}

// SaveHashCache persiste o cache em hashes.json ao lado do executável.
func SaveHashCache(hc *HashCache) error {
	return saveHashCacheTo(hc, hashCachePath())
}

// saveHashCacheTo persiste o cache num caminho específico (testável), com escrita
// atômica (tmp → rename). NO-OP quando não há mudança (dirty=false) — evita
// reescrever ~30MB a cada ciclo estável. Sem indent (arquivo de máquina; com ~485k
// entradas, compacto importa).
func saveHashCacheTo(hc *HashCache, path string) error {
	if !hc.dirty {
		return nil
	}
	data, err := json.Marshal(hc)
	if err != nil {
		return fmt.Errorf("erro ao serializar hashes: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return fmt.Errorf("erro ao escrever hashes tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("erro ao renomear hashes tmp: %w", err)
	}
	hc.dirty = false
	return nil
}

// pruneFormulaHashes remove do cache as chaves de fórmula DESTA entidade (mesmo
// `personalizada`) ausentes de liveKeys na extração full-scan corrente. Só pode ser
// chamado quando a extração foi COMPLETA (o caller gateia em hwm.IsZero()) — senão
// um delta parcial removeria chaves vivas. O namespace por `personalizada` (prefixo
// "true|"/"false|" da chave) evita que formula e formulaperson se podem mutuamente
// (Codex #7/#8). Deletar a chave corrente durante o range do map é seguro em Go.
func pruneFormulaHashes(hc *HashCache, liveKeys map[string]struct{}, personalizada bool) {
	prefix := "false|"
	if personalizada {
		prefix = "true|"
	}
	for key := range hc.Formulas {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if _, alive := liveKeys[key]; !alive {
			hc.Delete(key)
		}
	}
}
