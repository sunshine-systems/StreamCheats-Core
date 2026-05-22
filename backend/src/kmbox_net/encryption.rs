//! Port of the vendor KMBox Net `my_encrypt` cipher and its algebraic
//! inverse `decrypt`.
//!
//! # Cipher overview
//!
//! The vendor source `c++_demo/NetConfig/my_enc.cpp` implements a
//! six-round XXTEA-style block cipher operating on **32 little-endian
//! `u32` words = 128 bytes**. The full vendor function:
//!
//! ```c
//! // c++_demo/NetConfig/my_enc.cpp (full file, retrieved from
//! // https://raw.githubusercontent.com/kvmaibox/kmboxnet/main/c%2B%2B_demo/NetConfig/my_enc.cpp)
//! void my_encrypt(unsigned char* input, unsigned char* key)
//! {	unsigned char  n =32;
//! 	unsigned long* a1 = (unsigned long*)input;
//! 	unsigned long* a2 = (unsigned long*)key;
//! 	unsigned long  a3 = a1[n - 1], a4 = a1[0], sum = 0, a5;
//! 	unsigned char a6, a7;
//! 	a7 = 6;//initial round count
//! 	while (a7-- > 0)
//! 	{
//! 		sum += 2654435769;                          // delta = 0x9E3779B9
//! 		a5 = sum >> 2 & 3;
//! 		for (a6 = 0;a6 < n - 1; a6++)
//! 			a4 = a1[a6 + 1],
//! 			a3 = a1[a6] += (a3 >> 5 ^ a4 << 2) + (a4 >> 3 ^ a3 << 4) ^ (sum ^ a4) + (a2[a6 & 3 ^ a5] ^ a3);
//! 		a4 = a1[0];
//! 		a3 = a1[n - 1] += (a3 >> 5 ^ a4 << 2) + (a4 >> 3 ^ a3 << 4) ^ (sum ^ a4) + (a2[a6 & 3 ^ a5] ^ a3);
//! 	}
//! }
//! ```
//!
//! Notes on porting:
//!
//! * `unsigned long` on the vendor target (MSVC x86/x64 Windows) is
//!   **32-bit**; the cipher is defined on 32-bit words. We use `u32`
//!   and `wrapping_*` for every arithmetic op to match C's unsigned
//!   wrap semantics.
//! * The buffer is reinterpreted as a `u32` array. C does this with a
//!   pointer cast, which is little-endian on every shipped vendor
//!   binary (x86/x64). Our port reads/writes `u32` LE explicitly.
//! * The C comma-expression
//!   `a4 = a1[i+1], a3 = a1[i] += MX(...)`
//!   is two statements separated by `,`. Translated as two Rust lines.
//! * `a6` exits the inner loop equal to `n - 1` (the value that failed
//!   the condition). The vendor wrap step uses `key[(n-1) & 3 ^ e]`.
//! * C operator precedence used in the MX expression (high → low):
//!   `<<`,`>>`  >  `+`,`-`  >  `^`. So `a3 >> 5 ^ a4 << 2` parses as
//!   `((a3>>5) ^ (a4<<2))`; the outer
//!   `P1 + P2 ^ P3 + P4` parses as `(P1+P2) ^ (P3+P4)`. See
//!   [`mx`] for the explicit Rust grouping.
//!
//! # Key construction
//!
//! `kmboxNet.cpp` lines 17 (`static unsigned char key[16] = { 0 };`),
//! 125 (`memset(key, 0, 16)`) and 137-138 (retrieved from
//! `https://raw.githubusercontent.com/kvmaibox/kmboxnet/main/c%2B%2B_demo/NetConfig/kmboxNet.cpp`):
//!
//! ```c
//! key[0] = tx.head.mac >> 24; key[1] = tx.head.mac >> 16;
//! key[2] = tx.head.mac >> 8;  key[3] = tx.head.mac >> 0;
//! ```
//!
//! Therefore the 16-byte key is `mac.to_be_bytes()` followed by 12
//! zero bytes. The cipher then reinterprets it as `[u32; 4]` LE, so
//! `key_words[0] = u32::from_le_bytes([mac>>24, mac>>16, mac>>8, mac])`
//! and `key_words[1..=3] = 0`. See [`key_from_mac`].
//!
//! # Detection strategy on the receive side
//!
//! `kmNet_enc_*` functions in `kmboxNet.cpp` all set the SAME `cmd_*`
//! opcode as the plaintext variants but always send exactly **128
//! bytes** (lines 198, 251, 300, 348, 400, 451, 496, 553, 615, 687,
//! 803, 901, 963 — every encrypted send is `sendto(..., 128, 0, ...)`).
//! Plaintext mouse-shaped commands send `sizeof(cmd_head_t) +
//! sizeof(soft_mouse_t) = 72` bytes (line 169 and friends). Plaintext
//! header-only commands send 16 bytes.
//!
//! Therefore **packet length is a perfect discriminator**: a 128-byte
//! datagram is encrypted; any other length is plaintext. See
//! [`is_encrypted_length`]. We considered:
//!
//! * **Try-decrypt + sanity-check** — robust but doubles the parse cost
//!   for every plaintext packet and risks false-positives on legitimate
//!   plaintext payloads that happen to be 128 bytes long (none exist
//!   today, but a future vendor opcode could collide).
//! * **Per-session opt-in flag in config** — places burden on the host
//!   operator; fails open if mis-configured.
//! * **Length-based discrimination (chosen)** — zero ambiguity given
//!   the current vendor binary, zero cost on the plaintext path, and
//!   the SDK has used `sendto(..., 128, 0, ...)` since the first public
//!   release. If a future SDK changes the encrypted length it would
//!   also break every other receiver (vendor box, third-party
//!   monitors); the detection scheme can be revisited then.

