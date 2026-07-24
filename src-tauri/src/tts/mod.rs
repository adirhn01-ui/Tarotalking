// TTS dispatch: one `tts_synth` command routes to the provider modules
// through the disk cache. Shared shapes live here (mirrored in core/types.ts).

pub mod cache;
pub mod cartesia;
pub mod deepgram;
pub mod edge;
pub mod eleven;
pub mod kokoro;
pub mod openai;
pub mod piper;
pub mod speechify;
pub mod system;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Task id → that job's cancel flag.
type JobRegistry = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

/// Every audio job (precache and export) currently running, keyed by task id.
/// Jobs run in PARALLEL; what stays bounded is synthesis itself, through the
/// shared per-provider permit pools below. Cancellation is per task, so
/// stopping one job never disturbs another.
#[derive(Default)]
pub struct PrecacheState {
    jobs: JobRegistry,
}

/// Lock past poisoning. A worker that panics mid-synthesis must not
/// permanently disable audio jobs, and everything guarded here is a plain
/// counter or map with no invariant a panic could break.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Synthesize a batch of sentences into the cache (skipping ones already
/// cached), emitting "download-progress" events (received/total = sentence
/// counts) under `task_id`. Returns how many sentences were synthesized.
///
/// Several of these may run at once; they share one bounded synthesis budget
/// per provider, so parallel jobs split the pipe instead of multiplying it.
#[tauri::command]
pub async fn tts_precache(
    app: tauri::AppHandle,
    state: tauri::State<'_, PrecacheState>,
    provider: String,
    voice_id: String,
    texts: Vec<String>,
    task_id: String,
    label: String,
) -> Result<u32> {
    // Held for the whole command: dropping it deregisters the job on every
    // exit path, so no failure mode can leave a phantom entry behind.
    let job = claim_job(&state, &task_id)?;
    let cancel_flag = job.cancel_flag();

    tauri::async_runtime::spawn_blocking(move || {
        // De-duplicate first: repeated sentences share a cache key, and two
        // workers on the same key would collide on its staging file. Preserve
        // first-occurrence order and drop empty/whitespace texts here so the
        // progress total reflects only the real synthesis work.
        let refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
        let work = dedupe_work(&refs);
        let total = work.len() as u64;

        let emit = |received: u64, done: bool, error: Option<String>| {
            let _ = app.emit(
                "download-progress",
                crate::downloads::DownloadProgress {
                    task_id: task_id.clone(),
                    label: label.clone(),
                    received,
                    total: Some(total),
                    done,
                    error,
                },
            );
        };
        emit(0, false, None);

        let (synthesized, first_error) =
            run_synth_pool(&provider, &voice_id, &work, &cancel_flag, |received| {
                emit(received, false, None)
            });

        // Pool fully joined — the count and the error slot are stable.
        if cancel_flag.load(Ordering::SeqCst) {
            emit(synthesized as u64, true, Some("Cancelled".into()));
            return Ok(synthesized);
        }
        if let Some(err) = first_error {
            emit(synthesized as u64, true, Some(err.to_string()));
            return Err(err);
        }
        emit(synthesized as u64, true, None);
        Ok(synthesized)
    })
    .await
    .map_err(|e| AppError::wrap("Preparation task", e))
    .and_then(|r| r)
    // `job` drops here — deregistering is unmissable.
}

/// Stop audio jobs. `taskId` cancels that one job; omitting it (or passing
/// null) cancels every job currently running.
#[tauri::command]
pub fn tts_precache_cancel(state: tauri::State<'_, PrecacheState>, task_id: Option<String>) {
    cancel_jobs(&state, task_id.as_deref());
}

