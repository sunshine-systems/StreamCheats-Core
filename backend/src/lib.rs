//! Tiny library facade alongside the `streamcheats_core` binary so
//! integration tests and cargo examples can reach into a few of the
//! binary's pure-data modules without re-vendoring the code. Today
//! only the encryption module and the wire-format command codes /
//! header size are exposed.
//!
//! The runtime entrypoint remains `src/main.rs`; this file is purely
//! a re-export shim. We intentionally do NOT expose `kmbox_net::parser`
//! / `kmbox_net::monitor` here — those reach into the streamcheats
//! subtree and would force the lib to compile the entire daemon graph.
//! If a future test needs them, fold them in and accept the build-
//! time cost.

pub mod kmbox_net {
    #[path = "../kmbox_net/encryption.rs"]
    pub mod encryption;
    #[path = "../kmbox_net/schema.rs"]
    pub mod schema;
    pub use schema::{
        Header, CMD_BAZER_MOVE, CMD_CONNECT, CMD_KEYBOARD_ALL, CMD_MASK_MOUSE, CMD_MONITOR,
        CMD_MOUSE_AUTOMOVE, CMD_MOUSE_LEFT, CMD_MOUSE_MIDDLE, CMD_MOUSE_MOVE, CMD_MOUSE_RIGHT,
        CMD_MOUSE_WHEEL, CMD_UNMASK_ALL, HEADER_LEN,
    };
}