/// The encrypted-on-wire packet size and the cipher's natural block
/// size. Vendor: `c++_demo/NetConfig/kmboxNet.cpp` — every
/// `my_encrypt` call is followed by `sendto(..., 128, 0, ...)`.
pub const ENC_PACKET_LEN: usize = 128;

/// Number of `u32` words the cipher operates on (`n` in vendor source).
pub const ENC_WORDS: usize = ENC_PACKET_LEN / 4; // 32

/// Number of rounds (`a7` initial value in vendor source).
pub const ENC_ROUNDS: u32 = 6;

/// XXTEA-style delta (`sum += 2654435769` in vendor source).
pub const DELTA: u32 = 0x9E3779B9;

/// Build the 16-byte key from a 32-bit MAC value, mirroring
/// `kmboxNet.cpp` lines 137-138. The MAC bytes go big-endian into the
/// first four key bytes; the rest are zero.
pub fn key_from_mac(mac: u32) -> [u8; 16] {
    let mut key = [0u8; 16];
    key[0] = (mac >> 24) as u8;
    key[1] = (mac >> 16) as u8;
    key[2] = (mac >> 8) as u8;
    key[3] = mac as u8;
    key
}

/// Encrypt a 128-byte buffer in place. Faithful transliteration of
/// `my_enc.cpp` — every arithmetic op uses `wrapping_*` to match C
/// unsigned-overflow semantics.
///
/// The runtime translator only ever DECRYPTS incoming packets (it is
/// a receive-only proxy for host-app → device traffic), so this fn is
/// dead code in the bin but lives on the public API so integration
/// tests and the encryption-fixture tests can produce ciphertext that
/// mirrors what the vendor SDK would put on the wire.
#[allow(dead_code)]
pub fn encrypt(buf: &mut [u8; ENC_PACKET_LEN], key: &[u8; 16]) {
    let mut a1 = read_words_le(buf);
    let a2 = read_key_words(key);

    let n = ENC_WORDS;
    // Vendor: `unsigned long a3 = a1[n - 1], a4 = a1[0], sum = 0, a5;`
    let mut a3: u32 = a1[n - 1];
    let mut a4: u32;
    let mut sum: u32 = 0;
    let mut a5: u32;

    for _round in 0..ENC_ROUNDS {
        sum = sum.wrapping_add(DELTA);
        a5 = (sum >> 2) & 3;

        // Inner loop: a6 ∈ [0, n-1).
        // Vendor body (comma-expression unpacked):
        //   a4 = a1[a6 + 1];
        //   a1[a6] = a1[a6] + MX(a3, a4, sum, a5, a6);
        //   a3 = a1[a6];
        let mut a6: usize = 0;
        while a6 < n - 1 {
            a4 = a1[a6 + 1];
            let m = mx(a3, a4, sum, a5, a6, &a2);
            a1[a6] = a1[a6].wrapping_add(m);
            a3 = a1[a6];
            a6 += 1;
        }
        // After the loop, `a6 == n - 1` — the value that broke the
        // condition. Vendor uses that index in the wrap step.
        debug_assert_eq!(a6, n - 1);

        // Wrap step.
        a4 = a1[0];
        let m = mx(a3, a4, sum, a5, n - 1, &a2);
        a1[n - 1] = a1[n - 1].wrapping_add(m);
        a3 = a1[n - 1];
    }
    let _ = a3; // explicit no-op; kept for parity with the C variable.

    write_words_le(buf, &a1);
}

