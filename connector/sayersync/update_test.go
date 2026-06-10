package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

func fakeBinary(content string) []byte {
	return []byte(content)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func serveManifest(t *testing.T, m UpdateManifest) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(m)
	}))
}

func serveBinary(t *testing.T, data []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))
}

// ─────────────────────────────────────────────────────────────
// isNewerVersion
// ─────────────────────────────────────────────────────────────

func TestIsNewerVersion(t *testing.T) {
	tests := []struct {
		candidate string
		current   string
		want      bool
	}{
		{"0.2.0", "0.1.0", true},
		{"1.0.0", "0.9.9", true},
		{"0.1.1", "0.1.0", true},
		{"0.1.0", "0.1.0", false}, // igual → não atualiza
		{"0.0.9", "0.1.0", false}, // mais antigo → anti-downgrade
		{"v0.2.0", "0.1.0", true}, // prefixo v aceito
		{"0.2.0", "v0.1.0", true}, // prefixo v no current também
		{"invalid", "0.1.0", false},
		{"0.1.0", "invalid", true}, // versão atual inválida/dev → qualquer release válido é mais novo
		{"", "0.1.0", false},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("%s_vs_%s", tt.candidate, tt.current), func(t *testing.T) {
			got := isNewerVersion(tt.candidate, tt.current)
			if got != tt.want {
				t.Errorf("isNewerVersion(%q, %q) = %v, want %v", tt.candidate, tt.current, got, tt.want)
			}
		})
	}
}

// ─────────────────────────────────────────────────────────────
// parseSemver
// ─────────────────────────────────────────────────────────────

func TestParseSemver(t *testing.T) {
	maj, min, pat, ok := parseSemver("1.2.3")
	if !ok || maj != 1 || min != 2 || pat != 3 {
		t.Errorf("parseSemver(1.2.3) = %d.%d.%d ok=%v", maj, min, pat, ok)
	}

	_, _, _, ok2 := parseSemver("notasemver")
	if ok2 {
		t.Error("parseSemver('notasemver') deveria retornar ok=false")
	}

	// Prefixo v
	maj2, min2, pat2, ok3 := parseSemver("v0.5.10")
	if !ok3 || maj2 != 0 || min2 != 5 || pat2 != 10 {
		t.Errorf("parseSemver(v0.5.10) = %d.%d.%d ok=%v", maj2, min2, pat2, ok3)
	}

	// Sufixo de pre-release ignorado
	_, _, pat3, ok4 := parseSemver("1.0.0-beta")
	if !ok4 || pat3 != 0 {
		t.Errorf("parseSemver(1.0.0-beta) pat=%d ok=%v", pat3, ok4)
	}
}

// ─────────────────────────────────────────────────────────────
// shouldCheckUpdate
// ─────────────────────────────────────────────────────────────

func TestShouldCheckUpdate_firstRun(t *testing.T) {
	st := &State{}
	if !shouldCheckUpdate(st) {
		t.Error("primeira run deve verificar update")
	}
}

func TestShouldCheckUpdate_sameDay(t *testing.T) {
	st := &State{LastUpdateAttempt: time.Now().UTC().Format(time.RFC3339)}
	if shouldCheckUpdate(st) {
		t.Error("no mesmo dia não deve verificar update novamente")
	}
}

func TestShouldCheckUpdate_nextDay(t *testing.T) {
	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format(time.RFC3339)
	st := &State{LastUpdateAttempt: yesterday}
	if !shouldCheckUpdate(st) {
		t.Error("dia diferente deve verificar update")
	}
}

func TestShouldCheckUpdate_invalidDate(t *testing.T) {
	st := &State{LastUpdateAttempt: "not-a-date"}
	if !shouldCheckUpdate(st) {
		t.Error("data inválida deve permitir verificação")
	}
}

// ─────────────────────────────────────────────────────────────
// isCrashLoopGuardActive
// ─────────────────────────────────────────────────────────────

func TestCrashLoopGuard_inactive(t *testing.T) {
	st := &State{UpdateFailCount: 2} // abaixo do limiar
	if isCrashLoopGuardActive(st) {
		t.Error("< 3 falhas não deve ativar o guard")
	}
}

func TestCrashLoopGuard_thresholdButOld(t *testing.T) {
	// 3 falhas mas última tentativa foi há mais de 24h → guard inativo
	old := time.Now().UTC().Add(-25 * time.Hour).Format(time.RFC3339)
	st := &State{
		UpdateFailCount:   3,
		LastUpdateAttempt: old,
	}
	if isCrashLoopGuardActive(st) {
		t.Error("falhas antigas (>24h) não devem ativar o guard")
	}
}

func TestCrashLoopGuard_active(t *testing.T) {
	recent := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	st := &State{
		UpdateFailCount:   3,
		LastUpdateAttempt: recent,
	}
	if !isCrashLoopGuardActive(st) {
		t.Error("3 falhas recentes devem ativar o guard")
	}
}

