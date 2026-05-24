//! Windows PC-side bridge between third-party KMBox Net host apps and the
//! Teensy USB Host Proxy firmware.
//!
//! Listens for KMBox Net UDP commands on a configurable address/port,
//! translates each one into the Streamcheats firmware's 9-byte binary
//! serial protocol, and forwards the resulting packets to a Teensy 4.1
//! over an auto-discovered USB-CDC COM port. The Teensy injects HID
//! mouse events into the target PC; this process is invisible to the
//! host app, which continues to see normal KMBox Net replies.
//!
//! ```text
//! host app  --UDP (KMBox Net)-->  THIS TRANSLATOR  --serial (9-byte binary)-->  Teensy proxy
//! ```
//!
//! # Module layout
//!
//! * [`kmbox_net`] — incoming KMBox Net UDP protocol: wire types
//!   ([`kmbox_net::schema`]) and decoders ([`kmbox_net::parser`]).
//! * [`streamcheats`] — outgoing Streamcheats firmware protocol AND the
//!   threads that own the serial port. Packet builders
//!   ([`streamcheats::packet`], [`streamcheats::device_settings`]),
//!   the [`streamcheats::discovery`] auto-finder, plus the serial
//!   [`streamcheats::writer`], [`streamcheats::reader`], and
//!   [`streamcheats::heartbeat`] threads. Log render helpers live in
//!   [`streamcheats::format`].
//! * [`util`] — device-agnostic glue: persisted [`util::settings`]
//!   loader and the [`util::translator::Translator`] state machine that
//!   holds the cumulative button mask and dispatches each incoming
//!   command.
//!
//! # Threading model
//!
//! The UDP socket, the [`Translator`], and the heartbeat thread are
//! **permanent** — they exist for the entire program lifetime regardless
//! of whether a Teensy is currently plugged in. The serial reader and
//! writer are **per-session** — they're spawned each time the supervisor
//! discovers a device and torn down when that device disconnects.
//!
//! At runtime the threads are:
//!
//! * **Main** — owns the UDP socket and the [`Translator`]; runs
//!   `recv_from` in a loop, parses headers, drops on MAC mismatch,
//!   dispatches via `Translator::handle_packet`, and sends the reply.
//!   This thread keeps running across disconnect/reconnect cycles.
//! * **Supervisor** — owns the discovery loop. While running, it
//!   alternates between calling [`streamcheats::discovery::discover_device`]
//!   and spawning a writer + reader pair around the port it finds.
//!   On writer exit (device unplugged) it joins both threads, clears
//!   the translator's serial sender, and rescans.
//! * **Writer** (`serial_writer_loop`) — per-session. Drains the mpsc
//!   channel and `write_all`s to the port. Returns after 3 consecutive
//!   *heartbeat* write failures (~7.5 s of port silence), having first
//!   cleared the [`SerialTxHolder`] and drained any in-flight envelopes
//!   so the next session starts clean. Non-heartbeat write failures
//!   are logged and the packet dropped, but never count toward the
//!   disconnect threshold — only heartbeats decide session liveness.
//! * **Reader** (`serial_reader_loop`) — per-session. Concurrent read
//!   on the same `Arc<SerialPort>` (serial2 supports `&self` on both
//!   directions), buffers by `\n`, emits `IN (COMx):` lines.
//! * **Heartbeat** (`heartbeat_loop`) — permanent. Every
//!   [`HEARTBEAT_INTERVAL`] checks the swappable sender holder and
//!   pushes a benign settings packet through it if a session is
//!   currently active.
//! * **Interpolation workers** — short-lived, spawned per
//!   `cmd_mouse_automove` / `cmd_bezier_move`; emit delta packets at
//!   `STEP_MS = 4 ms` cadence and then exit.
//!
//! The serial sender lives in a [`SerialTxHolder`] (an
//! `Arc<Mutex<Option<Sender<SerialEnvelope>>>>`) that's shared between
//! the translator, the heartbeat, and the supervisor. When the holder
//! is `None`, the translator silently drops outbound serial packets but
//! still returns the UDP reply, so host apps don't stall waiting on a
//! translator whose downstream device has gone away.
//!
//! # Log channels
//!
//! All structured log lines emitted by the translator carry one of three
//! channel prefixes so the direction of every event is unambiguous:
//!
//! * `IN (KMBOX NET):` — a UDP datagram arrived from a host app and was
//!   accepted. The remainder names the decoded command and its arguments.
//! * `OUT (COMx):` — a 9-byte Streamcheats packet was written to the
//!   serial port. The remainder is the raw hex.
//! * `IN (COMx):` — a newline-terminated line was received from the
//!   firmware. Non-printable bytes are escaped as `\xHH`.
//!
//! With `enable_timing_logs: true` in `config.json`, the `IN (KMBOX NET)`
//! lines also carry a `parse=Nµs` suffix and the `OUT (COMx)` lines
//! carry `(lat=X.YYms q=A.BBms w=C.DDms)` — `lat` total origin → wire,
//! `q` mpsc-queue wait, `w` the `write_all` syscall duration.
//!
//! [`HEARTBEAT_INTERVAL`]: crate::streamcheats::heartbeat::HEARTBEAT_INTERVAL
//! [`SerialTxHolder`]: crate::util::translator::SerialTxHolder

