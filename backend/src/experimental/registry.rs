//! Hard-coded list of experimental input APIs the daemon can host.
//!
//! Today the list has exactly one entry — `kmbox-net`. The shape is
//! designed so adding `serial-bridge`, `tcp-bridge`, etc. is a one-line
//! append here with zero UI changes — the frontend pulls the list from
//! `GET /api/experimental/registry`.
//!
//! Per SC-8 the registry is intentionally static — there is no runtime
//! plug-in surface. Each entry maps to a Rust-side listener
//! implementation inside [`super::Manager`].

use serde::Serialize;

/// Stable identifier for the kmbox-net UDP protocol listener.
pub const KMBOX_NET_ID: &str = "kmbox-net";

/// Public-facing description of one experimental API. Serialised
/// verbatim as the `apis` array in `GET /api/experimental/registry`.
#[derive(Debug, Clone, Serialize)]
pub struct ApiDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

/// Static list. Add a new entry here when a new listener implementation
/// lands in [`super::Manager`].
pub const REGISTRY: &[ApiDescriptor] = &[ApiDescriptor {
    id: KMBOX_NET_ID,
    name: "KMBox Net",
    description: "UDP-based control protocol used by KMBox-compatible third-party tools.",
}];

/// Returns `true` if `id` names an API in [`REGISTRY`].
pub fn is_known(id: &str) -> bool {
    REGISTRY.iter().any(|d| d.id == id)
}
