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
	"path/filepath"
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
	// 3 falhas mas última FALHA foi há mais de 24h → guard inativo
	old := time.Now().UTC().Add(-25 * time.Hour).Format(time.RFC3339)
	st := &State{
		UpdateFailCount:   3,
		LastUpdateFailure: old,
	}
	if isCrashLoopGuardActive(st) {
		t.Error("falhas antigas (>24h) não devem ativar o guard")
	}
}

func TestCrashLoopGuard_active(t *testing.T) {
	recent := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	st := &State{
		UpdateFailCount:   3,
		LastUpdateFailure: recent,
	}
	if !isCrashLoopGuardActive(st) {
		t.Error("3 falhas recentes devem ativar o guard")
	}
}

func TestCrashLoopGuard_emptyAttempt(t *testing.T) {
	st := &State{UpdateFailCount: 3}
	// Sem LastUpdateFailure → guard inativo (não temos janela de referência)
	if isCrashLoopGuardActive(st) {
		t.Error("sem LastUpdateFailure o guard deve estar inativo")
	}
}

// TestCrashLoopGuard_windowExpiresDespiteRenewedAttempt é a regressão do P2:
// a janela de 24h DEVE envelhecer a partir da última FALHA real, não de
// LastUpdateAttempt (que o throttle diário renova para "agora" em toda passagem,
// inclusive nos dias em que o guard pula a tentativa). Sem isso, a janela nunca
// expirava → 3 falhas transitórias = updates desligados PARA SEMPRE.
func TestCrashLoopGuard_windowExpiresDespiteRenewedAttempt(t *testing.T) {
	st := &State{
		UpdateFailCount:   3,
		LastUpdateFailure: time.Now().UTC().Add(-25 * time.Hour).Format(time.RFC3339), // falha há 25h → janela expirou
		LastUpdateAttempt: time.Now().UTC().Format(time.RFC3339),                      // renovado HOJE (a condição do bug)
	}
	if isCrashLoopGuardActive(st) {
		t.Error("janela deve expirar pela última falha (25h atrás), mesmo com LastUpdateAttempt renovado hoje")
	}
}

// TestCrashLoopGuard_activeWithinFailureWindow: falha recente (<24h) mantém o
// guard ativo, independentemente de LastUpdateAttempt.
func TestCrashLoopGuard_activeWithinFailureWindow(t *testing.T) {
	st := &State{
		UpdateFailCount:   3,
		LastUpdateFailure: time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339), // falha há 1h → dentro da janela
		LastUpdateAttempt: time.Now().UTC().Format(time.RFC3339),
	}
	if !isCrashLoopGuardActive(st) {
		t.Error("falha recente (<24h) deve manter o guard ativo")
	}
}