mod experimental;
mod firmware;
mod http;
mod kmbox_net;
mod services;
mod streamcheats;
mod updater;
mod util;

use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tracing::{error, info, warn};
use tracing_appender::non_blocking::{ErrorCounter, NonBlockingBuilder, WorkerGuard};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::kmbox_net::monitor::{spawn_monitor_thread, PeerRegistry};
use crate::services::log_stream::{self, LogStreamHandles};
use crate::streamcheats::discovery::discover_device;
use crate::streamcheats::{DeviceController, EventBus, MaskController};
use crate::util::daemon::{self, TakeoverOutcome};
use crate::util::log_rotation;
use crate::util::settings::{load_or_create, LoadOutcome, Settings};
use crate::util::translator::{SerialEnvelope, SerialTxHolder, Translator};

/// Holds the non-blocking writer's `WorkerGuard` for the lifetime of the
/// process. Dropping the guard flushes buffered log lines, so we must
/// keep it alive until shutdown — a `OnceLock` is the smallest footprint
/// way to do that without bubbling the guard up through `main`'s many
/// early-return paths.
static FILE_LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// Drop-line counter handed back by `NonBlockingBuilder`. Used at
/// shutdown to log how many lines (if any) the lossy appender silently
/// dropped because the in-memory channel was full. Non-zero values mean
/// the user hit a sustained burst above the configured buffer cap.
static FILE_LOG_DROPS: OnceLock<ErrorCounter> = OnceLock::new();

/// How long [`discover_device`] listens on each port per pass before
/// declaring nothing matched. The firmware sends `I:` info lines roughly
/// once per second and `S:` startup banner immediately on connect, so 5 s
/// is comfortable headroom without making the user wait long when no
/// device is attached.
const DISCOVERY_PROBE_SECS: u64 = 5;

/// Backoff between unsuccessful discovery passes. Polled in 100 ms
/// increments so Ctrl+C is responsive even mid-sleep.
const DISCOVERY_BACKOFF: Duration = Duration::from_secs(10);