/// `Some(id)` flips that job's cancel flag only; `None` flips every registered
/// flag. An unknown id is a no-op — that job already finished.
pub(crate) fn cancel_jobs(state: &PrecacheState, task_id: Option<&str>) {
    {
        let jobs = lock(&state.jobs);
        match task_id {
            Some(id) => {
                if let Some(flag) = jobs.get(id) {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            None => {
                for flag in jobs.values() {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
    }
    // A cancelled job's workers may be parked waiting for a synthesis permit.
    // Wake them so they see the flag and exit instead of blocking behind a busy
    // provider.
    wake_synth_waiters();
}

/// How many sentences a provider may synthesize at once. This is the ONE width
/// policy: it sizes both a single job's worker pool and the process-wide permit
/// pool every job shares, so five parallel jobs cost the same as one.
///
/// - `edge` → 8. It is free and Microsoft's own service, and each worker keeps
///   ONE long-lived read-aloud socket rather than handshaking per sentence, so
///   the width buys throughput at a cost of roughly 8 sockets, not thousands of
///   handshakes.
/// - paid cloud APIs (`eleven`/`openai`/`speechify`/`deepgram`/`cartesia`) → 4.
///   These are rate-limited and billed per character; being greedy risks 429s
///   and the user's money. Do not raise these.
/// - local engines (`system`/`piper`/`kokoro`) → 2. They serialize behind a
///   single warm process by design, so extra workers would only queue on a
///   mutex — their speed comes from keeping the model loaded, not from threads.
///
/// Unknown providers get the paid-cloud width: never local, never the widest.
fn provider_width(provider: &str) -> usize {
    match provider {
        "edge" => 8,
        "system" | "piper" | "kokoro" => 2,
        _ => 4,
    }
}

/// Registration for one running audio job (precache or export). The caller
/// keeps it alive for the command's whole body; dropping it removes the task id
/// from the registry on every exit path — success, `?`, error, panic unwind, or
/// a dropped future.
pub(crate) struct JobGuard {
    registry: JobRegistry,
    task_id: String,
    cancel: Arc<AtomicBool>,
}

impl JobGuard {
    /// The flag this job's workers poll. Clone it into the blocking closure —
    /// tauri state handles can't cross that boundary.
    pub(crate) fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        lock(&self.registry).remove(&self.task_id);
        // If the future was dropped before its blocking half finished, that half
        // is now orphaned: flipping the flag winds it down instead of letting it
        // run on unreachable. On the normal path the workers already joined and
        // this is inert.
        self.cancel.store(true, Ordering::SeqCst);
        wake_synth_waiters();
    }
}

/// Register an audio job under `task_id`. Concurrent jobs are fine; a duplicate
/// task id is refused so two runs can never share one progress channel.
pub(crate) fn claim_job(state: &PrecacheState, task_id: &str) -> Result<JobGuard> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = lock(&state.jobs);
        if jobs.contains_key(task_id) {
            return Err(AppError::msg("That audio job is already running"));
        }
        jobs.insert(task_id.to_string(), Arc::clone(&cancel));
    }
    Ok(JobGuard {
        registry: Arc::clone(&state.jobs),
        task_id: task_id.to_string(),
        cancel,
    })
}

/// A counting semaphore: at most `width` synthesis calls run at once for one
/// provider, across every job in the process. Waiters park on the condvar —
/// no spinning, no polling — and wake on a released permit or on a cancel.
struct SynthPermits {
    width: usize,
    in_use: Mutex<usize>,
    space: Condvar,
}

impl SynthPermits {
    fn new(width: usize) -> Self {
        Self {
            width: width.max(1),
            in_use: Mutex::new(0),
            space: Condvar::new(),
        }
    }

    /// Take one permit, blocking until one frees up. Returns `None` as soon as
    /// `cancel` is set so a cancelled job's workers leave the queue instead of
    /// waiting out a busy provider.
    fn acquire<'a>(&'a self, cancel: &AtomicBool) -> Option<SynthPermit<'a>> {
        let mut in_use = lock(&self.in_use);
        loop {
            if cancel.load(Ordering::SeqCst) {
                return None;
            }
            if *in_use < self.width {
                *in_use += 1;
                return Some(SynthPermit { pool: self });
            }
            // The cancel check above runs under this lock and `wake_waiters`
            // takes the same lock before notifying, so a cancel can never slip
            // between the check and the wait.
            in_use = self
                .space
                .wait(in_use)
                .unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Re-check every parked waiter's exit condition.
    fn wake_waiters(&self) {
        let _held = lock(&self.in_use);
        self.space.notify_all();
    }

    #[cfg(test)]
    fn in_use(&self) -> usize {
        *lock(&self.in_use)
    }
}

/// Releases its permit on every exit path, including a panic unwinding out of
/// synthesis — a leaked permit would shrink the provider's budget forever.
struct SynthPermit<'a> {
    pool: &'a SynthPermits,
}

impl Drop for SynthPermit<'_> {
    fn drop(&mut self) {
        {
            let mut in_use = lock(&self.pool.in_use);
            *in_use = in_use.saturating_sub(1);
        }
        // notify_all, not notify_one: a woken waiter may be leaving on a cancel
        // rather than taking the slot, and the freed permit must not leave with
        // it. Permits turn over once per synthesized sentence, so the extra
        // wakeups are nothing.
        self.pool.space.notify_all();
    }
}