// TestCrashLoopGuard_futureFailureTimestampFailsOpen é a regressão do Codex F8:
// um LastUpdateFailure no FUTURO (clock skew / state corrompido) torna time.Since
// negativo e mantinha o guard ativo até esse instante + 24h — pausando updates por
// tempo indefinido. Deve falhar ABERTO (guard inativo), não pausar.
func TestCrashLoopGuard_futureFailureTimestampFailsOpen(t *testing.T) {
	st := &State{
		UpdateFailCount:   3,
		LastUpdateFailure: time.Now().UTC().Add(48 * time.Hour).Format(time.RFC3339), // 48h no futuro
	}
	if isCrashLoopGuardActive(st) {
		t.Error("timestamp de falha no futuro deve falhar aberto (guard inativo), não pausar updates indefinidamente")
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

// TestCheckAndApplyUpdate_disabledInProcess_skips: o gate do `once` (Codex F6/F7).
// Com autoUpdateEnabled=false o auto-update é no-op total mesmo com manifesto válido
// e versão mais nova: nada instala, nada reinicia, e retorna ANTES do throttle.
func TestCheckAndApplyUpdate_disabledInProcess_skips(t *testing.T) {
	orig := autoUpdateEnabled
	autoUpdateEnabled = false
	t.Cleanup(func() { autoUpdateEnabled = orig })

	exePath := withFakeExe(t, "OLD")
	restartCalls := withRecordedRestart(t)
	manifestURL := serveUpdate(t, "999.0.0", []byte("NEW"))

	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format(time.RFC3339)
	cfg := &Config{UpdateManifestURL: manifestURL}
	st := &State{LastUpdateAttempt: yesterday}
	CheckAndApplyUpdate(context.Background(), cfg, st)

	if got, _ := os.ReadFile(exePath); string(got) != "OLD" {
		t.Errorf("desabilitado não deve instalar; exe got %q", got)
	}
	if *restartCalls != 0 {
		t.Errorf("desabilitado não deve reiniciar, got %d", *restartCalls)
	}
	if st.LastUpdateAttempt != yesterday {
		t.Errorf("desabilitado deve retornar antes do throttle; LastUpdateAttempt virou %q", st.LastUpdateAttempt)
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
	// Throttle passa (última tentativa ontem), mas o guard (falha há 30min, <24h)
	// bloqueia o doUpdate. URL inalcançável: se o guard NÃO bloquear, doUpdate
	// falha e incrementa o contador — a regressão seria pega aqui.
	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format(time.RFC3339)
	recentFailure := time.Now().UTC().Add(-30 * time.Minute).Format(time.RFC3339)
	cfg := &Config{UpdateManifestURL: "http://127.0.0.1:1/manifest.json"}
	st := &State{
		UpdateFailCount:   3,
		LastUpdateFailure: recentFailure,
		LastUpdateAttempt: yesterday,
	}
	CheckAndApplyUpdate(context.Background(), cfg, st)
	// O guard ativo faz o doUpdate ser pulado; o UpdateFailCount não deve aumentar.
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
		Version: "999.0.0",                                                          // versão mais nova
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

// withRecordedRestart troca restartService por um contador (evita o os.Exit real)
// e o restaura no fim do teste. Devolve um ponteiro para a contagem de chamadas.
func withRecordedRestart(t *testing.T) *int {
	t.Helper()
	calls := 0
	orig := restartService
	restartService = func() { calls++ }
	t.Cleanup(func() { restartService = orig })
	return &calls
}

// serveUpdate serve um manifesto (versão muito nova) + o binário correspondente,
// com sha256 válido. Devolve a URL do manifesto.
func serveUpdate(t *testing.T, version string, binary []byte) string {
	t.Helper()
	binSrv := serveBinary(t, binary)
	t.Cleanup(binSrv.Close)
	mSrv := serveManifest(t, UpdateManifest{Version: version, SHA256: sha256Hex(binary), URL: binSrv.URL})
	t.Cleanup(mSrv.Close)
	return mSrv.URL
}

// TestCheckAndApplyUpdate_installsAndRestarts é o happy-path ponta-a-ponta:
// manifesto com versão mais nova → download → sha256 ok → installBinary coloca o
// novo binário → restartService é sinalizado exatamente uma vez → guard zerado.
func TestCheckAndApplyUpdate_installsAndRestarts(t *testing.T) {
	exePath := withFakeExe(t, "OLD-running-binary")
	restartCalls := withRecordedRestart(t)

	newData := []byte("NEW-binary-content")
	manifestURL := serveUpdate(t, "999.0.0", newData)

	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format(time.RFC3339)
	cfg := &Config{UpdateManifestURL: manifestURL}
	st := &State{UpdateFailCount: 2, LastUpdateFailure: yesterday, LastUpdateAttempt: yesterday}

	CheckAndApplyUpdate(context.Background(), cfg, st)

	if got, _ := os.ReadFile(exePath); string(got) != string(newData) {
		t.Errorf("exe deve ter o binário novo, got %q", got)
	}
	if got, _ := os.ReadFile(exePath + ".prev"); string(got) != "OLD-running-binary" {
		t.Errorf(".prev deve ter o binário antigo, got %q", got)
	}
	if *restartCalls != 1 {
		t.Errorf("restartService deve ser chamado 1×, got %d", *restartCalls)
	}
	if st.UpdateFailCount != 0 || st.LastUpdateFailure != "" {
		t.Errorf("sucesso deve zerar o guard: count=%d failure=%q", st.UpdateFailCount, st.LastUpdateFailure)
	}
}

// TestCheckAndApplyUpdate_guardExpires_retriesUpdate é o P2 ponta-a-ponta: 3
// falhas mas a última foi há >24h → janela expirou → o guard NÃO bloqueia → a
// tentativa volta a rodar e (aqui) conclui com sucesso. Sem o fix do P2 o guard
// continuaria ativo para sempre e nada disto rodaria.
func TestCheckAndApplyUpdate_guardExpires_retriesUpdate(t *testing.T) {
	exePath := withFakeExe(t, "OLD")
	restartCalls := withRecordedRestart(t)

	manifestURL := serveUpdate(t, "999.0.0", []byte("NEW"))

	cfg := &Config{UpdateManifestURL: manifestURL}
	st := &State{
		UpdateFailCount:   3,
		LastUpdateFailure: time.Now().UTC().Add(-25 * time.Hour).Format(time.RFC3339), // janela expirou
		LastUpdateAttempt: time.Now().UTC().AddDate(0, 0, -1).Format(time.RFC3339),    // throttle passa
	}
	CheckAndApplyUpdate(context.Background(), cfg, st)

	if got, _ := os.ReadFile(exePath); string(got) != "NEW" {
		t.Errorf("a tentativa deve voltar a rodar e instalar o novo binário, got %q", got)
	}
	if st.UpdateFailCount != 0 {
		t.Errorf("após janela expirar e update OK, fail count deve zerar, got %d", st.UpdateFailCount)
	}
	if *restartCalls != 1 {
		t.Errorf("restartService deve ser chamado 1× após o install, got %d", *restartCalls)
	}
}

// TestCheckAndApplyUpdate_persistsStateBeforeRestart é a regressão do Codex F1:
// o os.Exit do restart pula o SaveState gated do RunCycle, então o install-success
// DEVE persistir o state ANTES de reiniciar. Senão, após o restart o throttle ainda
// aponta para ontem e um binário publicado com versão errada (ex.: build sem ldflag
// → "dev", que isNewerVersion considera sempre mais antigo que qualquer release)
// vira loop install→restart no mesmo dia. Recarregamos do disco (= o que o binário
// pós-restart enxergaria) e exigimos que já esteja "checado hoje".
func TestCheckAndApplyUpdate_persistsStateBeforeRestart(t *testing.T) {
	withFakeExe(t, "OLD")
	withRecordedRestart(t)
	manifestURL := serveUpdate(t, "999.0.0", []byte("NEW"))

	cfg := &Config{UpdateManifestURL: manifestURL}
	st := &State{LastUpdateAttempt: time.Now().UTC().AddDate(0, 0, -1).Format(time.RFC3339)}
	CheckAndApplyUpdate(context.Background(), cfg, st)

	reloaded, err := LoadState()
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if shouldCheckUpdate(reloaded) {
		t.Error("após install+restart o state persistido deve marcar 'checado hoje' — senão vira loop install→restart no mesmo dia")
	}
}

// ─────────────────────────────────────────────────────────────
// installBinary — chamadas reais via o seam executablePath
// ─────────────────────────────────────────────────────────────

// withFakeExe aponta o seam executablePath para um exe temporário e devolve o
// caminho. Restaura o seam no fim do teste.
func withFakeExe(t *testing.T, content string) string {
	t.Helper()
	exePath := filepath.Join(t.TempDir(), "sayersync.exe")
	if err := os.WriteFile(exePath, []byte(content), 0755); err != nil {
		t.Fatalf("criar exe temporário: %v", err)
	}
	orig := executablePath
	executablePath = func() (string, error) { return exePath, nil }
	t.Cleanup(func() { executablePath = orig })

	// state.json vive ao lado do exe em produção; aponta o stateDir para o tmpdir
	// para SaveState/LoadState não tocarem o diretório real do executável.
	dir := filepath.Dir(exePath)
	origSD := stateDir
	stateDir = func() string { return dir }
	t.Cleanup(func() { stateDir = origSD })

	return exePath
}

// TestInstallBinary_movesAsideThenPlaces é o cerne do P1: o backup do exe atual
// para .prev tem que ser um MOVE (rename do exe em execução), não uma cópia, e o
// novo binário entra DEPOIS — quando o destino já não existe. Sem isso, o
// os.Rename sobre o exe em uso falha no Windows (sharing violation).
//
// os.SameFile distingue MOVE de CÓPIA: se .prev for o exe original renomeado,
// compartilha a identidade de arquivo; se for uma cópia (ReadFile+WriteFile),
// não. O estado final no disco é idêntico nos dois casos no Unix, então só a
// identidade do arquivo prova a sequência.
func TestInstallBinary_movesAsideThenPlaces(t *testing.T) {
	oldData := "OLD-running-binary"
	exePath := withFakeExe(t, oldData)
	beforeFI, err := os.Stat(exePath)
	if err != nil {
		t.Fatal(err)
	}

	newData := []byte("NEW-binary-content")
	if err := installBinary(newData); err != nil {
		t.Fatalf("installBinary falhou: %v", err)
	}

	if got, _ := os.ReadFile(exePath); string(got) != string(newData) {
		t.Errorf("exePath deve conter o binário novo, got %q", got)
	}

	prevPath := exePath + ".prev"
	prevFI, err := os.Stat(prevPath)
	if err != nil {
		t.Fatalf(".prev não existe: %v", err)
	}
	if !os.SameFile(beforeFI, prevFI) {
		t.Error(".prev deve ser o exe original MOVIDO (mesma identidade), não uma cópia — senão o rename sobre o exe em uso falha no Windows")
	}
	if got, _ := os.ReadFile(prevPath); string(got) != oldData {
		t.Errorf(".prev deve ter o conteúdo do exe antigo, got %q", got)
	}
	if _, err := os.Stat(exePath + ".new"); !os.IsNotExist(err) {
		t.Error(".new não deve sobrar após o install (foi renomeado para o exe)")
	}
}

// TestInstallBinary_overwritesStalePrev: um .prev obsoleto de um update anterior
// deve ser substituído pelo exe que estava em execução (os.Rename é REPLACE_EXISTING).
func TestInstallBinary_overwritesStalePrev(t *testing.T) {
	exePath := withFakeExe(t, "V2-running")
	if err := os.WriteFile(exePath+".prev", []byte("V1-stale"), 0755); err != nil {
		t.Fatal(err)
	}

	if err := installBinary([]byte("V3-new")); err != nil {
		t.Fatalf("installBinary falhou: %v", err)
	}
	if got, _ := os.ReadFile(exePath); string(got) != "V3-new" {
		t.Errorf("exe deve ter V3-new, got %q", got)
	}
	if got, _ := os.ReadFile(exePath + ".prev"); string(got) != "V2-running" {
		t.Errorf(".prev deve conter V2-running (substituindo o V1 obsoleto), got %q", got)
	}
}

// TestInstallBinary_rollsBackOnPlaceFailure: se "colocar o novo binário" (rename
// .new → exe) falhar APÓS mover o exe atual para .prev, o install deve devolver o
// exe original ao exePath — senão o serviço ficaria sem binário no caminho.
func TestInstallBinary_rollsBackOnPlaceFailure(t *testing.T) {
	oldData := "OLD-running-binary"
	exePath := withFakeExe(t, oldData)

	origRename := renameFile
	calls := 0
	renameFile = func(oldpath, newpath string) error {
		calls++
		if calls == 2 { // 1 = move-aside (exe→.prev); 2 = place (.new→exe)
			return fmt.Errorf("erro simulado no place")
		}
		return origRename(oldpath, newpath)
	}
	defer func() { renameFile = origRename }()

	if err := installBinary([]byte("NEW-binary-content")); err == nil {
		t.Fatal("installBinary deveria retornar erro quando o place falha")
	}
	got, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("exePath sumiu após rollback (serviço ficaria sem binário!): %v", err)
	}
	if string(got) != oldData {
		t.Errorf("rollback deve devolver o exe antigo ao exePath, got %q", got)
	}
}