/// Initialise `tracing_subscriber` with an `info`-level default filter
/// (overridable via `RUST_LOG`) and, when `settings.enable_file_logging`
/// is `true` (the default), a daily-rotating non-blocking file appender
/// at `<data_dir>/logs/streamcheats.YYYY-MM-DD.log` alongside the stdout layer.
///
/// # Hot-path latency contract
///
/// The file layer is wrapped in `tracing_appender::non_blocking` in
/// **lossy mode** with an explicit 128 000-line bounded channel. This
/// means a `tracing::info!` call from the serial writer, serial reader,
/// UDP main thread, heartbeat, or translator NEVER blocks on disk I/O —
/// it does an atomic push into a crossbeam channel and returns. A
/// dedicated background thread owned by the appender drains the channel
/// and performs the actual `write` syscalls.
///
/// **Trade-off:** if the application produces more than ~128k log lines
/// faster than the background thread can flush them, excess lines are
/// silently dropped (the `ErrorCounter` we cache in [`FILE_LOG_DROPS`]
/// is logged at shutdown so the user knows if they ever hit the cap).
/// Dropping is preferred over stalling — a stalled serial writer is a
/// stalled mouse, and a stalled mouse is unacceptable.
///
/// The [`WorkerGuard`] returned by the appender MUST stay alive for the
/// program lifetime — that's what [`FILE_LOG_GUARD`] is for. Dropping
/// the guard early would discard any not-yet-flushed buffered lines.
///
/// Returns the resolved logs dir when file logging is enabled — `main`
/// uses that path to spawn the quota janitor. Returns `None` only when
/// the user opts out via `enable_file_logging: false` in config.json
/// (or when appender setup itself fails, in which case we fall back to
/// stdout-only so the daemon still starts).
///
/// Also returns a [`LogStreamHandles`] that the HTTP server uses to
/// drive the `/logs/stream` WebSocket. Always populated — the log-stream
/// layer has no I/O and no failure modes.
fn init_logging(settings: &Settings) -> (Option<PathBuf>, LogStreamHandles) {
    // Enable VT escape-sequence processing on Windows so the ANSI colors
    // tracing-subscriber emits actually render instead of printing
    // literally as `[2m...[0m`. No-op on non-Windows.
    #[cfg(windows)]
    let _ = enable_ansi_support::enable_ansi_support();

    // Stdout layer — same shape as the original fmt() pipeline so the
    // console output is byte-identical to before the file layer landed.
    // The EnvFilter is attached via `.with_filter()` per-layer (rather
    // than once at registry level) so both layers share the filter
    // without forcing us to clone it. `Boxed` so the final Layered<>
    // type stays the same shape regardless of whether file logging is
    // on — keeps `.init()` happy and avoids generics gymnastics.
    let stdout_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_target(false)
        .with_ansi(true)
        .with_filter(stdout_filter)
        .boxed();

    // File layer is built lazily so the default-off path adds no I/O.
    let mut logs_dir: Option<PathBuf> = None;
    let file_layer: Option<Box<dyn Layer<tracing_subscriber::Registry> + Send + Sync>> =
        if settings.enable_file_logging {
            match setup_file_appender(&settings.data_dir) {
                Ok((layer, dir, guard)) => {
                    // Keep the WorkerGuard alive for the lifetime of
                    // the process — dropping it would silently truncate
                    // not-yet-flushed lines.
                    let _ = FILE_LOG_GUARD.set(guard);
                    logs_dir = Some(dir);
                    Some(layer)
                }
                Err(e) => {
                    // Fall back to stdout-only so the daemon still
                    // starts. Use eprintln! because tracing isn't
                    // initialised yet.
                    eprintln!(
                    "warning: could not initialise file logger ({}); continuing with stdout only",
                    e
                );
                    None
                }
            }
        } else {
            None
        };

    // Build the log-stream layer (ring buffer + tokio broadcast pair
    // that the /logs/stream WebSocket consumes). The layer has no I/O
    // and no failure modes, so we always wire it in.
    let (log_stream_layer, log_stream_handles) = log_stream::build();

    // Collect into a Vec<Box<dyn Layer<Registry>>>. Vec<L> implements
    // Layer<S> for any subscriber, which sidesteps the type-stacking
    // headaches that come from chaining `Option<Box<...>>` after
    // `Box<...>` in `.with()` calls.
    let mut layers: Vec<Box<dyn Layer<tracing_subscriber::Registry> + Send + Sync>> =
        Vec::with_capacity(3);
    layers.push(stdout_layer);
    if let Some(fl) = file_layer {
        layers.push(fl);
    }
    layers.push(log_stream_layer);
    tracing_subscriber::registry().with(layers).init();

    match &logs_dir {
        Some(dir) => info!("file logging: enabled (dir={})", dir.display()),
        None => info!("file logging: disabled"),
    }

    (logs_dir, log_stream_handles)
}

