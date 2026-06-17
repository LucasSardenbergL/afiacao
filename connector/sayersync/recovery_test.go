package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// ─────────────────────────────────────────────────────────────
// restorePrevTo — restauração rename-based (F3 + fonte do rollback)
// ─────────────────────────────────────────────────────────────

func TestRestorePrevTo_renameBased(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "sayersync.exe")
	prev := target + ".prev"

	if err := os.WriteFile(target, []byte("BAD-binary"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(prev, []byte("GOOD-prev-binary"), 0755); err != nil {
		t.Fatal(err)
	}

	if err := restorePrevTo(target); err != nil {
		t.Fatalf("restorePrevTo: %v", err)
	}

	// target agora deve ter o conteúdo do .prev (bom).
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("ler target restaurado: %v", err)
	}
	if string(got) != "GOOD-prev-binary" {
		t.Errorf("target não foi restaurado: got %q, want %q", got, "GOOD-prev-binary")
	}

	// .prev foi consumido (movido para o target).
	if _, err := os.Stat(prev); !os.IsNotExist(err) {
		t.Errorf(".prev deveria ter sido movido para o target (ainda existe)")
	}

	// o binário ruim foi PRESERVADO num .bad* (diagnóstico, não apagado).
	bads, _ := filepath.Glob(target + ".bad*")
	if len(bads) == 0 {
		t.Fatalf("binário ruim deveria ter sido preservado em .bad*")
	}
	badContent, _ := os.ReadFile(bads[0])
	if string(badContent) != "BAD-binary" {
		t.Errorf(".bad deveria conter o binário ruim, got %q", badContent)
	}
}

// Codex: "If .prev is missing, rollback must not move the bad exe away first."
// Sem .prev, a função falha SEM tocar no target (não deixa o serviço sem binário).
func TestRestorePrevTo_missingPrev_leavesTargetIntact(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(target, []byte("current-binary"), 0755); err != nil {
		t.Fatal(err)
	}
	// Sem .prev.

	if err := restorePrevTo(target); err == nil {
		t.Fatal("restorePrevTo sem .prev deveria retornar erro")
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("target deveria continuar existindo: %v", err)
	}
	if string(got) != "current-binary" {
		t.Errorf("target não deveria ter sido tocado quando .prev falta, got %q", got)
	}
	// Não deixou .bad para trás.
	if bads, _ := filepath.Glob(target + ".bad*"); len(bads) != 0 {
		t.Errorf("não deveria ter criado .bad quando .prev falta: %v", bads)
	}
}

// Invariante de ORDEM (Codex): sem .prev válido, o target em uso NÃO pode ser
// movido — nem transitoriamente. Spy em renameFile pega a violação que o assert de
// resultado mascararia (o rollback-on-fail "conserta" o estado final).
func TestRestorePrevTo_missingPrev_neverMovesTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(target, []byte("current"), 0755); err != nil {
		t.Fatal(err)
	}

	var renames [][2]string
	orig := renameFile
	renameFile = func(o, n string) error { renames = append(renames, [2]string{o, n}); return orig(o, n) }
	defer func() { renameFile = orig }()

	_ = restorePrevTo(target) // erro esperado; o que importa é o que NÃO foi movido

	for _, r := range renames {
		if r[0] == target {
			t.Errorf("o target foi movido com .prev ausente (origem %q → %q) — viola a ordem do Codex", r[0], r[1])
		}
	}
}

