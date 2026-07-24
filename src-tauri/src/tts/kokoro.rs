// Kokoro local voices via sherpa-onnx — the second fully-offline neural
// engine, a clear quality step up from Piper. One model bundle serves all
// voices (~330 MB); the engine is the sherpa-onnx offline-tts CLI (~25 MB
// download, MT build: no VC++ runtime needed). Same spawned-process pattern
// as Piper: WAV per sentence into the shared cache.
//
// Unlike Piper there is no warm-worker path to prefer: sherpa-onnx's
// offline-tts CLI takes the text as its single positional argument, generates
// one file, and exits ("Error: Accept only one positional argument."). It has
// no stdin loop, no file-of-lines input and no repeatable --output-filename, so
// one process can only ever produce one utterance and the model load cannot be
// amortized across sentences. What this module can control is how expensive
// that unavoidable reload is: `MAX_*`/`threads_per_process` keep at most two
// model loads resident at once and size each process's thread pool so those two
// together never oversubscribe the machine.

use super::VoiceInfo;
use crate::error::{AppError, Result};
use crate::paths::{ensure_dir, voices_dir};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const ENGINE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-win-x64-shared-MT-Release.tar.bz2";
const ENGINE_ARCHIVE: &str = "sherpa-onnx-v1.13.4-win-x64-shared-MT-Release.tar.bz2";
/// The archive's top-level directory (renamed to a stable name on install).
const ENGINE_EXTRACTED_DIR: &str = "sherpa-onnx-v1.13.4-win-x64-shared-MT-Release";
const ENGINE_SIZE_MB: u32 = 25;

const MODEL_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2";
const MODEL_ARCHIVE: &str = "kokoro-en-v0_19.tar.bz2";
const MODEL_EXTRACTED_DIR: &str = "kokoro-en-v0_19";
const MODEL_SIZE_MB: u32 = 330;

const SYNTH_TIMEOUT: Duration = Duration::from_secs(120);

/// Kokoro v0.19 speakers: (voice id, display name, sherpa speaker id, gender).
pub const CATALOG: &[(&str, &str, u32, &str)] = &[
    ("af_default", "Aria (US)", 0, "Female"),
    ("af_bella", "Bella (US)", 1, "Female"),
    ("af_nicole", "Nicole (US)", 2, "Female"),
    ("af_sarah", "Sarah (US)", 3, "Female"),
    ("af_sky", "Sky (US)", 4, "Female"),
    ("am_adam", "Adam (US)", 5, "Male"),
    ("am_michael", "Michael (US)", 6, "Male"),
    ("bf_emma", "Emma (UK)", 7, "Female"),
    ("bf_isabella", "Isabella (UK)", 8, "Female"),
    ("bm_george", "George (UK)", 9, "Male"),
    ("bm_lewis", "Lewis (UK)", 10, "Male"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroVoice {
    pub id: String,
    pub name: String,
    pub gender: String,
    pub locale: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroStatus {
    pub engine_installed: bool,
    #[serde(rename = "engineSizeMB")]
    pub engine_size_mb: u32,
    pub model_installed: bool,
    #[serde(rename = "modelSizeMB")]
    pub model_size_mb: u32,
    pub voices: Vec<KokoroVoice>,
}

fn kokoro_root() -> PathBuf {
    voices_dir().join("kokoro")
}

fn engine_dir() -> PathBuf {
    kokoro_root().join("engine")
}

fn engine_exe() -> PathBuf {
    engine_dir().join("bin").join("sherpa-onnx-offline-tts.exe")
}

fn model_dir() -> PathBuf {
    kokoro_root().join(MODEL_EXTRACTED_DIR)
}

fn model_installed() -> bool {
    let d = model_dir();
    std::fs::metadata(d.join("model.onnx")).map(|m| m.len() > 0).unwrap_or(false)
        && d.join("voices.bin").exists()
        && d.join("tokens.txt").exists()
}

fn sid_for(voice_id: &str) -> Option<u32> {
    CATALOG.iter().find(|(id, ..)| *id == voice_id).map(|(_, _, sid, _)| *sid)
}

/// Extract a .tar.bz2 with the OS bsdtar (ships with Windows 10 1803+).
/// Args as an array — never a shell string.
fn extract_tar_bz2(archive: &Path, dest: &Path) -> Result<()> {
    ensure_dir(dest)?;
    let mut cmd = Command::new("tar");
    cmd.arg("-xjf")
        .arg(archive)
        .arg("-C")
        .arg(dest)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let status = cmd
        .status()
        .map_err(|_| AppError::msg("Could not unpack the download (tar unavailable)"))?;
    if !status.success() {
        return Err(AppError::msg("Could not unpack the download"));
    }
    Ok(())
}

#[tauri::command]
pub async fn kokoro_status() -> Result<KokoroStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(KokoroStatus {
            engine_installed: engine_exe().exists(),
            engine_size_mb: ENGINE_SIZE_MB,
            model_installed: model_installed(),
            model_size_mb: MODEL_SIZE_MB,
            voices: CATALOG
                .iter()
                .map(|(id, name, _, gender)| KokoroVoice {
                    id: (*id).to_string(),
                    name: (*name).to_string(),
                    gender: (*gender).to_string(),
                    locale: if id.starts_with('b') { "en-GB" } else { "en-US" }.to_string(),
                })
                .collect(),
        })
    })
    .await
    .map_err(|e| AppError::wrap("Kokoro status task", e))?
}