/// Decrypt a 128-byte buffer in place — algebraic inverse of
/// [`encrypt`]. Reverses the rounds and the per-word `+= MX` updates
/// so that `decrypt(encrypt(b)) == b`. The vendor source provides no
/// decrypt function (the box decrypts internally); this is derived by
/// hand. Correctness is checked by the round-trip tests below.
pub fn decrypt(buf: &mut [u8; ENC_PACKET_LEN], key: &[u8; 16]) {
    let mut a1 = read_words_le(buf);
    let a2 = read_key_words(key);

    let n = ENC_WORDS;
    // After ENC_ROUNDS forward rounds, sum has been incremented
    // ENC_ROUNDS times. Start the inverse there and decrement.
    let mut sum: u32 = DELTA.wrapping_mul(ENC_ROUNDS);

    for _round in 0..ENC_ROUNDS {
        let a5: u32 = (sum >> 2) & 3;

        // Undo the wrap step first (it ran last during encrypt).
        // Encrypt did, at the end of the round:
        //   a1[n-1] += MX(a3_at_that_point, a1[0], sum, e, n-1)
        // where a3_at_that_point was the inner loop's last assigned a3,
        // i.e. the (then-just-written) value at a1[n-2]. a1[0] was
        // only read, never mutated. So we can undo the wrap with
        // z = a1[n-2] (current value), y = a1[0] (unchanged).
        let z = a1[n - 2];
        let y = a1[0];
        let m = mx(z, y, sum, a5, n - 1, &a2);
        a1[n - 1] = a1[n - 1].wrapping_sub(m);

        // Now undo the inner loop iterations from p = n-2 down to 0.
        // For each inner iteration at index p (during encrypt):
        //   a3_used = previous loop's a3 = (p==0 ? a1[n-1] saved at
        //             top of round : a1[p-1] after its update)
        //   y_used  = a1[p+1] (only read; iteration p never mutates it)
        //   a1[p] += MX(z, y, sum, e, p)
        // We undo bottom-up. After we've subtracted MX from a1[p] we
        // restore its pre-iteration value, which is exactly what the
        // p-1 iteration needs as its "z" lookup (or, at p=0, what the
        // round-top saw as a1[n-1]).
        //
        // Crucially we already restored a1[n-1] above, so a[n-1] now
        // holds the pre-round value — exactly what `a3_initial` was
        // at the top of the encrypt round. That's the right `z` for
        // p=0.
        let mut p: isize = (n - 2) as isize;
        while p >= 0 {
            let z = if p == 0 {
                a1[n - 1]
            } else {
                a1[(p - 1) as usize]
            };
            let y = a1[(p + 1) as usize];
            let m = mx(z, y, sum, a5, p as usize, &a2);
            a1[p as usize] = a1[p as usize].wrapping_sub(m);
            p -= 1;
        }

        sum = sum.wrapping_sub(DELTA);
    }
    debug_assert_eq!(sum, 0);

    write_words_le(buf, &a1);
}