/// Build the daily-rotating non-blocking file appender. Returns the
/// composed tracing `Layer`, the resolved logs directory (so `main` can
/// hand it to the quota janitor), and the `WorkerGuard` that must
/// outlive the program.
///
/// Filename pattern: `streamcheats.YYYY-MM-DD.log` — `tracing-appender`'s
/// `RollingFileAppender::builder()` joins prefix + date + suffix with
/// `'.'` separators, producing exactly that form when we pass `"streamcheats"`
/// and `"log"`.
fn setup_file_appender(
    data_dir: &std::path::Path,
) -> Result<(
    Box<dyn Layer<tracing_subscriber::Registry> + Send + Sync>,
    PathBuf,
    WorkerGuard,
)> {
    let logs_dir = data_dir.join("logs");
    fs::create_dir_all(&logs_dir)
        .with_context(|| format!("creating logs directory {}", logs_dir.display()))?;

    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("streamcheats")
        .filename_suffix("log")
        .build(&logs_dir)
        .with_context(|| format!("building rolling appender at {}", logs_dir.display()))?;

    // Explicit builder (not the `non_blocking()` convenience fn) so the
    // hot-path contract is visible in source: bounded 128k-line channel,
    // lossy on overflow. The defaults in tracing-appender 0.2.x happen
    // to match this today, but writing it out means a future bump that
    // changes the defaults won't silently flip our behaviour to
    // blocking. See the `init_logging` doc comment for the full
    // rationale.
    //
    // TODO: tracing-appender 0.2.x exposes drop *counts* via
    // ErrorCounter (captured below) but no per-line drop callback. If a
    // future release adds one, we could downgrade the shutdown log to
    // a streaming warn so the user notices bursts in real time.
    let (writer, guard) = NonBlockingBuilder::default()
        .buffered_lines_limit(128_000)
        .lossy(true)
        .finish(appender);

    // Cache the drop counter once; idempotent so reinit attempts (none
    // today, but cheap insurance) don't panic.
    let _ = FILE_LOG_DROPS.set(writer.error_counter());

    // File layer mirrors the stdout layer's filter so the two streams
    // see exactly the same events. Built fresh here (rather than
    // cloned) because EnvFilter doesn't implement Clone on all
    // versions and re-parsing is cheap and identical.
    let file_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let layer = tracing_subscriber::fmt::layer()
        .with_target(false)
        .with_ansi(false)
        .with_writer(writer)
        .with_filter(file_filter)
        .boxed();

    Ok((layer, logs_dir, guard))
}

fn main() -> ExitCode {
    let cwd = match env::current_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("could not resolve current directory: {}", e);
            return ExitCode::from(1);
        }
    };

    let settings = match load_or_create(&cwd) {
        Ok(LoadOutcome::Loaded(s)) => s,
        Ok(LoadOutcome::WroteDefault { path, reason }) => {
            match reason {
                None => {
                    println!("Created default config.json — please edit listen_addr, then re-run.");
                }
                Some(r) => {
                    println!(
                        "config.json was structurally unusable ({}). Regenerating defaults.",
                        r
                    );
                    println!(
                        "Wrote fresh default to {} — please edit listen_addr, then re-run.",
                        path.display()
                    );
                }
            }
            return ExitCode::from(1);
        }
        Ok(LoadOutcome::Invalid { path, reason }) => {
            println!("config.json has an invalid value: {}", reason);
            println!(
                "Edit {} and re-run. (The file was NOT rewritten — your other settings are preserved.)",
                path.display()
            );
            return ExitCode::from(1);
        }
        Err(e) => {
            eprintln!("fatal: {:?}", e);
            return ExitCode::from(1);
        }
    };

    // Logging is initialised AFTER `load_or_create` so the file
    // appender can honour the user's `enable_file_logging` flag. The
    // config-error paths above intentionally use `println!`/`eprintln!`
    // because tracing isn't live yet at those points.
    let (logs_dir, log_stream_handles) = init_logging(&settings);

    match run(settings, logs_dir, cwd, log_stream_handles) {
        Ok(()) => ExitCode::from(0),
        Err(e) => {
            error!("fatal: {:?}", e);
            ExitCode::from(1)
        }
    }
}

/// Sleep for `total`, but wake every 100 ms to check `running`. Returns
/// `true` if the sleep completed normally, `false` if `running` flipped
/// to `false` mid-sleep (so the caller can break out of its outer loop).
fn interruptible_sleep(total: Duration, running: &Arc<AtomicBool>) -> bool {
    let deadline = Instant::now() + total;
    while running.load(Ordering::SeqCst) {
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        thread::sleep((deadline - now).min(Duration::from_millis(100)));
    }
    false
}