#[tauri::command]
pub async fn kokoro_install_engine(app: AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if engine_exe().exists() {
            return Ok(());
        }
        let root = kokoro_root();
        ensure_dir(&root)?;
        let archive = root.join(ENGINE_ARCHIVE);
        crate::downloads::download_with_progress(
            &app,
            "kokoro-engine",
            "Kokoro engine",
            ENGINE_URL,
            &archive,
        )?;
        extract_tar_bz2(&archive, &root)?;
        let _ = std::fs::remove_file(&archive);
        // Stable path: rename the versioned top-level dir to "engine".
        let extracted = root.join(ENGINE_EXTRACTED_DIR);
        if extracted.exists() {
            let _ = std::fs::remove_dir_all(engine_dir());
            std::fs::rename(&extracted, engine_dir())
                .map_err(|e| AppError::wrap("Could not finish the engine install", e))?;
        }
        if !engine_exe().exists() {
            return Err(AppError::msg("The Kokoro engine download looked incomplete"));
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::wrap("Install task", e))?
}

#[tauri::command]
pub async fn kokoro_install_model(app: AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if model_installed() {
            return Ok(());
        }
        let root = kokoro_root();
        ensure_dir(&root)?;
        let archive = root.join(MODEL_ARCHIVE);
        crate::downloads::download_with_progress(
            &app,
            "kokoro-model",
            "Kokoro voices",
            MODEL_URL,
            &archive,
        )?;
        extract_tar_bz2(&archive, &root)?;
        let _ = std::fs::remove_file(&archive);
        if !model_installed() {
            return Err(AppError::msg("The Kokoro voices download looked incomplete"));
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::wrap("Install task", e))?
}

#[tauri::command]
pub async fn kokoro_remove() -> Result<()> {
    tauri::async_runtime::spawn_blocking(|| {
        match std::fs::remove_dir_all(kokoro_root()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::wrap("Could not remove Kokoro", e)),
        }
    })
    .await
    .map_err(|e| AppError::wrap("Remove task", e))?
}

/// Concurrent Kokoro processes allowed on a machine with enough cores to
/// overlap one process's model load with another's inference. Two is the
/// ceiling on purpose: every process holds the whole ~330 MB bundle for its
/// lifetime, and a precache job running alongside playback prefetch would
/// otherwise stack four resident models — well over a gigabyte.
const MAX_CONCURRENT_SYNTHS: usize = 2;
/// Inference threads never exceed this per process; Kokoro stops scaling past
/// it and the extra threads only add contention.
const MAX_THREADS_PER_SYNTH: usize = 4;

/// Logical processors, with a conservative guess when the count is unavailable.
fn cpu_count() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2)
}

/// How many Kokoro processes may run at once for a given core count. Machines
/// too small to overlap two model loads run one at a time instead of thrashing.
fn max_concurrent(cores: usize) -> usize {
    if cores >= 4 {
        MAX_CONCURRENT_SYNTHS
    } else {
        1
    }
}

/// Thread pool size for one process, sized so `concurrency` of them together
/// stay within the machine rather than oversubscribing it.
fn threads_per_process(cores: usize, concurrency: usize) -> usize {
    (cores / concurrency.max(1)).clamp(1, MAX_THREADS_PER_SYNTH)
}