/// XXTEA mix function. The vendor expression is
///
/// ```text
/// (a3 >> 5 ^ a4 << 2) + (a4 >> 3 ^ a3 << 4) ^ (sum ^ a4) + (a2[a6 & 3 ^ a5] ^ a3)
/// ```
///
/// C precedence (high → low) for the operators present: `<<`/`>>` >
/// `+`/`-` > `^`. So the parenthesised subterms each evaluate as
/// written; the outer expression `P1 + P2 ^ P3 + P4` parses as
/// `(P1 + P2) ^ (P3 + P4)`. The key index `a6 & 3 ^ a5` parses as
/// `(a6 & 3) ^ a5` because `&` is higher than `^`.
#[inline]
fn mx(z: u32, y: u32, sum: u32, e: u32, p: usize, key_words: &[u32; 4]) -> u32 {
    let p1 = (z >> 5) ^ (y << 2);
    let p2 = (y >> 3) ^ (z << 4);
    let p3 = sum ^ y;
    let idx = ((p & 3) as u32 ^ e) as usize;
    let p4 = key_words[idx] ^ z;
    p1.wrapping_add(p2) ^ p3.wrapping_add(p4)
}

fn read_words_le(buf: &[u8; ENC_PACKET_LEN]) -> [u32; ENC_WORDS] {
    let mut out = [0u32; ENC_WORDS];
    for (i, w) in out.iter_mut().enumerate() {
        let off = i * 4;
        *w = u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]);
    }
    out
}

fn write_words_le(buf: &mut [u8; ENC_PACKET_LEN], words: &[u32; ENC_WORDS]) {
    for (i, w) in words.iter().enumerate() {
        let off = i * 4;
        let b = w.to_le_bytes();
        buf[off] = b[0];
        buf[off + 1] = b[1];
        buf[off + 2] = b[2];
        buf[off + 3] = b[3];
    }
}

fn read_key_words(key: &[u8; 16]) -> [u32; 4] {
    let mut out = [0u32; 4];
    for (i, w) in out.iter_mut().enumerate() {
        let off = i * 4;
        *w = u32::from_le_bytes([key[off], key[off + 1], key[off + 2], key[off + 3]]);
    }
    out
}

/// `true` iff `len` is the encrypted-packet wire length (128). Vendor
/// SDK always sends encrypted commands as exactly 128 bytes — see
/// module docs. Plaintext sends are 16 (header-only) or 72 (mouse
/// body).
#[inline]
pub fn is_encrypted_length(len: usize) -> bool {
    len == ENC_PACKET_LEN
}

#[cfg(test)]
mod tests {
    use super::*;
    use byteorder::{ByteOrder, LittleEndian};

    fn seed(n: usize) -> [u8; ENC_PACKET_LEN] {
        let mut b = [0u8; ENC_PACKET_LEN];
        for (i, x) in b.iter_mut().enumerate() {
            *x = ((i + n) & 0xFF) as u8;
        }
        b
    }

    // ---------- 1. Round-trip identity (5 inputs) ----------

    #[test]
    fn round_trip_zero_buf() {
        let key = key_from_mac(0x01FBC068);
        let plain = [0u8; ENC_PACKET_LEN];
        let mut buf = plain;
        encrypt(&mut buf, &key);
        assert_ne!(
            buf, plain,
            "encryption should change a zero buffer (key is non-zero)"
        );
        decrypt(&mut buf, &key);
        assert_eq!(buf, plain);
    }

    #[test]
    fn round_trip_seed_zero() {
        let key = key_from_mac(0x01FBC068);
        let plain = seed(0);
        let mut buf = plain;
        encrypt(&mut buf, &key);
        decrypt(&mut buf, &key);
        assert_eq!(buf, plain);
    }

    #[test]
    fn round_trip_seed_offset() {
        let key = key_from_mac(0xDEADBEEF);
        let plain = seed(17);
        let mut buf = plain;
        encrypt(&mut buf, &key);
        decrypt(&mut buf, &key);
        assert_eq!(buf, plain);
    }

    #[test]
    fn round_trip_all_0xff() {
        let key = key_from_mac(0xAABBCCDD);
        let plain = [0xFFu8; ENC_PACKET_LEN];
        let mut buf = plain;
        encrypt(&mut buf, &key);
        decrypt(&mut buf, &key);
        assert_eq!(buf, plain);
    }

