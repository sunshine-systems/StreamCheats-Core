//! Hot-path latency regression guard for the non-blocking file logger.
//!
//! Spawns 4 threads that each fire 50 000 `tracing::info!` calls back-to-back
//! with no sleep. Reports per-thread wall-clock duration and total. The
//! whole burst must finish in well under a second per thread if the file
//! appender is genuinely non-blocking — a regression that re-introduces
//! a synchronous disk write would push per-thread time into the
//! many-seconds range.
//!
//! Mirrors `main::setup_file_appender` exactly: same
//! `NonBlockingBuilder::default().buffered_lines_limit(128_000).lossy(true)`
//! config wrapped around a daily-rolling appender. Writes go to a temp
//! dir so this test never pollutes `%LOCALAPPDATA%`.
//!
//! Run with:
//!     cargo run --release --example log_burst
//!
//! Exits non-zero if any thread's elapsed time exceeds [`LATENCY_BUDGET`].

use std::sync::Arc;
use std::sync::Barrier;
use std::thread;
use std::time::{Duration, Instant};

use tracing_appender::non_blocking::NonBlockingBuilder;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

const THREADS: usize = 4;
const LINES_PER_THREAD: usize = 50_000;
/// Worst case we'll tolerate for a single thread's 50k-call burst. On a
/// non-blocking writer this should complete in tens of ms; we set a
/// generous 1 s ceiling so this remains a regression *guard* (catches
/// the catastrophic case where every call is synchronously hitting
/// disk) rather than a flaky perf microbenchmark.
const LATENCY_BUDGET: Duration = Duration::from_secs(1);

fn main() {
    let tmp = std::env::temp_dir().join("streamcheats_log_burst_test");
    std::fs::create_dir_all(&tmp).expect("create tmp logs dir");
    println!("log_burst: writing to {}", tmp.display());

    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("burst")
        .filename_suffix("log")
        .build(&tmp)
        .expect("build rolling appender");

    // EXACT mirror of `setup_file_appender` in main.rs.
    let (writer, _guard) = NonBlockingBuilder::default()
        .buffered_lines_limit(128_000)
        .lossy(true)
        .finish(appender);
    let drops = writer.error_counter();

    let file_layer = tracing_subscriber::fmt::layer()
        .with_target(false)
        .with_ansi(false)
        .with_writer(writer)
        .with_filter(EnvFilter::new("info"))
        .boxed();

    tracing_subscriber::registry()
        .with::<Vec<Box<dyn Layer<tracing_subscriber::Registry> + Send + Sync>>>(vec![file_layer])
        .init();

    // Barrier so all threads start their burst at roughly the same
    // instant — maximises contention on the appender's channel and
    // exposes any lock-related stalls.
    let barrier = Arc::new(Barrier::new(THREADS));
    let mut handles = Vec::with_capacity(THREADS);

    let overall_start = Instant::now();
    for tid in 0..THREADS {
        let b = barrier.clone();
        handles.push(thread::spawn(move || {
            b.wait();
            let start = Instant::now();
            for i in 0..LINES_PER_THREAD {
                tracing::info!("burst tid={} i={}", tid, i);
            }
            (tid, start.elapsed())
        }));
    }

    let mut results: Vec<(usize, Duration)> = handles
        .into_iter()
        .map(|h| h.join().expect("thread panicked"))
        .collect();
    results.sort_by_key(|(tid, _)| *tid);
    let overall = overall_start.elapsed();

    println!("---");
    let mut worst = Duration::ZERO;
    for (tid, dur) in &results {
        println!(
            "thread {} : {:>10} for {} calls ({:>6.2} ns/call)",
            tid,
            format!("{:?}", dur),
            LINES_PER_THREAD,
            dur.as_nanos() as f64 / LINES_PER_THREAD as f64,
        );
        if *dur > worst {
            worst = *dur;
        }
    }
    println!("---");
    println!(
        "total wall : {:?} for {} calls across {} threads",
        overall,
        THREADS * LINES_PER_THREAD,
        THREADS
    );
    println!(
        "dropped    : {} (lossy appender counter)",
        drops.dropped_lines()
    );

    if worst > LATENCY_BUDGET {
        eprintln!(
            "FAIL: worst per-thread elapsed {:?} exceeded budget {:?} — hot-path call is blocking",
            worst, LATENCY_BUDGET
        );
        std::process::exit(1);
    }
    println!("OK: all threads finished within {:?}", LATENCY_BUDGET);
}