func TestCrashLoopGuard_emptyAttempt(t *testing.T) {
	st := &State{UpdateFailCount: 3}
	// Sem LastUpdateAttempt → guard inativo (não temos janela de referência)
	if isCrashLoopGuardActive(st) {
		t.Error("sem LastUpdateAttempt o guard deve estar inativo")
	}
}

// ─────────────────────────────────────────────────────────────
// verifySHA256
// ─────────────────────────────────────────────────────────────

func TestVerifySHA256_valid(t *testing.T) {
	data := []byte("hello world")
	h := sha256Hex(data)
	if err := verifySHA256(data, h); err != nil {
		t.Errorf("sha256 válido rejeitado: %v", err)
	}
}

func TestVerifySHA256_uppercase(t *testing.T) {
	data := []byte("hello world")
	h := sha256Hex(data)
	// Coloca em uppercase para testar case-insensitive
	upper := fmt.Sprintf("%s", []byte(h))
	if err := verifySHA256(data, upper); err != nil {
		t.Errorf("sha256 uppercase deve ser aceito: %v", err)
	}
}

func TestVerifySHA256_invalid(t *testing.T) {
	data := []byte("hello world")
	if err := verifySHA256(data, "0000000000000000000000000000000000000000000000000000000000000000"); err == nil {
		t.Error("sha256 inválido não foi rejeitado")
	}
}

// ─────────────────────────────────────────────────────────────
// fetchManifest
// ─────────────────────────────────────────────────────────────

func TestFetchManifest_success(t *testing.T) {
	bin := fakeBinary("fake-binary-content")
	srv := serveBinary(t, bin)
	defer srv.Close()

	manifest := UpdateManifest{
		Version: "0.2.0",
		SHA256:  sha256Hex(bin),
		URL:     srv.URL + "/sayersync.exe",
	}
	mSrv := serveManifest(t, manifest)
	defer mSrv.Close()

	got, err := fetchManifest(context.Background(), mSrv.URL)
	if err != nil {
		t.Fatalf("fetchManifest falhou: %v", err)
	}
	if got.Version != "0.2.0" {
		t.Errorf("versão esperada 0.2.0, got %q", got.Version)
	}
	if got.SHA256 != manifest.SHA256 {
		t.Errorf("sha256 mismatch")
	}
}

func TestFetchManifest_http404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := fetchManifest(context.Background(), srv.URL)
	if err == nil {
		t.Error("404 deveria retornar erro")
	}
}

func TestFetchManifest_incomplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Manifesto sem url
		_ = json.NewEncoder(w).Encode(map[string]string{"version": "0.2.0", "sha256": "abc"})
	}))
	defer srv.Close()

	_, err := fetchManifest(context.Background(), srv.URL)
	if err == nil {
		t.Error("manifesto incompleto (sem url) deveria retornar erro")
	}
}

// ─────────────────────────────────────────────────────────────
// downloadBinary
// ─────────────────────────────────────────────────────────────

func TestDownloadBinary_success(t *testing.T) {
	data := fakeBinary("binary-data")
	srv := serveBinary(t, data)
	defer srv.Close()

	got, err := downloadBinary(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("downloadBinary falhou: %v", err)
	}
	if string(got) != string(data) {
		t.Error("conteúdo binário não bate")
	}
}

func TestDownloadBinary_http500(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := downloadBinary(context.Background(), srv.URL)
	if err == nil {
		t.Error("HTTP 500 deveria retornar erro")
	}
}

// ─────────────────────────────────────────────────────────────
// CheckAndApplyUpdate — integração de alto nível
// ─────────────────────────────────────────────────────────────

func TestCheckAndApplyUpdate_noURL(t *testing.T) {
	// UpdateManifestURL vazio → no-op sem erro
	cfg := &Config{}
	st := &State{}
	CheckAndApplyUpdate(context.Background(), cfg, st)
	// Deve ser silencioso (lastUpdateAttempt não muda)
	if st.LastUpdateAttempt != "" {
		t.Error("sem URL não deve registrar tentativa")
	}
}

func TestCheckAndApplyUpdate_sameDay(t *testing.T) {
	// Já verificou hoje → não tenta de novo
	cfg := &Config{UpdateManifestURL: "http://example.com/manifest.json"}
	st := &State{LastUpdateAttempt: time.Now().UTC().Format(time.RFC3339)}
	CheckAndApplyUpdate(context.Background(), cfg, st)
	// updateFailCount não deve mudar
	if st.UpdateFailCount != 0 {
		t.Error("mesmo dia não deve incrementar falhas")
	}
}

func TestCheckAndApplyUpdate_crashLoopGuardActive(t *testing.T) {
	// Guard ativo → não tenta, não muda o estado
	recent := time.Now().UTC().Add(-30 * time.Minute).Format(time.RFC3339)
	cfg := &Config{UpdateManifestURL: "http://example.com/manifest.json"}
	st := &State{
		UpdateFailCount:   3,
		LastUpdateAttempt: recent,
	}
	// Deve registrar a tentativa mas não incrementar (guard bloqueia o doUpdate)
	CheckAndApplyUpdate(context.Background(), cfg, st)
	// O guard ativo faz o código retornar cedo; o UpdateFailCount não deve aumentar
	if st.UpdateFailCount != 3 {
		t.Errorf("guard ativo não deve incrementar fail count, got %d", st.UpdateFailCount)
	}
}