    #[test]
    fn round_trip_realistic_mouse_left_packet() {
        // Realistic on-wire shape: 16-byte header + 56-byte soft_mouse
        // body + 56 zero bytes of padding (the union in `client_tx`
        // is larger than soft_mouse_t but only the first 56 are
        // populated by mouse opcodes).
        let mut plain = [0u8; ENC_PACKET_LEN];
        LittleEndian::write_u32(&mut plain[0..4], 0x01FBC068);
        LittleEndian::write_u32(&mut plain[4..8], 0x12345678);
        LittleEndian::write_u32(&mut plain[8..12], 7);
        LittleEndian::write_u32(&mut plain[12..16], 0x9823AE8D); // CMD_MOUSE_LEFT
        LittleEndian::write_i32(&mut plain[16..20], 1); // button down
        let key = key_from_mac(0x01FBC068);
        let mut buf = plain;
        encrypt(&mut buf, &key);
        // Sanity: encryption must scramble the header bytes too.
        assert_ne!(&buf[..16], &plain[..16]);
        decrypt(&mut buf, &key);
        assert_eq!(buf, plain);
    }

    // ---------- 2. Vendor-fixture compatibility ----------
    //
    // No C compiler is available in this environment, so a runtime
    // vendor-fixture comparison is infeasible. Instead we pin the
    // cipher's correctness in two layers:
    //
    //   (a) `vendor_first_iter_hand_traced` — hand-derive ONE inner
    //       iteration's output from the vendor expression with full
    //       arithmetic shown in comments, then assert our `mx` +
    //       `encrypt_n_rounds(1)` produce the same word.
    //   (b) `vendor_snapshot_six_rounds_pinned` — pin the 6-round
    //       output hash for a deterministic input so the full
    //       composition (round count, wrap step, sum update) cannot
    //       drift undetected.

    /// Hand-traced first iteration of the vendor algorithm.
    ///
    /// Input:
    ///   a1[0] = 0x00000001, a1[1] = 0x00000002, a1[i>=2] = 0
    ///   mac   = 0x01020304
    ///         → key bytes [0x01, 0x02, 0x03, 0x04, 0, …, 0]
    ///         → key_words[0] = u32::from_le_bytes([1,2,3,4])
    ///                       = 0x04030201
    ///         → key_words[1..3] = 0
    ///
    /// Vendor state before the round:
    ///   a3_initial = a1[n-1] = a1[31] = 0
    ///   sum = 0
    ///
    /// Round 1, inner iteration p = 0:
    ///   sum   = 0 + 0x9E3779B9 = 0x9E3779B9
    ///   e     = (sum >> 2) & 3
    ///         = (0x9E3779B9 >> 2) & 3
    ///         = 0x278DDE6E & 3
    ///         = 2
    ///   z     = a3 = 0 (a3_initial)
    ///   y     = a1[1] = 2
    ///   idx   = (0 & 3) ^ 2 = 2
    ///   k     = key_words[2] = 0
    ///   P1    = (z>>5) ^ (y<<2)
    ///         = (0>>5) ^ (2<<2)
    ///         = 0 ^ 8 = 8
    ///   P2    = (y>>3) ^ (z<<4)
    ///         = (2>>3) ^ (0<<4)
    ///         = 0 ^ 0 = 0
    ///   P1+P2 = 8
    ///   P3    = sum ^ y = 0x9E3779B9 ^ 2 = 0x9E3779BB
    ///   P4    = k ^ z = 0 ^ 0 = 0
    ///   P3+P4 = 0x9E3779BB
    ///   MX    = 8 ^ 0x9E3779BB = 0x9E3779B3
    ///   new a1[0] = 1 + 0x9E3779B3 = 0x9E3779B4
    ///
    /// We assert that our 1-round encrypt produces a1[0] == 0x9E3779B4.
    /// Any other value proves the cipher transliteration is wrong.
    #[test]
    fn vendor_first_iter_hand_traced() {
        let mut buf = [0u8; ENC_PACKET_LEN];
        buf[0] = 0x01;
        buf[4] = 0x02;
        let key = key_from_mac(0x01020304);
        encrypt_n_rounds(&mut buf, &key, 1);
        let a0 = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        assert_eq!(
            a0, 0x9E3779B4,
            "first-iter hand-traced word mismatch: got 0x{:08X}", a0
        );
    }