/// Configure a freshly-opened port the way every session expects:
/// 2 s read timeout, zero write timeout, DTR+RTS asserted. Matches the
/// pyserial defaults (`timeout=2`, `write_timeout=None` →
/// `WriteTotalTimeoutConstant=0` = block until physically out) and keeps
/// USB-serial chips (FT232H, CH340) from entering low-power states.
fn configure_session_port(port: &mut serial2::SerialPort, port_name: &str) -> Result<()> {
    port.set_read_timeout(Duration::from_secs(2))
        .context("setting serial read timeout")?;
    port.set_write_timeout(Duration::ZERO)
        .context("setting serial write timeout")?;
    if let Err(e) = port.set_dtr(true) {
        warn!("could not assert DTR on {}: {}", port_name, e);
    }
    if let Err(e) = port.set_rts(true) {
        warn!("could not assert RTS on {}: {}", port_name, e);
    }
    Ok(())
}

/// Supervisor loop: alternates between discovery (find a Teensy) and
/// session (spawn writer + reader around it) until the shared `running`
/// flag flips. When `discover_device` returns `None`, sleep
/// [`DISCOVERY_BACKOFF`] then try again. When it returns `Some`,
/// configure the port, publish the writer's sender to the holder so the
/// translator and heartbeat start forwarding, wait for the writer to
/// exit (either on disconnect or shutdown), then tear down: clear the
/// holder, signal the reader to stop, join both threads, drop the port.
fn supervisor_loop(
    holder: SerialTxHolder,
    running: Arc<AtomicBool>,
    lines_received: Arc<AtomicU64>,
    enable_timing: bool,
    last_heartbeat: crate::firmware::device::LastHeartbeat,
) {
    info!("Scanning available COM ports for firmware...");
    while running.load(Ordering::SeqCst) {
        match discover_device(DISCOVERY_PROBE_SECS) {
            None => {
                info!("No device found, will try again in 10 seconds");
                if !interruptible_sleep(DISCOVERY_BACKOFF, &running) {
                    break;
                }
                continue;
            }
            Some((port_name, mut port)) => {
                info!("Found device on {}", port_name);
                if let Err(e) = configure_session_port(&mut port, &port_name) {
                    error!("could not configure {}: {} — rescanning", port_name, e);
                    continue;
                }
                let port = Arc::new(port);
                let writer_port = port.clone();
                let reader_port = port.clone();

                // Per-session running flag for the reader. Flips when
                // the writer has exited (the disconnect signal) OR when
                // the global `running` flag flips for shutdown.
                let session_running = Arc::new(AtomicBool::new(true));

                let (tx, rx) = mpsc::channel::<SerialEnvelope>();
                // Publish the sender so the translator and heartbeat
                // start delivering packets. Done BEFORE spawning the
                // writer so we don't race against the first inbound
                // UDP datagram during port handoff.
                *holder.lock().unwrap() = Some(tx);

                let writer_running = running.clone();
                let writer_session_running = session_running.clone();
                let writer_port_name = port_name.clone();
                let writer_holder = holder.clone();
                let writer_thread = thread::spawn(move || {
                    crate::streamcheats::writer::serial_writer_loop(
                        &writer_port,
                        &writer_port_name,
                        rx,
                        writer_holder,
                        writer_running,
                        writer_session_running,
                        enable_timing,
                    );
                });

                let reader_session_running = session_running.clone();
                let reader_lines = lines_received.clone();
                let reader_port_name = port_name.clone();
                let reader_heartbeat = last_heartbeat.clone();
                let reader_thread = thread::spawn(move || {
                    crate::streamcheats::reader::serial_reader_loop(
                        &reader_port,
                        &reader_port_name,
                        reader_session_running,
                        reader_lines,
                        reader_heartbeat,
                    );
                });

                // Writer exits on 3 consecutive heartbeat failures
                // (device unplugged, ~7.5 s) or on global shutdown. On
                // the disconnect path it has already run the SOP —
                // cleared the holder and drained the channel — so the
                // line below is a belt-and-braces no-op there. On
                // graceful shutdown the writer leaves the holder alone,
                // and this line is the one that clears it.
                let _ = writer_thread.join();
                *holder.lock().unwrap() = None;

                // Signal the reader to stop and join it. The reader
                // may also have exited already on its own (read error
                // when the device went away); either way the join
                // resolves quickly.
                session_running.store(false, Ordering::SeqCst);
                let _ = reader_thread.join();

                // Drop the Arc<SerialPort> by letting it fall out of
                // scope — both threads have joined so the writer/reader
                // clones are gone; this last one closes the handle.
                drop(port);

                if running.load(Ordering::SeqCst) {
                    info!("Device on {} disconnected — rescanning", port_name);
                }
            }
        }
    }
}

