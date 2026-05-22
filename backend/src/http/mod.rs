//! Bug-report + health HTTP surface.
//!
//! Lives in its own module so the rest of the daemon stays std-thread
//! based; only this surface runs inside a tokio runtime. Composition:
//!
//! * [`state::AppState`] — clone-cheap handle to the device controller,
//!   peer registry, settings flags, and timing/counter atomics that the
//!   routes need.
//! * [`server`] — builds + binds the axum app on a dedicated thread.
//! * [`routes`] — thin route handlers; all real work is delegated to
//!   [`crate::services`].

pub mod routes;
pub mod server;
pub mod state;

pub use server::spawn_http_server;
#[allow(unused_imports)]
pub use state::AppState;