/// Provider id → its permit pool. Created lazily; pools live for the process.
static SYNTH_PERMITS: OnceLock<Mutex<HashMap<String, Arc<SynthPermits>>>> = OnceLock::new();

/// The process-wide permit pool for `provider`, created on first use.
fn permits_for(provider: &str) -> Arc<SynthPermits> {
    let registry = SYNTH_PERMITS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = lock(registry);
    Arc::clone(
        map.entry(provider.to_string())
            .or_insert_with(|| Arc::new(SynthPermits::new(provider_width(provider)))),
    )
}

/// Wake every parked worker so cancelled jobs can leave the permit queue.
fn wake_synth_waiters() {
    let Some(registry) = SYNTH_PERMITS.get() else {
        return;
    };
    // Snapshot first: never hold the registry lock while taking a pool's lock.
    let pools: Vec<Arc<SynthPermits>> = lock(registry).values().cloned().collect();
    for pool in pools {
        pool.wake_waiters();
    }
}

/// De-duplicate a sentence list, preserving first-occurrence order and dropping
/// empty/whitespace-only entries. Repeated sentences share one cache key, so a
/// single synthesis serves them all.
pub(crate) fn dedupe_work<'a>(texts: &[&'a str]) -> Vec<&'a str> {
    let mut seen: HashSet<&'a str> = HashSet::new();
    texts
        .iter()
        .copied()
        .filter(|t| !t.trim().is_empty())
        .filter(|t| seen.insert(*t))
        .collect()
}