/// Poll cadence while waiting on a child: tight at first so a short sentence
/// returns promptly, then relaxed so a multi-second synthesis costs a handful
/// of wakeups rather than hundreds.
fn poll_interval(waited: Duration) -> Duration {
    if waited < Duration::from_millis(250) {
        Duration::from_millis(5)
    } else {
        Duration::from_millis(25)
    }
}

/// A WAV with nothing but its 44-byte header carries no audio.
fn wav_has_audio(len: u64) -> bool {
    len > 44
}

/// Collapse CR/LF so the text stays the ONE positional argument the CLI
/// accepts, and keep it from being mistaken for a flag: sherpa-onnx parses any
/// argument starting with "--" as an option, so a sentence opening with a
/// double dash would abort the run. A leading space is inaudible.
fn positional_text(text: &str) -> String {
    let line = text.replace(['\r', '\n'], " ");
    if line.starts_with("--") {
        format!(" {line}")
    } else {
        line
    }
}

/// Every argument after the executable, as its own argv element — spaces and
/// backslashes in Windows paths therefore need no quoting and no shell is
/// involved. Kept pure so the exact flag set stays unit-testable.
fn synth_args(model: &Path, sid: u32, threads: usize, out: &Path, text: &str) -> Vec<String> {
    vec![
        format!("--kokoro-model={}", model.join("model.onnx").display()),
        format!("--kokoro-voices={}", model.join("voices.bin").display()),
        format!("--kokoro-tokens={}", model.join("tokens.txt").display()),
        format!("--kokoro-data-dir={}", model.join("espeak-ng-data").display()),
        format!("--num-threads={threads}"),
        format!("--sid={sid}"),
        format!("--output-filename={}", out.display()),
        positional_text(text),
    ]
}

/// Counts the Kokoro processes currently alive and blocks anyone who would push
/// the total past the limit. Callers hold a permit for exactly the child's
/// lifetime, so the count tracks resident model bundles one-for-one.
struct Gate {
    live: Mutex<usize>,
    slot_freed: Condvar,
}

impl Gate {
    const fn new() -> Self {
        Gate { live: Mutex::new(0), slot_freed: Condvar::new() }
    }

    /// Wait for a free slot and take it. Every holder releases within
    /// SYNTH_TIMEOUT (the wait loop kills a child that overruns) and the guard
    /// releases on every return path, so this cannot wedge.
    fn acquire(&self, limit: usize) -> GateGuard<'_> {
        let limit = limit.max(1);
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        while *live >= limit {
            live = self.slot_freed.wait(live).unwrap_or_else(|e| e.into_inner());
        }
        *live += 1;
        GateGuard { gate: self }
    }

    #[cfg(test)]
    fn live(&self) -> usize {
        *self.live.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Releases its slot on drop, including while a panic unwinds.
struct GateGuard<'a> {
    gate: &'a Gate,
}

impl Drop for GateGuard<'_> {
    fn drop(&mut self) {
        let mut live = self.gate.live.lock().unwrap_or_else(|e| e.into_inner());
        *live = live.saturating_sub(1);
        drop(live);
        self.gate.slot_freed.notify_one();
    }
}

static SYNTH_GATE: Gate = Gate::new();

/// Synthesize one sentence to WAV at `out`. One process per sentence is forced
/// by the engine CLI (see the module header); the permit below is what keeps
/// those processes from piling up.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    let Some(sid) = sid_for(voice_id) else {
        return Err(AppError::msg("This Kokoro voice is not available"));
    };
    let exe = engine_exe();
    if !exe.exists() {
        return Err(AppError::msg("The Kokoro engine is not installed"));
    }
    if !model_installed() {
        return Err(AppError::msg("The Kokoro voices are not downloaded"));
    }
    if let Some(parent) = out.parent() {
        ensure_dir(parent)?;
    }

    let cores = cpu_count();
    let limit = max_concurrent(cores);
    let args = synth_args(
        &model_dir(),
        sid,
        threads_per_process(cores, limit),
        out,
        text,
    );

    // Taken before the spawn and dropped after the child is reaped, so the
    // permit count and the number of resident model bundles stay in step.
    let _permit = SYNTH_GATE.acquire(limit);
    run_engine(&exe, &args, out)
}