/// Main service loop: binds the UDP socket, builds the permanent
/// [`Translator`], spawns the supervisor + heartbeat threads, and
/// dispatches every incoming UDP datagram through the translator.
/// Returns when the Ctrl+C handler flips the shared `running` flag.
fn run(
    settings: Settings,
    logs_dir: Option<PathBuf>,
    cwd: PathBuf,
    log_stream_handles: LogStreamHandles,
) -> Result<()> {
    // Stash for the http state-template construction below — `logs_dir`
    // gets moved into the janitor task closure, but we still need a
    // copy for AppState.
    let logs_dir_for_http = logs_dir.clone();
    let cwd_for_http = cwd.clone();
    // Single-instance daemon takeover — runs BEFORE binding so the
    // prior holder of the UDP port has time to exit before we try to
    // claim it. If the prior instance refuses to die we abort rather
    // than race for the port.
    match daemon::takeover_if_running() {
        TakeoverOutcome::Clear => {}
        TakeoverOutcome::Killed { pid } => {
            info!("daemon: took over from previous instance (pid={})", pid);
        }
        TakeoverOutcome::Stuck { pid } => {
            error!(
                "daemon: previous instance pid={} did not exit within timeout — aborting startup",
                pid
            );
            return Err(anyhow::anyhow!(
                "previous instance pid={} refused to terminate",
                pid
            ));
        }
    }

    // SC-8: the UDP socket binding + recv loop moved into the
    // `experimental::Manager` (it owns the kmbox-net listener). At
    // boot we just publish the daemon PID so single-instance takeover
    // keeps working — the port file is written/cleared by the listener
    // start/stop lifecycle. `bind` is the *configured* address; the
    // actually-bound address (after `port == 0` resolution) is
    // discoverable via `GET /api/experimental/status` while the
    // listener is up.
    let bind: SocketAddr = SocketAddr::new(settings.listen_addr, settings.udp_port);
    if let Err(e) = daemon::write_pid_only() {
        warn!("daemon: could not write pid file: {}", e);
    } else {
        info!(
            "daemon: pid={} tmpdir={}",
            std::process::id(),
            std::env::temp_dir().display()
        );
    }

    info!(
        "Configured kmbox-net listener for {}:{}, mac={} (start gated by experimental_api.enabled)",
        settings.listen_addr, settings.udp_port, settings.device_mac_str
    );

    let running = Arc::new(AtomicBool::new(true));
    {
        let r = running.clone();
        ctrlc::set_handler(move || {
            r.store(false, Ordering::SeqCst);
            // Best-effort: remove the temp files inside the Ctrl+C
            // handler too so cooperative shutdown doesn't leave them
            // behind even if the main loop is briefly blocked on a
            // join. The same cleanup runs at end of `run()` — both
            // call paths are idempotent, errors logged at debug only.
            daemon::cleanup();
        })
        .context("installing Ctrl+C handler")?;
    }

    // Swappable serial sender — populated by the supervisor whenever a
    // session is active, cleared on disconnect. The translator and
    // heartbeat both hold clones; while `None`, the translator drops
    // outbound packets silently and the heartbeat skips its tick.
    let serial_tx_holder: SerialTxHolder = Arc::new(Mutex::new(None));

    // Monotonic counter of real (non-NUL) firmware lines seen by the
    // reader. The heartbeat thread compares this counter against the
    // value it saw at its last send to decide whether the firmware is
    // still responsive; on three consecutive zero-deltas it pauses
    // sends until any new line bumps the counter again.
    let lines_received: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));

    // Quota janitor — only spawned when file logging is on (logs_dir
    // is Some). Walks <data_dir>/logs/ every hour and trims oldest
    // streamcheats*.log files when the total exceeds the hardcoded 1 GiB cap.
    // Kept above the heartbeat so it's the first long-lived thread
    // started and the last joined — gives the sweep loop a chance to
    // log any final deletions before the rest of the system tears down.
    let log_janitor_thread = logs_dir.map(|dir| {
        let janitor_running = running.clone();
        log_rotation::spawn_quota_enforcer(dir, janitor_running)
    });

    // Heartbeat is permanent — it lives across all sessions and
    // automatically idles when no session is active.
    let heartbeat_running = running.clone();
    let heartbeat_holder = serial_tx_holder.clone();
    let heartbeat_lines = lines_received.clone();
    let heartbeat_thread = thread::spawn(move || {
        crate::streamcheats::heartbeat::heartbeat_loop(
            heartbeat_holder,
            heartbeat_running,
            heartbeat_lines,
        );
    });

    // Supervisor owns the discovery + per-session writer/reader threads.
    let supervisor_running = running.clone();
    let supervisor_holder = serial_tx_holder.clone();
    let supervisor_lines = lines_received.clone();
    let last_heartbeat = crate::firmware::device::LastHeartbeat::new();
    let supervisor_heartbeat = last_heartbeat.clone();
    let supervisor_thread = thread::spawn(move || {
        supervisor_loop(
            supervisor_holder,
            supervisor_running,
            supervisor_lines,
            settings.enable_timing_logs,
            supervisor_heartbeat,
        );
    });

    // Build the device-state machine + event bus. The controller owns
    // the swappable serial holder so every `apply_*` it does flows
    // through the same writer thread the heartbeat already pokes
    // directly (the heartbeat is intentionally not routed through the
    // controller because it's a settings packet, not a HID state
    // update). Arc-wrapped because the translator clones it into every
    // interpolation worker it spawns AND a future kmbox_net::monitor
    // subscriber thread will hold its own clone to call `subscribe()`.
    let event_bus = EventBus::new();
    let device = Arc::new(DeviceController::new(
        serial_tx_holder.clone(),
        event_bus,
        settings.enable_timing_logs,
    ));

    // Monitor subscriber: third-party host apps that have called
    // `kmNet_monitor(port)` against us get UDP echo packets describing
    // every device-state change. The translator's `cmd_monitor` arm
    // populates `monitor_registry`; the dedicated `monitor_emitter`
    // thread below subscribes once to the event bus and fans out per
    // event to every registered peer. Lifecycle: the thread joins on
    // shutdown via the shared `running` flag.
    let monitor_registry = PeerRegistry::new();
    let monitor_rx = device.subscribe();
    let monitor_running = running.clone();
    let monitor_thread =
        spawn_monitor_thread(monitor_registry.clone(), monitor_rx, monitor_running);

    // MaskController owns mask state + spawns the sens-reduction
    // watchdog the first time X or Y is masked. Borrows the global
    // `running` flag so the pump exits on Ctrl+C.
    let mask_controller = Arc::new(MaskController::new(device.clone(), running.clone()));

    let translator = Arc::new(Translator::new(
        settings.device_mac,
        settings.enable_timing_logs,
        device.clone(),
        monitor_registry.clone(),
        mask_controller.clone(),
    ));

    // SC-8: experimental control plane owns the kmbox-net listener.
    // Built BEFORE the HTTP server so AppState can carry it; booted
    // AFTER the HTTP server starts so a failed bind is visible via
    // `GET /api/experimental/status` immediately on first poll.
    let experimental_manager = crate::experimental::Manager::new(
        settings.experimental_api.active.clone(),
        settings.experimental_api.enabled,
        translator.clone(),
        settings.listen_addr,
        settings.udp_port,
        running.clone(),
        cwd_for_http.clone(),
    );

    // -----------------------------------------------------------------
    // HTTP server (bug-report + health). Bound to 127.0.0.1:0 — kernel
    // picks the port. The chosen port is published to a temp file so
    // the Electron shell can discover it. Failure to spawn the server
    // is non-fatal: the UDP listener keeps running, the user just
    // doesn't get the bug-report endpoint until they restart.
    // -----------------------------------------------------------------
    let started_at = Instant::now();
    let log_drops_for_http = match FILE_LOG_DROPS.get() {
        Some(c) => {
            let cloned = c.clone();
            http::state::LogDropCounter::new(move || cloned.dropped_lines() as u64)
        }
        None => http::state::LogDropCounter::zero(),
    };
    let http_log_dir = logs_dir_for_http
        .clone()
        .unwrap_or_else(|| settings.data_dir.join("logs"));
    // In-app updater. Polls GitHub releases on a 6h cadence and
    // exposes status to the UI via `/api/updates/*`. The Arc lives in
    // AppState; the poller task is spawned inside the HTTP runtime.
    let updater_handle = Arc::new(crate::updater::Updater::new(settings.experimental_builds));
    // Firmware updater (SC-10). Shares `LastHeartbeat` with the serial
    // reader so installed-version state comes from one source of truth.
    let firmware_handle = Arc::new(crate::firmware::FirmwareUpdater::new(
        settings.firmware.repo.clone(),
        settings.firmware.auto_check,
        settings.experimental_builds,
        last_heartbeat.clone(),
        settings.data_dir.clone(),
    ));
    let http_state_template = http::state::AppState {
        device: device.clone(),
        peer_registry: monitor_registry.clone(),
        file_logging_enabled: settings.enable_file_logging,
        data_dir: settings.data_dir.clone(),
        log_dir: http_log_dir,
        cwd: cwd_for_http.clone(),
        udp_listen: bind,
        // Patched by spawn_http_server after bind succeeds.
        http_listen: bind,
        file_log_drops: log_drops_for_http,
        started_at,
        log_stream: Some(log_stream_handles),
        updater: updater_handle.clone(),
        firmware: firmware_handle.clone(),
        experimental: experimental_manager.clone(),
        running: running.clone(),
    };
    let http_handle = http::spawn_http_server(http_state_template, running.clone());
    if let Some((_, bound)) = &http_handle {
        info!("http: listening on {}", bound);
    } else {
        warn!("http: bug-report endpoint disabled (server failed to start)");
    }

    // Boot the experimental manager — starts the kmbox-net listener
    // iff `config.experimental_api.enabled == true`. Listener failure
    // is recorded as `last_error` on the manager and surfaced via the
    // UI; the daemon stays up either way.
    experimental_manager.boot();

    // Main loop: nothing to do except wait for shutdown. The UDP recv
    // loop now lives inside the kmbox-net listener thread (managed by
    // `experimental_manager`); everything else is event-driven on its
    // own thread.
    while running.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(250));
    }

    info!("shutdown requested — closing serial and exiting");
    // Stop the experimental listener (if any) so the kmbox-net UDP
    // socket is released before we tear the rest of the world down.
    experimental_manager.shutdown();
    // Report whether the lossy file appender ever had to drop lines
    // during this run. Non-zero means a sustained log burst exceeded
    // the 128k-line buffer (see init_logging contract). Zero is the
    // overwhelmingly common case.
    if let Some(counter) = FILE_LOG_DROPS.get() {
        let dropped = counter.dropped_lines();
        if dropped > 0 {
            warn!(
                "file logger dropped {} line(s) during this run (lossy appender hit its 128k buffer cap)",
                dropped
            );
        }
    }
    // Clear the holder so any final translator sends are no-ops, then
    // wait for the long-lived threads to wind down.
    *serial_tx_holder.lock().unwrap() = None;
    drop(translator);
    // Dropping `device` here closes the event bus's senders (no — the
    // bus owns its sender Vec; the receivers stay live until the bus
    // itself is dropped, which happens when `device`'s Arc count
    // reaches zero). The monitor subscriber's `recv_timeout` loop
    // additionally polls `running`, which has already flipped, so the
    // thread exits within ~250 ms regardless of bus state.
    let _ = monitor_thread.join();
    let _ = heartbeat_thread.join();
    let _ = supervisor_thread.join();
    if let Some(handle) = log_janitor_thread {
        let _ = handle.join();
    }
    if let Some((http_handle, _)) = http_handle {
        let _ = http_handle.join();
    }
    daemon::cleanup();
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::net::UdpSocket;

    /// Verifies the SO_RCVBUF bump path used inside `run()`: bind an
    /// ephemeral UDP socket on loopback, ask the kernel for a 256 KiB
    /// receive buffer via socket2::SockRef, and confirm the readback is
    /// at least above the typical Windows default of 64 KiB. We don't
    /// assert an exact value because Windows is free to round the
    /// request up or down.
    #[test]
    fn udp_recv_buffer_can_be_bumped_above_default() {
        let socket = UdpSocket::bind("127.0.0.1:0").expect("bind ephemeral UDP socket on loopback");
        let sock_ref = socket2::SockRef::from(&socket);
        let desired = 256 * 1024;
        sock_ref
            .set_recv_buffer_size(desired)
            .expect("set_recv_buffer_size(256 KiB) should succeed on supported platforms");
        let actual = sock_ref
            .recv_buffer_size()
            .expect("recv_buffer_size readback");
        assert!(
            actual > 64 * 1024,
            "expected SO_RCVBUF > 64 KiB after bump, got {} bytes",
            actual
        );
    }
}