/// Synthesize `work` (already de-duplicated and non-empty) into the disk cache
/// with a provider-sized worker pool: K workers (`provider_width`) pull sentence
/// indices from a shared atomic cursor and synthesize in parallel.
///
/// Each worker holds one permit from the provider's PROCESS-WIDE pool for the
/// duration of a single `synth_via_cache` call, so total concurrent synthesis
/// for a provider is the same whether one job or five are running — parallel
/// jobs share the pipe rather than flooding it. Workers with no permit park on
/// the pool's condvar and wake on a release or a cancel.
///
/// `synth_via_cache` is thread-safe for DIFFERENT texts — each writes its own
/// staging file, and prune never evicts files younger than 120s — so the one
/// real hazard is two workers racing on the SAME cache key. The caller's up-front
/// de-duplication rules that out. The pool winds down cleanly on cancel or the
/// first error; `on_progress(completed)` runs on this thread at ~300ms intervals
/// while it works. Returns the completed count and the first error, if any — the
/// caller inspects `cancel` to tell a cancel apart from a clean finish.
pub(crate) fn run_synth_pool(
    provider: &str,
    voice_id: &str,
    work: &[&str],
    cancel: &Arc<AtomicBool>,
    on_progress: impl Fn(u64),
) -> (u32, Option<AppError>) {
    let total = work.len() as u64;
    let completed = Arc::new(AtomicU32::new(0));
    let cursor = Arc::new(AtomicUsize::new(0));
    let error_flag = Arc::new(AtomicBool::new(false));
    let first_error: Mutex<Option<AppError>> = Mutex::new(None);

    // Never spawn more workers than there is work.
    let k = provider_width(provider).min(work.len());
    let permits = permits_for(provider);
    let first_error = &first_error;

    thread::scope(|scope| {
        for _ in 0..k {
            let completed = Arc::clone(&completed);
            let cursor = Arc::clone(&cursor);
            let error_flag = Arc::clone(&error_flag);
            let cancel = Arc::clone(cancel);
            let permits = Arc::clone(&permits);
            scope.spawn(move || loop {
                // Wind down as soon as anyone cancels or hits an error.
                if cancel.load(Ordering::SeqCst) || error_flag.load(Ordering::SeqCst) {
                    break;
                }
                let idx = cursor.fetch_add(1, Ordering::SeqCst);
                if idx >= work.len() {
                    break;
                }
                // Hold a shared permit for the synthesis call only; the guard
                // releases it on the way out of this block, panic included.
                let outcome = {
                    let Some(_permit) = permits.acquire(&cancel) else {
                        break;
                    };
                    cache::synth_via_cache(provider, voice_id, work[idx])
                };
                match outcome {
                    Ok(_) => {
                        completed.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(e) => {
                        // Keep the FIRST error; signal the others to stop.
                        let mut slot = first_error.lock().unwrap();
                        if slot.is_none() {
                            *slot = Some(e);
                        }
                        error_flag.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            });
        }

        // Progress emitter (this thread): throttle to ~300ms until the pool
        // finishes, is cancelled, or errors.
        let mut last_emit = Instant::now();
        loop {
            let done_now = completed.load(Ordering::SeqCst) as u64;
            if cancel.load(Ordering::SeqCst)
                || error_flag.load(Ordering::SeqCst)
                || done_now >= total
            {
                break;
            }
            if last_emit.elapsed() >= Duration::from_millis(300) {
                on_progress(done_now);
                last_emit = Instant::now();
            }
            thread::sleep(Duration::from_millis(50));
        }
    });

    let synthesized = completed.load(Ordering::SeqCst);
    let err = first_error.lock().unwrap().take();
    (synthesized, err)
}

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WordBoundary {
    pub offset_ms: u32,
    pub char_start: u32,
    pub char_len: u32,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundaries: Option<Vec<WordBoundary>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<bool>,
}

/// Synthesize one sentence. Checks the disk cache first; on miss, calls the
/// provider and stores the result (plus a boundaries sidecar when present).
#[tauri::command]
pub async fn tts_synth(
    app: tauri::AppHandle,
    provider: String,
    voice_id: String,
    text: String,
) -> Result<SynthResult> {
    if text.trim().is_empty() {
        return Err(AppError::msg("Nothing to speak"));
    }
    if text.len() > 8000 {
        return Err(AppError::msg("Sentence too long to synthesize"));
    }
    let _ = app;
    tauri::async_runtime::spawn_blocking(move || {
        cache::synth_via_cache(&provider, &voice_id, &text)
    })
    .await
    .map_err(|e| AppError::wrap("Synthesis task failed", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------------- width policy ---------------- */

    #[test]
    fn provider_width_by_provider() {
        // Free, first-party, and socket-reusing → the widest budget.
        assert_eq!(provider_width("edge"), 8, "edge is free and reuses sockets → 8");
        // Local engines are process/CPU-heavy and serialize anyway → 2.
        for local in ["system", "piper", "kokoro"] {
            assert_eq!(provider_width(local), 2, "{local} is a local engine → 2");
        }
        // Paid, rate-limited, per-character APIs → 4.
        for paid in ["eleven", "openai", "speechify", "deepgram", "cartesia"] {
            assert_eq!(provider_width(paid), 4, "{paid} is a metered API → 4");
        }
        // Unknown providers default to the paid-cloud width (never local).
        assert_eq!(provider_width("bogus"), 4);
    }

    /* ---------------- job registry ---------------- */

    #[test]
    fn registry_adds_and_removes_per_task() {
        let state = PrecacheState::default();
        let a = claim_job(&state, "job-a").unwrap();
        let b = claim_job(&state, "job-b").unwrap();
        assert_eq!(lock(&state.jobs).len(), 2, "concurrent jobs are allowed");

        // A duplicate task id is refused with a clear message.
        let dup = match claim_job(&state, "job-a") {
            Ok(_) => panic!("a duplicate task id must be refused"),
            Err(e) => e.to_string(),
        };
        assert!(dup.contains("already running"), "unhelpful message: {dup}");
        assert_eq!(lock(&state.jobs).len(), 2, "a refused claim adds nothing");

        drop(a);
        assert_eq!(lock(&state.jobs).len(), 1);
        // The freed id is claimable again.
        let a2 = claim_job(&state, "job-a").unwrap();
        assert_eq!(lock(&state.jobs).len(), 2);

        drop((a2, b));
        assert!(lock(&state.jobs).is_empty(), "every guard deregisters on drop");
    }

    #[test]
    fn dropping_a_guard_winds_down_an_orphaned_job() {
        let state = PrecacheState::default();
        let flag = {
            let job = claim_job(&state, "job-x").unwrap();
            job.cancel_flag()
        };
        assert!(
            flag.load(Ordering::SeqCst),
            "a dropped guard must stop workers that outlived the command"
        );
    }

    #[test]
    fn cancel_targets_one_job_or_every_job() {
        let state = PrecacheState::default();
        let a = claim_job(&state, "job-a").unwrap();
        let b = claim_job(&state, "job-b").unwrap();
        let (fa, fb) = (a.cancel_flag(), b.cancel_flag());

        cancel_jobs(&state, Some("job-a"));
        assert!(fa.load(Ordering::SeqCst));
        assert!(
            !fb.load(Ordering::SeqCst),
            "cancelling one job must not disturb another"
        );

        // An id nobody registered is a quiet no-op, not a stray cancel.
        cancel_jobs(&state, Some("job-gone"));
        assert!(!fb.load(Ordering::SeqCst));

        // No id → cancel everything.
        cancel_jobs(&state, None);
        assert!(fb.load(Ordering::SeqCst));
        drop((a, b));
    }

    /* ---------------- permit pool ---------------- */

    #[test]
    fn permits_are_counted_and_returned() {
        let pool = SynthPermits::new(2);
        let cancel = AtomicBool::new(false);
        let a = pool.acquire(&cancel).unwrap();
        let b = pool.acquire(&cancel).unwrap();
        assert_eq!(pool.in_use(), 2, "the full width is usable");
        drop(a);
        assert_eq!(pool.in_use(), 1);
        drop(b);
        assert_eq!(pool.in_use(), 0);
    }

    #[test]
    fn a_waiter_takes_the_next_freed_permit() {
        let pool = SynthPermits::new(1);
        let cancel = AtomicBool::new(false);
        let held = pool.acquire(&cancel).unwrap();
        let took = AtomicBool::new(false);

        thread::scope(|scope| {
            scope.spawn(|| {
                let _permit = pool.acquire(&cancel).unwrap();
                took.store(true, Ordering::SeqCst);
            });
            thread::sleep(Duration::from_millis(30));
            assert!(
                !took.load(Ordering::SeqCst),
                "a waiter must block while the width is fully taken"
            );
            drop(held);
        });

        assert!(took.load(Ordering::SeqCst), "releasing a permit wakes a waiter");
        assert_eq!(pool.in_use(), 0);
    }

    #[test]
    fn a_waiter_leaves_promptly_on_cancel() {
        let pool = SynthPermits::new(1);
        let cancel = AtomicBool::new(false);
        let held = pool.acquire(&cancel).unwrap();

        thread::scope(|scope| {
            let waiter = scope.spawn(|| pool.acquire(&cancel).is_none());
            thread::sleep(Duration::from_millis(20));
            cancel.store(true, Ordering::SeqCst);
            pool.wake_waiters();
            assert!(
                waiter.join().unwrap(),
                "a cancelled worker must give up its place instead of blocking"
            );
        });

        drop(held);
        assert_eq!(pool.in_use(), 0, "a cancelled waiter never took a permit");
    }

    #[test]
    fn a_panicking_worker_does_not_leak_its_permit() {
        let pool = SynthPermits::new(1);
        let cancel = AtomicBool::new(false);
        let blew_up = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _permit = pool.acquire(&cancel).unwrap();
            panic!("synthesis blew up");
        }));
        assert!(blew_up.is_err());
        assert_eq!(pool.in_use(), 0, "the guard must release while unwinding");
        assert!(
            pool.acquire(&cancel).is_some(),
            "the pool still hands out its full width afterwards"
        );
    }

    #[test]
    fn permits_never_exceed_the_width_under_load() {
        let pool = Arc::new(SynthPermits::new(3));
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let cancel = Arc::new(AtomicBool::new(false));

        thread::scope(|scope| {
            for _ in 0..12 {
                let pool = Arc::clone(&pool);
                let live = Arc::clone(&live);
                let peak = Arc::clone(&peak);
                let cancel = Arc::clone(&cancel);
                scope.spawn(move || {
                    for _ in 0..25 {
                        let _permit = pool.acquire(&cancel).expect("nothing cancelled");
                        let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        thread::sleep(Duration::from_micros(50));
                        live.fetch_sub(1, Ordering::SeqCst);
                    }
                });
            }
        });

        assert_eq!(live.load(Ordering::SeqCst), 0);
        let peak = peak.load(Ordering::SeqCst);
        assert!(peak <= 3, "peak concurrency {peak} exceeded the width of 3");
        assert_eq!(pool.in_use(), 0);
    }

    #[test]
    fn one_pool_per_provider_sized_by_its_width() {
        let edge = permits_for("edge");
        let piper = permits_for("piper");
        assert_eq!(edge.width, 8);
        assert_eq!(piper.width, 2);
        // Same provider → literally the same pool, which is what stops parallel
        // jobs from multiplying the budget.
        assert!(Arc::ptr_eq(&edge, &permits_for("edge")));
        assert!(!Arc::ptr_eq(&edge, &piper));
    }

    #[test]
    fn parallel_jobs_share_one_provider_budget() {
        // Three jobs at once, each with a full worker set, must still push no
        // more than the provider's width through synthesis at any instant.
        let provider = "test-shared-budget";
        let width = provider_width(provider);
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        thread::scope(|scope| {
            for _job in 0..3 {
                let cancel = Arc::new(AtomicBool::new(false));
                for _worker in 0..width {
                    let live = Arc::clone(&live);
                    let peak = Arc::clone(&peak);
                    let cancel = Arc::clone(&cancel);
                    scope.spawn(move || {
                        let pool = permits_for(provider);
                        for _ in 0..20 {
                            let _permit = pool.acquire(&cancel).expect("nothing cancelled");
                            let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                            peak.fetch_max(now, Ordering::SeqCst);
                            thread::sleep(Duration::from_micros(100));
                            live.fetch_sub(1, Ordering::SeqCst);
                        }
                    });
                }
            }
        });

        assert_eq!(live.load(Ordering::SeqCst), 0);
        let peak = peak.load(Ordering::SeqCst);
        assert!(
            peak <= width,
            "3 parallel jobs reached {peak} concurrent syntheses; the budget is {width}"
        );
        assert_eq!(permits_for(provider).in_use(), 0);
    }
}