/// Spawn the engine for one sentence and wait for it, killing it if it overruns
/// the budget. Any failure leaves no partial WAV behind for the cache to adopt.
fn run_engine(exe: &Path, args: &[String], out: &Path) -> Result<()> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|_| AppError::msg("The Kokoro voice failed to start"))?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                let waited = start.elapsed();
                if waited > SYNTH_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::msg("The Kokoro voice timed out"));
                }
                std::thread::sleep(poll_interval(waited));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::msg("The Kokoro voice failed to speak this sentence"));
            }
        }
    };
    let ok = status.success()
        && std::fs::metadata(out).map(|meta| wav_has_audio(meta.len())).unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(out);
        return Err(AppError::msg("The Kokoro voice failed to speak this sentence"));
    }
    Ok(())
}

/// Installed voices as VoiceInfo entries for the provider layer. The frontend
/// builds its Kokoro list from kokoro_status, so nothing calls this today.
#[allow(dead_code)]
pub fn installed_voices() -> Vec<VoiceInfo> {
    if !(engine_exe().exists() && model_installed()) {
        return Vec::new();
    }
    CATALOG
        .iter()
        .map(|(id, name, _, gender)| VoiceInfo {
            provider: "kokoro".into(),
            id: (*id).to_string(),
            name: (*name).to_string(),
            locale: Some(if id.starts_with('b') { "en-GB" } else { "en-US" }.to_string()),
            gender: Some((*gender).to_string()),
            installed: Some(true),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_sids_are_unique_and_wellformed() {
        let mut sids: Vec<u32> = CATALOG.iter().map(|(_, _, sid, _)| *sid).collect();
        sids.sort_unstable();
        sids.dedup();
        assert_eq!(sids.len(), CATALOG.len(), "duplicate sherpa speaker ids");
        for (id, name, _, gender) in CATALOG {
            assert!(id.starts_with("af_") || id.starts_with("am_") || id.starts_with("bf_") || id.starts_with("bm_"));
            assert!(!name.is_empty());
            assert!(*gender == "Male" || *gender == "Female");
        }
        assert_eq!(sid_for("af_bella"), Some(1));
        assert_eq!(sid_for("nope"), None);
    }

    #[test]
    fn concurrency_never_exceeds_two_and_floors_at_one() {
        // Small machines run one model load at a time rather than thrash.
        assert_eq!(max_concurrent(1), 1);
        assert_eq!(max_concurrent(2), 1);
        assert_eq!(max_concurrent(3), 1);
        // Everything larger is capped — two bundles resident, never four.
        assert_eq!(max_concurrent(4), 2);
        assert_eq!(max_concurrent(8), 2);
        assert_eq!(max_concurrent(64), 2);
    }

    #[test]
    fn thread_pools_fill_the_machine_without_oversubscribing_it() {
        // Concurrent processes × threads each never exceeds the core count...
        for cores in 1..=64usize {
            let limit = max_concurrent(cores);
            let threads = threads_per_process(cores, limit);
            assert!(threads >= 1, "{cores} cores must still get a thread");
            assert!(threads <= MAX_THREADS_PER_SYNTH, "{cores} cores capped");
            assert!(
                threads * limit <= cores,
                "{cores} cores: {limit} × {threads} oversubscribes"
            );
        }
        // ...and the common shapes land where expected.
        assert_eq!(threads_per_process(8, 2), 4);
        assert_eq!(threads_per_process(4, 2), 2);
        assert_eq!(threads_per_process(2, 1), 2);
        assert_eq!(threads_per_process(1, 1), 1);
        // A zero limit must not divide by zero.
        assert_eq!(threads_per_process(8, 0), 4);
    }

    #[test]
    fn poll_is_tight_early_then_relaxes() {
        assert_eq!(poll_interval(Duration::ZERO), Duration::from_millis(5));
        assert_eq!(poll_interval(Duration::from_millis(249)), Duration::from_millis(5));
        assert_eq!(poll_interval(Duration::from_millis(250)), Duration::from_millis(25));
        assert_eq!(poll_interval(Duration::from_secs(10)), Duration::from_millis(25));
    }

    #[test]
    fn header_only_wav_counts_as_no_audio() {
        assert!(!wav_has_audio(0));
        assert!(!wav_has_audio(44));
        assert!(wav_has_audio(45));
    }

    #[test]
    fn positional_text_stays_one_line_and_never_looks_like_a_flag() {
        assert_eq!(positional_text("a\nb\r\nc"), "a b  c");
        assert_eq!(positional_text("plain sentence"), "plain sentence");
        // A leading double dash would be parsed as an option by the engine.
        assert_eq!(positional_text("--kokoro-model=evil"), " --kokoro-model=evil");
        assert_eq!(positional_text("--"), " --");
        // A single dash and an em dash are ordinary text.
        assert_eq!(positional_text("-5 degrees"), "-5 degrees");
        assert_eq!(positional_text("— she said"), "— she said");
    }

    #[test]
    fn synth_args_carry_windows_paths_unquoted() {
        let model = Path::new(r"C:\Users\a b\voices\kokoro\kokoro-en-v0_19");
        let out = Path::new(r"C:\Users\a b\cache\audio\x.part.wav");
        let args = synth_args(model, 7, 4, out, "Hello \"world\".");

        assert_eq!(
            args[0],
            r"--kokoro-model=C:\Users\a b\voices\kokoro\kokoro-en-v0_19\model.onnx"
        );
        assert_eq!(
            args[1],
            r"--kokoro-voices=C:\Users\a b\voices\kokoro\kokoro-en-v0_19\voices.bin"
        );
        assert_eq!(
            args[2],
            r"--kokoro-tokens=C:\Users\a b\voices\kokoro\kokoro-en-v0_19\tokens.txt"
        );
        assert_eq!(
            args[3],
            r"--kokoro-data-dir=C:\Users\a b\voices\kokoro\kokoro-en-v0_19\espeak-ng-data"
        );
        assert_eq!(args[4], "--num-threads=4");
        assert_eq!(args[5], "--sid=7");
        assert_eq!(args[6], r"--output-filename=C:\Users\a b\cache\audio\x.part.wav");
        // Quotes survive verbatim: each element is its own argv slot.
        assert_eq!(args[7], "Hello \"world\".");
        // Exactly one positional argument — the engine rejects more than one.
        assert_eq!(args.len(), 8);
        assert_eq!(args.iter().filter(|a| !a.starts_with("--")).count(), 1);
    }

    #[test]
    fn gate_admits_up_to_the_limit_and_releases_on_drop() {
        let gate = Gate::new();
        assert_eq!(gate.live(), 0);
        let a = gate.acquire(2);
        let b = gate.acquire(2);
        assert_eq!(gate.live(), 2);
        drop(a);
        assert_eq!(gate.live(), 1);
        drop(b);
        assert_eq!(gate.live(), 0);
    }

    #[test]
    fn gate_treats_a_zero_limit_as_one() {
        let gate = Gate::new();
        let held = gate.acquire(0);
        assert_eq!(gate.live(), 1);
        drop(held);
        assert_eq!(gate.live(), 0);
    }

    #[test]
    fn gate_blocks_a_third_caller_until_a_slot_frees() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        static GATE: Gate = Gate::new();
        let a = GATE.acquire(2);
        let b = GATE.acquire(2);
        assert_eq!(GATE.live(), 2);

        let admitted = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&admitted);
        let waiter = std::thread::spawn(move || {
            let permit = GATE.acquire(2);
            flag.store(true, Ordering::SeqCst);
            permit
        });

        // Still at the limit, so the third caller must not have been admitted.
        std::thread::sleep(Duration::from_millis(60));
        assert!(!admitted.load(Ordering::SeqCst), "third caller ran past the limit");
        assert_eq!(GATE.live(), 2);

        drop(a);
        let permit = waiter.join().expect("waiter admitted after a slot freed");
        assert!(admitted.load(Ordering::SeqCst));
        assert_eq!(GATE.live(), 2, "the freed slot was taken, not added to");
        drop(permit);
        drop(b);
        assert_eq!(GATE.live(), 0);
    }

    /// Real-binary smoke test: needs the engine AND the model bundle installed.
    /// Run with `cargo test -- --ignored kokoro_smoke`.
    #[test]
    #[ignore = "requires the installed Kokoro engine and model bundle"]
    fn kokoro_smoke() {
        assert!(engine_exe().exists(), "engine missing at {:?}", engine_exe());
        assert!(model_installed(), "model bundle missing at {:?}", model_dir());
        let out = std::env::temp_dir().join("tarotalking-kokoro-smoke.wav");
        let _ = std::fs::remove_file(&out);

        let started = Instant::now();
        synth("af_bella", "Kokoro synthesis smoke test.", &out).expect("synthesis succeeds");
        let elapsed = started.elapsed();

        let len = std::fs::metadata(&out).expect("wav written").len();
        assert!(wav_has_audio(len), "wav had no samples");
        // Surfaces the per-spawn model-load cost this module cannot amortize.
        eprintln!("kokoro one-shot synth: {elapsed:?}, {len} bytes");
        let _ = std::fs::remove_file(&out);
    }
}