    /// Same shape as [`encrypt`] but takes the round count as an
    /// argument. Kept test-private so the public API stays fixed to
    /// the vendor's 6 rounds.
    fn encrypt_n_rounds(buf: &mut [u8; ENC_PACKET_LEN], key: &[u8; 16], rounds: u32) {
        let mut a1 = read_words_le(buf);
        let a2 = read_key_words(key);
        let n = ENC_WORDS;
        let mut a3 = a1[n - 1];
        let mut sum: u32 = 0;
        for _ in 0..rounds {
            sum = sum.wrapping_add(DELTA);
            let a5 = (sum >> 2) & 3;
            let mut p = 0usize;
            while p < n - 1 {
                let y = a1[p + 1];
                let m = mx(a3, y, sum, a5, p, &a2);
                a1[p] = a1[p].wrapping_add(m);
                a3 = a1[p];
                p += 1;
            }
            let y = a1[0];
            let m = mx(a3, y, sum, a5, n - 1, &a2);
            a1[n - 1] = a1[n - 1].wrapping_add(m);
            a3 = a1[n - 1];
        }
        let _ = a3;
        write_words_le(buf, &a1);
    }

    /// Pin the full 6-round output for a deterministic input so any
    /// accidental change to the cipher (wrong precedence, swapped
    /// round count, wrong key endianness) fails CI loudly. Combined
    /// with the hand-traced single-iter test above, this locks the
    /// entire algorithm against drift.
    #[test]
    fn vendor_snapshot_six_rounds_pinned() {
        let mut buf = [0u8; ENC_PACKET_LEN];
        for (i, b) in buf.iter_mut().enumerate() {
            *b = i as u8;
        }
        let key = key_from_mac(0x01FBC068);
        encrypt(&mut buf, &key);
        let h = fxhash(&buf);
        // Captured from the very first green run of
        // `vendor_first_iter_hand_traced` above. If you change the
        // cipher and this fires legitimately, ALSO re-derive the
        // hand-traced math in `vendor_first_iter_hand_traced` —
        // it should not change unless the vendor cipher itself
        // changes upstream.
        assert_eq!(
            h, 0x0231079FEAC98A2E,
            "6-round ciphertext snapshot drifted: got 0x{:016X}", h
        );
    }

    /// FNV-style 64-bit hash; used only to compress the pinned
    /// ciphertext snapshot into a single literal.
    fn fxhash(data: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in data {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }

    // ---------- 3. Wrong key produces garbage ----------

    #[test]
    fn wrong_key_does_not_decrypt() {
        let key_a = key_from_mac(0x01FBC068);
        let key_b = key_from_mac(0x01FBC069); // off by one byte
        let plain = seed(0);
        let mut buf = plain;
        encrypt(&mut buf, &key_a);
        decrypt(&mut buf, &key_b);
        assert_ne!(buf, plain, "wrong key must NOT recover plaintext");
        let same = buf
            .iter()
            .zip(plain.iter())
            .filter(|(a, b)| a == b)
            .count();
        assert!(
            same < ENC_PACKET_LEN / 4,
            "wrong key still left {}/{} bytes matching — cipher weak or test broken",
            same,
            ENC_PACKET_LEN
        );
    }

    // ---------- 4 & 5. Length-based detection ----------

    #[test]
    fn length_detection_classifies_plaintext_correctly() {
        assert!(!is_encrypted_length(16), "plaintext header-only");
        assert!(!is_encrypted_length(72), "plaintext mouse-shaped");
        assert!(!is_encrypted_length(127));
        assert!(!is_encrypted_length(129));
        assert!(!is_encrypted_length(0));
    }

    #[test]
    fn length_detection_classifies_encrypted_correctly() {
        assert!(is_encrypted_length(128));
    }
}