// restorePrev() (guard interno) deve usar o caminho rename-based (F3): a impl
// antiga os.WriteFile(exe, prevData) falharia no Windows (exe em uso). Provamos
// que é rename-based pela presença do .bad — que a versão WriteFile não cria.
func TestRestorePrev_usesRenameBased(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(exe, []byte("BAD"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe+".prev", []byte("GOOD"), 0755); err != nil {
		t.Fatal(err)
	}

	orig := executablePath
	executablePath = func() (string, error) { return exe, nil }
	defer func() { executablePath = orig }()

	if err := restorePrev(); err != nil {
		t.Fatalf("restorePrev: %v", err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "GOOD" {
		t.Errorf("restorePrev não restaurou: got %q", got)
	}
	if bads, _ := filepath.Glob(exe + ".bad*"); len(bads) == 0 {
		t.Errorf("restorePrev deveria ser rename-based (nenhum .bad criado)")
	}
}

// ─────────────────────────────────────────────────────────────
// isQuarantined — pular a versão que causou rollback (F2)
// ─────────────────────────────────────────────────────────────

func TestIsQuarantined(t *testing.T) {
	st := &State{QuarantinedVersion: "1.2.3"}
	if !isQuarantined("1.2.3", st) {
		t.Error("versão igual à quarentenada deveria ser pulada")
	}
	if isQuarantined("1.2.4", st) {
		t.Error("versão diferente da quarentenada não deveria ser pulada")
	}
	if isQuarantined("1.2.3", &State{}) {
		t.Error("sem QuarantinedVersion, nada é pulado")
	}
}

// doUpdate deve PULAR a versão quarentenada já no manifesto — sem nem baixar o
// binário. (executablePath é isolado para um tmp para que, se a quarentena
// falhasse e o fluxo prosseguisse, o installBinary não tocasse o binário do
// próprio test runner.)
func TestDoUpdate_skipsQuarantinedVersion(t *testing.T) {
	bin := []byte("bad-binary-v999")
	binHits := 0
	binSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		binHits++
		_, _ = w.Write(bin)
	}))
	defer binSrv.Close()

	manifest := UpdateManifest{Version: "999.0.0", SHA256: sha256Hex(bin), URL: binSrv.URL}
	mSrv := serveManifest(t, manifest)
	defer mSrv.Close()

	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(exe, []byte("current"), 0755); err != nil {
		t.Fatal(err)
	}
	origExe := executablePath
	executablePath = func() (string, error) { return exe, nil }
	defer func() { executablePath = origExe }()

	cfg := &Config{UpdateManifestURL: mSrv.URL}
	st := &State{QuarantinedVersion: "999.0.0"}

	installed, err := doUpdate(context.Background(), cfg, st)
	if err != nil {
		t.Fatalf("doUpdate: %v", err)
	}
	if installed {
		t.Error("não deveria instalar versão quarentenada")
	}
	if binHits != 0 {
		t.Errorf("não deveria baixar binário quarentenado: %d hits", binHits)
	}
}

// Ao instalar com sucesso, doUpdate registra a versão em PendingUpdateVersion
// (para o rollback saber o que quarentenar) e limpa qualquer quarentena anterior
// (a nova versão supera a ruim passada).
func TestDoUpdate_setsPendingVersionAndClearsQuarantine(t *testing.T) {
	bin := []byte("good-binary-v2")
	binSrv := serveBinary(t, bin)
	defer binSrv.Close()

	manifest := UpdateManifest{Version: "2.0.0", SHA256: sha256Hex(bin), URL: binSrv.URL}
	mSrv := serveManifest(t, manifest)
	defer mSrv.Close()

	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(exe, []byte("v1-current"), 0755); err != nil {
		t.Fatal(err)
	}
	origExe := executablePath
	executablePath = func() (string, error) { return exe, nil }
	defer func() { executablePath = origExe }()

	cfg := &Config{UpdateManifestURL: mSrv.URL}
	st := &State{QuarantinedVersion: "1.0.0"} // quarentena antiga, de outra versão

	installed, err := doUpdate(context.Background(), cfg, st)
	if err != nil {
		t.Fatalf("doUpdate: %v", err)
	}
	if !installed {
		t.Fatal("deveria ter instalado a 2.0.0")
	}
	if st.PendingUpdateVersion != "2.0.0" {
		t.Errorf("PendingUpdateVersion = %q, want 2.0.0", st.PendingUpdateVersion)
	}
	if st.QuarantinedVersion != "" {
		t.Errorf("instalar versão nova deveria limpar a quarentena antiga, got %q", st.QuarantinedVersion)
	}
}

// ─────────────────────────────────────────────────────────────
// doRollback — ator externo: restaura .prev + quarentena + reinicia (F2)
// ─────────────────────────────────────────────────────────────