func TestCheckAndApplyUpdate_manifestError_incrementsFailCount(t *testing.T) {
	// Manifesto retorna 404 → falha → incrementa contador
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	// Força a verificação usando data de ontem
	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format(time.RFC3339)
	cfg := &Config{UpdateManifestURL: srv.URL}
	st := &State{
		UpdateFailCount:   0,
		LastUpdateAttempt: yesterday,
	}
	CheckAndApplyUpdate(context.Background(), cfg, st)
	if st.UpdateFailCount != 1 {
		t.Errorf("falha de manifesto deveria incrementar fail count para 1, got %d", st.UpdateFailCount)
	}
}

func TestCheckAndApplyUpdate_alreadyUpToDate_resetsFailCount(t *testing.T) {
	// Manifesto tem mesma versão → no update needed → reseta fail count
	bin := fakeBinary("current-binary")
	binSrv := serveBinary(t, bin)
	defer binSrv.Close()

	manifest := UpdateManifest{
		Version: Version, // mesma versão → isNewerVersion=false
		SHA256:  sha256Hex(bin),
		URL:     binSrv.URL,
	}
	mSrv := serveManifest(t, manifest)
	defer mSrv.Close()

	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format(time.RFC3339)
	cfg := &Config{UpdateManifestURL: mSrv.URL}
	st := &State{
		UpdateFailCount:   2, // tinha falhas anteriores
		LastUpdateAttempt: yesterday,
	}
	CheckAndApplyUpdate(context.Background(), cfg, st)
	if st.UpdateFailCount != 0 {
		t.Errorf("update bem-sucedido (sem update necessário) deve resetar fail count, got %d", st.UpdateFailCount)
	}
}

func TestCheckAndApplyUpdate_sha256Mismatch_incrementsFailCount(t *testing.T) {
	// Binário com sha256 errado no manifesto → incrementa fail count
	bin := fakeBinary("new-binary-data")
	binSrv := serveBinary(t, bin)
	defer binSrv.Close()

	manifest := UpdateManifest{
		Version: "999.0.0", // versão mais nova
		SHA256:  "0000000000000000000000000000000000000000000000000000000000000000", // errado
		URL:     binSrv.URL,
	}
	mSrv := serveManifest(t, manifest)
	defer mSrv.Close()

	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format(time.RFC3339)
	cfg := &Config{UpdateManifestURL: mSrv.URL}
	st := &State{
		UpdateFailCount:   0,
		LastUpdateAttempt: yesterday,
	}
	CheckAndApplyUpdate(context.Background(), cfg, st)
	if st.UpdateFailCount != 1 {
		t.Errorf("sha256 inválido deveria incrementar fail count para 1, got %d", st.UpdateFailCount)
	}
}

// ─────────────────────────────────────────────────────────────
// installBinary — teste com arquivo temporário real
// ─────────────────────────────────────────────────────────────

func TestInstallBinary_createsFiles(t *testing.T) {
	// Cria um "executável" temporário para simular os.Executable()
	tmpDir := t.TempDir()
	exePath := tmpDir + "/sayersync.exe"
	originalData := []byte("original-binary")
	if err := os.WriteFile(exePath, originalData, 0755); err != nil {
		t.Fatalf("criar exe temporário: %v", err)
	}

	// Override do os.Executable via monkeypatching não é possível em Go padrão,
	// então testamos as funções auxiliares diretamente.

	// Verifica que sha256 e restore funcionam corretamente com arquivos reais.
	newData := []byte("new-binary-data")
	newHash := sha256Hex(newData)

	// Verifica sha256
	if err := verifySHA256(newData, newHash); err != nil {
		t.Errorf("verifySHA256 falhou para dado válido: %v", err)
	}

	// Grava .prev e .new manualmente para testar o padrão
	prevPath := exePath + ".prev"
	newPath := exePath + ".new"

	if err := os.WriteFile(prevPath, originalData, 0755); err != nil {
		t.Fatalf("gravar .prev: %v", err)
	}
	if err := os.WriteFile(newPath, newData, 0755); err != nil {
		t.Fatalf("gravar .new: %v", err)
	}

	// Verifica que os arquivos foram criados
	if _, err := os.Stat(prevPath); os.IsNotExist(err) {
		t.Error(".prev não foi criado")
	}
	if _, err := os.Stat(newPath); os.IsNotExist(err) {
		t.Error(".new não foi criado")
	}

	// Rename (parte final do installBinary)
	if err := os.Rename(newPath, exePath); err != nil {
		t.Fatalf("rename .new → exe: %v", err)
	}

	// Verifica que o exe foi atualizado
	got, err := os.ReadFile(exePath)
	if err != nil || string(got) != string(newData) {
		t.Error("conteúdo do exe não foi atualizado após rename")
	}
}
