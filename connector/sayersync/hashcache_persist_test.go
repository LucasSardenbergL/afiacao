// hashcache_persist_test.go — testes de persistência do cache de hashes
// (hashes.json): round-trip, escrita atômica/no-op, e tratamento de corrupção.
package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHashCache_loadAusente_retornaVazioSemErro(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hashes.json")
	hc, err := loadHashCacheFrom(path)
	if err != nil {
		t.Fatalf("arquivo ausente não deve ser erro: %v", err)
	}
	if hc == nil || hc.Len() != 0 {
		t.Fatal("cache de arquivo ausente deve ser vazio (= full sync na 1ª execução)")
	}
	if hc.Dirty() {
		t.Fatal("cache recém-carregado não deve estar dirty")
	}
}

func TestHashCache_roundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hashes.json")
	hc := newHashCache()
	hc.Set("5059 - BS|FO87.6782|8|1|false", "deadbeef")
	hc.Set("0105 IVE |X|2|3|true", "cafef00d")

	if err := saveHashCacheTo(hc, path); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := loadHashCacheFrom(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if v, ok := got.Get("5059 - BS|FO87.6782|8|1|false"); !ok || v != "deadbeef" {
		t.Fatalf("chave 1 não sobreviveu ao round-trip: %q,%v", v, ok)
	}
	if v, ok := got.Get("0105 IVE |X|2|3|true"); !ok || v != "cafef00d" {
		t.Fatalf("chave 2 não sobreviveu ao round-trip: %q,%v", v, ok)
	}
	if got.Len() != 2 {
		t.Fatalf("len = %d, esperado 2", got.Len())
	}
}

func TestHashCache_saveNaoDirty_eNoOp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hashes.json")
	hc := newHashCache() // vazio, não dirty
	if err := saveHashCacheTo(hc, path); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("save de cache não-dirty NÃO deve criar arquivo (evita reescrever ~30MB à toa)")
	}
}

func TestHashCache_saveLimpaDirty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hashes.json")
	hc := newHashCache()
	hc.Set("k", "h")
	if !hc.Dirty() {
		t.Fatal("Set deveria marcar dirty")
	}
	if err := saveHashCacheTo(hc, path); err != nil {
		t.Fatalf("save: %v", err)
	}
	if hc.Dirty() {
		t.Fatal("após save bem-sucedido o cache não deve continuar dirty")
	}
}

func TestHashCache_corrupto_backupEFullResend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hashes.json")
	if err := os.WriteFile(path, []byte("{lixo não-json}"), 0600); err != nil {
		t.Fatal(err)
	}
	hc, err := loadHashCacheFrom(path)
	if err != nil {
		t.Fatalf("corrupção não deve ser erro fatal (full resend é seguro): %v", err)
	}
	if hc.Len() != 0 {
		t.Fatal("cache corrompido deve carregar vazio (full resend)")
	}
	// Codex #9: não apagar em silêncio — preservar para diagnóstico.
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Fatalf("arquivo corrompido deveria ter sido renomeado para .corrupt: %v", err)
	}
}

func TestHashCache_setMarcaDirtySomenteEmMudanca(t *testing.T) {
	hc := newHashCache()
	hc.Set("k", "h")
	if !hc.Dirty() {
		t.Fatal("Set de chave nova deve marcar dirty")
	}
	hc.clearDirty()
	hc.Set("k", "h") // mesmo valor
	if hc.Dirty() {
		t.Fatal("Set com mesmo valor não deve marcar dirty")
	}
	hc.Set("k", "h2") // valor diferente
	if !hc.Dirty() {
		t.Fatal("Set com valor diferente deve marcar dirty")
	}
}

func TestHashCache_deleteMarcaDirtySomenteSeExistia(t *testing.T) {
	hc := newHashCache()
	hc.Set("k", "h")
	hc.clearDirty()
	hc.Delete("inexistente")
	if hc.Dirty() {
		t.Fatal("Delete de chave inexistente não deve marcar dirty")
	}
	hc.Delete("k")
	if !hc.Dirty() {
		t.Fatal("Delete de chave existente deve marcar dirty")
	}
	if _, ok := hc.Get("k"); ok {
		t.Fatal("chave deletada ainda presente")
	}
}