func TestDoRollback_restoresQuarantinesAndRestarts(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(exe, []byte("BAD-v999"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe+".prev", []byte("GOOD-v2"), 0755); err != nil {
		t.Fatal(err)
	}

	// state.json no tmp, com a versão ruim "pendente" (que estava sendo ativada).
	origStateDir := stateDir
	stateDir = func() string { return dir }
	defer func() { stateDir = origStateDir }()
	if err := SaveState(&State{
		PendingUpdateVersion: "999.0.0",
		UpdateFailCount:      2,
		LastUpdateFailure:    "2026-01-01T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}

	// Não inicia serviço real no teste; só registra que foi chamado.
	started := false
	origStart := startRecoveredService
	startRecoveredService = func() error { started = true; return nil }
	defer func() { startRecoveredService = origStart }()

	if err := doRollback(exe); err != nil {
		t.Fatalf("doRollback: %v", err)
	}

	// 1. binário restaurado (rename-based).
	if got, _ := os.ReadFile(exe); string(got) != "GOOD-v2" {
		t.Errorf("exe não restaurado: got %q", got)
	}
	// 2. a versão ruim foi quarentenada; pending limpo; guard resetado.
	st, _ := LoadState()
	if st.QuarantinedVersion != "999.0.0" {
		t.Errorf("QuarantinedVersion = %q, want 999.0.0", st.QuarantinedVersion)
	}
	if st.PendingUpdateVersion != "" {
		t.Errorf("PendingUpdateVersion deveria ser limpo, got %q", st.PendingUpdateVersion)
	}
	if st.UpdateFailCount != 0 {
		t.Errorf("UpdateFailCount deveria resetar, got %d", st.UpdateFailCount)
	}
	// 3. serviço reiniciado (run_command do SCM não reinicia sozinho).
	if !started {
		t.Error("doRollback deveria reiniciar o serviço")
	}
}

// Codex P1: restaurar o binário e reiniciar são PRIMARY; a quarentena é best-effort.
// Um state.json corrompido não pode bloquear a recuperação de um crash-loop.
func TestDoRollback_corruptStateStillRestoresAndRestarts(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(exe, []byte("BAD"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe+".prev", []byte("GOOD"), 0755); err != nil {
		t.Fatal(err)
	}

	origStateDir := stateDir
	stateDir = func() string { return dir }
	defer func() { stateDir = origStateDir }()
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte("{not valid json"), 0600); err != nil {
		t.Fatal(err)
	}

	started := false
	origStart := startRecoveredService
	startRecoveredService = func() error { started = true; return nil }
	defer func() { startRecoveredService = origStart }()

	if err := doRollback(exe); err != nil {
		t.Fatalf("doRollback não deveria falhar por state corrompido: %v", err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "GOOD" {
		t.Errorf("restore deveria acontecer apesar do state corrompido: got %q", got)
	}
	if !started {
		t.Error("serviço deveria reiniciar apesar do state corrompido")
	}
	// Auto-cura: o state.json corrompido deve ter sido resetado para o conector se
	// recuperar nos próximos ciclos (LoadState volta a funcionar). (Codex P2)
	if _, err := LoadState(); err != nil {
		t.Errorf("state.json deveria ter sido resetado, mas LoadState ainda falha: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────
// buildRollbackCommand — lpCommand do SC_ACTION_RUN_COMMAND (F2)
// ─────────────────────────────────────────────────────────────

func TestBuildRollbackCommand_absoluteQuotedNoEscape(t *testing.T) {
	recovery := `C:\Program Files\sayer\sayersync-recovery.exe`
	target := `C:\Program Files\sayer\sayersync.exe`
	got := buildRollbackCommand(recovery, target)
	want := `"C:\Program Files\sayer\sayersync-recovery.exe" rollback --target "C:\Program Files\sayer\sayersync.exe"`
	if got != want {
		t.Errorf("buildRollbackCommand =\n  %s\nwant\n  %s", got, want)
	}
}

func TestParseTargetFlag(t *testing.T) {
	if got := parseTargetFlag([]string{"rollback", "--target", `C:\x\sayersync.exe`}); got != `C:\x\sayersync.exe` {
		t.Errorf("got %q, want C:\\x\\sayersync.exe", got)
	}
	if got := parseTargetFlag([]string{"rollback"}); got != "" {
		t.Errorf("sem flag deveria ser vazio, got %q", got)
	}
	if got := parseTargetFlag([]string{"rollback", "--target"}); got != "" {
		t.Errorf("--target sem valor deveria ser vazio, got %q", got)
	}
}

// ─────────────────────────────────────────────────────────────
// ensureRecoveryCopy — cópia estável que atua no rollback (F2)
// ─────────────────────────────────────────────────────────────

func TestEnsureRecoveryCopy_createsStableCopy(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(exe, []byte("BINARY-V2"), 0755); err != nil {
		t.Fatal(err)
	}

	if got := recoveryExePath(exe); got != filepath.Join(dir, recoveryExeName) {
		t.Errorf("recoveryExePath = %q, want %q", got, filepath.Join(dir, recoveryExeName))
	}

	if err := ensureRecoveryCopy(exe); err != nil {
		t.Fatalf("ensureRecoveryCopy: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dir, recoveryExeName))
	if err != nil {
		t.Fatalf("recovery-copy não criada: %v", err)
	}
	if string(got) != "BINARY-V2" {
		t.Errorf("recovery-copy = %q, want BINARY-V2", got)
	}
}

func TestRecoveryCopyHealthy(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if recoveryCopyHealthy(exe) {
		t.Error("sem recovery-copy deveria ser unhealthy")
	}
	if err := os.WriteFile(recoveryExePath(exe), []byte("actor"), 0755); err != nil {
		t.Fatal(err)
	}
	if !recoveryCopyHealthy(exe) {
		t.Error("recovery-copy não-vazia deveria ser healthy")
	}
	if err := os.WriteFile(recoveryExePath(exe), nil, 0755); err != nil {
		t.Fatal(err)
	}
	if recoveryCopyHealthy(exe) {
		t.Error("recovery-copy vazia deveria ser unhealthy")
	}
}

// Codex P2: a recovery-copy é o ATOR estável; um repair (ex.: no service start, já
// com um binário novo rodando) NÃO pode sobrescrevê-la com um binário não-comprovado.
func TestEnsureRecoveryCopy_preservesExistingActor(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(exe, []byte("NEW-UNPROVEN-BINARY"), 0755); err != nil {
		t.Fatal(err)
	}
	rec := recoveryExePath(exe)
	if err := os.WriteFile(rec, []byte("OLD-GOOD-ACTOR"), 0755); err != nil {
		t.Fatal(err)
	}

	if err := ensureRecoveryCopy(exe); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(rec); string(got) != "OLD-GOOD-ACTOR" {
		t.Errorf("ensureRecoveryCopy sobrescreveu o ator estável: got %q", got)
	}
}

// Codex P1: o `install` deliberado DEVE refrescar o ator — um balcão com uma
// recovery-copy velha/bugada precisa poder atualizá-la re-rodando install.
func TestRefreshRecoveryCopy_overwritesExistingActor(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(exe, []byte("NEW-FIXED-BINARY"), 0755); err != nil {
		t.Fatal(err)
	}
	rec := recoveryExePath(exe)
	if err := os.WriteFile(rec, []byte("OLD-BUGGY-ACTOR"), 0755); err != nil {
		t.Fatal(err)
	}

	if err := refreshRecoveryCopy(exe); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(rec); string(got) != "NEW-FIXED-BINARY" {
		t.Errorf("refreshRecoveryCopy não atualizou o ator: got %q", got)
	}
}

// ─────────────────────────────────────────────────────────────
// Gate F5 — não ativa update sem rede de recuperação
// ─────────────────────────────────────────────────────────────

func TestDoUpdate_skipsWhenRecoveryUnconfigurable(t *testing.T) {
	bin := []byte("new-binary-v5")
	binHits := 0
	binSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		binHits++
		_, _ = w.Write(bin)
	}))
	defer binSrv.Close()

	manifest := UpdateManifest{Version: "5.0.0", SHA256: sha256Hex(bin), URL: binSrv.URL}
	mSrv := serveManifest(t, manifest)
	defer mSrv.Close()

	dir := t.TempDir()
	exe := filepath.Join(dir, "sayersync.exe")
	if err := os.WriteFile(exe, []byte("current"), 0755); err != nil {
		t.Fatal(err)
	}
	origExe := executablePath
	executablePath = func() (string, error) { return exe, nil }
	defer func() { executablePath = origExe }()

	// Recovery não configurado E o reparo falha (ex.: sem permissão no SCM).
	origV, origC := verifyServiceRecovery, configureServiceRecovery
	verifyServiceRecovery = func(string) (bool, error) { return false, nil }
	configureServiceRecovery = func(string) error { return errors.New("sem acesso ao SCM") }
	defer func() { verifyServiceRecovery, configureServiceRecovery = origV, origC }()

	cfg := &Config{UpdateManifestURL: mSrv.URL}
	st := &State{}
	installed, err := doUpdate(context.Background(), cfg, st)

	if err == nil {
		t.Error("doUpdate deveria falhar quando não há rede de recuperação")
	}
	if installed {
		t.Error("não deveria instalar sem rede de recuperação")
	}
	if binHits != 0 {
		t.Errorf("não deveria nem baixar sem rede de recuperação: %d hits", binHits)
	}
}
