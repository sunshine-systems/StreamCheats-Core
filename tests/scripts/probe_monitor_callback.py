"""
probe_monitor_callback.py

Phased interactive probe for KMBox Net devices.

The script speaks the raw KMBox Net UDP protocol directly. No vendor `kmNet.pyd`
dependency. It:

  1. Sends `cmd_connect` (0xAF3C2828) to the device.
  2. Sends `cmd_monitor` (0x27388020) with the local listen port in head.rand
     (encoded as `port | (0xAA55 << 16)`) to subscribe to physical-input echoes.
  3. Runs a sequence of interactive PHASES. Each phase prints a clear
     instruction, waits for the user to press Enter, captures for a fixed
     duration, then prints a summary block. The listener thread runs the entire
     time; phases simply window the timestamps.
  4. After all phases, prints a final report that concatenates every phase
     summary back-to-back for easy copy/paste.
  5. Sends `cmd_monitor` again with rand port=0 to unsubscribe.

Each 20-byte monitor echo packet is parsed as:
  mouse:    <BBhhh    (report_id, buttons, x, y, wheel)         9 bytes
  keyboard: <BB10B    (report_id, modifier, keys[10])           12 bytes (11 packed)

Buttons (low byte): bit0=L, bit1=R, bit2=M, bit3=Side1, bit4=Side2.
"""

from __future__ import annotations

import argparse
import collections
import socket
import struct
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional, Tuple

# ---- Default config (overridable via CLI flags) ----
DEFAULT_IP = "127.0.0.1"
DEFAULT_PORT = 56873
DEFAULT_UUID = "00000000"
DEFAULT_LISTEN_PORT = 16001
DEFAULT_PHASE_SECONDS = 10.0
DEFAULT_NO_KEYBOARD = True

# ---- Protocol constants ----------------------------------------------------

CMD_CONNECT = 0xAF3C2828
CMD_MONITOR = 0x27388020
MONITOR_PORT_MAGIC = 0xAA55  # high 16 bits of head.rand for cmd_monitor

HEADER_FMT = "<IIII"  # mac, rand, indexpts, cmd
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # 16

# soft_mouse_t = 4 (button) + 4 (x) + 4 (y) + 4 (wheel) + 10*4 (point) = 56
SOFT_MOUSE_FMT = "<iiii" + ("i" * 10)
SOFT_MOUSE_SIZE = struct.calcsize(SOFT_MOUSE_FMT)  # 56

# Monitor echo body: mouse(9) + keyboard(12 packed as <BB10B) = 20 (with 1 pad)
MOUSE_REPORT_FMT = "<BBhhh"   # report_id, buttons, x, y, wheel (9 bytes)
KBD_REPORT_FMT = "<BB10B"     # report_id, modifier, keys[10] (12 bytes)
MOUSE_REPORT_SIZE = struct.calcsize(MOUSE_REPORT_FMT)  # 9
KBD_REPORT_SIZE = struct.calcsize(KBD_REPORT_FMT)      # 12
ECHO_PACKET_MIN = 20

# Button bits (low byte of HID buttons byte)
BUTTON_BITS = [
    ("LMB",  0x01),
    ("RMB",  0x02),
    ("MMB",  0x04),
    ("Side1", 0x08),
    ("Side2", 0x10),
]


# ---- Networking helpers ----------------------------------------------------

class CmdSender:
    """Sends KMBox commands to the device with monotonically increasing indexpts."""

    def __init__(self, sock: socket.socket, addr, mac: int):
        self.sock = sock
        self.addr = addr
        self.mac = mac
        self.indexpts = 0

    def _next_index(self) -> int:
        self.indexpts = (self.indexpts + 1) & 0xFFFFFFFF
        return self.indexpts

    def send(self, cmd: int, rand: int, body: bytes = b"") -> int:
        idx = self._next_index()
        header = struct.pack(HEADER_FMT, self.mac & 0xFFFFFFFF, rand & 0xFFFFFFFF,
                             idx, cmd & 0xFFFFFFFF)
        self.sock.sendto(header + body, self.addr)
        return idx

    def send_connect(self) -> int:
        # Body is soft_mouse_t, all zeros on connect.
        return self.send(CMD_CONNECT, rand=0, body=b"\x00" * SOFT_MOUSE_SIZE)

    def send_monitor(self, listen_port: int) -> int:
        # rand = port | (0xAA55 << 16); port=0 cancels.
        rand = (listen_port & 0xFFFF) | (MONITOR_PORT_MAGIC << 16)
        return self.send(CMD_MONITOR, rand=rand)


def parse_uuid(uuid_str: str) -> int:
    """Vendor SDK derives mac = u32::from_str_radix(uuid, 16)."""
    s = uuid_str.strip().lower()
    if s.startswith("0x"):
        s = s[2:]
    return int(s, 16) & 0xFFFFFFFF


# ---- Reader thread ---------------------------------------------------------

class Reader(threading.Thread):
    """Background listener. Pushes (t_relative_seconds, raw_bytes) onto a deque.

    t is seconds since `start_perf` (which is the subscribe time / t=0).
    """

    def __init__(self, sock: socket.socket,
                 buf: "Deque[Tuple[float, bytes]]",
                 buf_lock: threading.Lock,
                 start_perf: float, stop_evt: threading.Event):
        super().__init__(daemon=True)
        self.sock = sock
        self.buf = buf
        self.buf_lock = buf_lock
        self.start_perf = start_perf
        self.stop_evt = stop_evt
        self.first_packet_at: Optional[float] = None

    def run(self):
        self.sock.settimeout(0.2)
        while not self.stop_evt.is_set():
            try:
                data, _addr = self.sock.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                break
            t = time.perf_counter() - self.start_perf
            if len(data) < MOUSE_REPORT_SIZE:
                continue
            if self.first_packet_at is None:
                self.first_packet_at = t
            with self.buf_lock:
                self.buf.append((t, data))


# ---- Phase definitions -----------------------------------------------------

@dataclass
class PhaseDef:
    num: int
    name: str
    instruction: str  # what the user should do


PHASES: List[PhaseDef] = [
    PhaseDef(1, "Idle in the air, do nothing",
             "Hold the mouse OFF the desk in the air. Do NOT move it. "
             "Do NOT press any buttons. Stay still until told to stop."),
    PhaseDef(2, "Idle in the air, hold LMB down",
             "Hold the mouse in the air. PRESS AND HOLD the LEFT mouse button "
             "BEFORE pressing Enter. Do not move. Do not release until the "
             "phase ends."),
    PhaseDef(3, "Idle in the air, hold RMB down",
             "Hold the mouse in the air. PRESS AND HOLD the RIGHT mouse button "
             "BEFORE pressing Enter. Do not move. Do not release until the "
             "phase ends."),
    PhaseDef(4, "Idle in the air, hold MMB down",
             "Hold the mouse in the air. PRESS AND HOLD the MIDDLE mouse "
             "button (scroll wheel click) BEFORE pressing Enter. Do not move. "
             "Do not release until the phase ends."),
    PhaseDef(5, "Idle in the air, hold Side1 down",
             "Hold the mouse in the air. PRESS AND HOLD SIDE BUTTON 1 (BACK) "
             "BEFORE pressing Enter. Do not move. Do not release until the "
             "phase ends."),
    PhaseDef(6, "Idle in the air, hold Side2 down",
             "Hold the mouse in the air. PRESS AND HOLD SIDE BUTTON 2 "
             "(FORWARD) BEFORE pressing Enter. Do not move. Do not release "
             "until the phase ends."),
    PhaseDef(7, "Move mouse continuously, no buttons",
             "Place the mouse on the pad. MOVE IT IN SMOOTH CIRCLES "
             "continuously for the whole capture. Do NOT click any buttons."),
    PhaseDef(8, "Move mouse continuously while holding LMB",
             "Place the mouse on the pad. PRESS AND HOLD the LEFT mouse "
             "button, then MOVE IT IN CIRCLES (drag motion) for the whole "
             "capture. Do not release LMB until the phase ends."),
    PhaseDef(9, "Rapid LMB clicks",
             "CLICK the LEFT mouse button AS FAST AS YOU CAN for the whole "
             "capture. Do not move the mouse."),
    PhaseDef(10, "Scroll wheel up and down",
             "SCROLL the wheel up and down continuously for the whole "
             "capture. Do NOT click any buttons. Do not move the mouse."),
]


# ---- Analysis --------------------------------------------------------------

def percentile(sorted_vals: List[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * pct
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def _parse_packet(data: bytes) -> Tuple[Tuple[int, int, int, int, int],
                                        Optional[Tuple[int, int, Tuple[int, ...]]]]:
    """Returns (mouse_tuple, keyboard_tuple_or_None).

    mouse_tuple = (report_id, buttons, x, y, wheel)
    keyboard_tuple = (report_id, modifier, keys_tuple)
    """
    mouse = struct.unpack(MOUSE_REPORT_FMT, data[:MOUSE_REPORT_SIZE])
    kbd = None
    # Keyboard report follows mouse report. Echo packets are typically 20 bytes.
    # Some firmwares pack mouse(9) + keyboard(11) = 20, but our format string
    # yields 12 bytes for the keyboard half (1 pad). We try the strict size
    # first, then fall back to whatever remains.
    rest = data[MOUSE_REPORT_SIZE:]
    if len(rest) >= KBD_REPORT_SIZE:
        kfields = struct.unpack(KBD_REPORT_FMT, rest[:KBD_REPORT_SIZE])
        kbd = (kfields[0], kfields[1], tuple(kfields[2:]))
    elif len(rest) >= 2:
        # Tolerate 11-byte keyboard tail (no pad): rpt_id + mod + 9 keys.
        nkeys = len(rest) - 2
        fmt = "<BB" + ("B" * nkeys)
        kfields = struct.unpack(fmt, rest)
        kbd = (kfields[0], kfields[1], tuple(kfields[2:]))
    return mouse, kbd


@dataclass
class PhaseResult:
    num: int
    name: str
    instruction: str
    duration_target: float
    duration_actual: float
    summary_text: str = ""
    partial: bool = False


def _fmt_kbd_keys(keys: Tuple[int, ...]) -> str:
    return "[" + ",".join(f"0x{k:02X}" for k in keys) + "]"


def analyse_phase(phase: PhaseDef, target_duration: float, actual_duration: float,
                  packets: List[Tuple[float, bytes]],
                  phase_t0: float, partial: bool,
                  no_keyboard: bool = False) -> str:
    """Build a per-phase summary block. Times in `packets` are seconds since
    subscribe (t=0). `phase_t0` is also seconds since subscribe.
    """
    lines: List[str] = []
    title = f"=== Phase {phase.num}: {phase.name} ==="
    lines.append(title)
    lines.append(f"Duration:               {actual_duration:.2f} s"
                 + ("  (PARTIAL - interrupted)" if partial else ""))
    n = len(packets)
    lines.append(f"Packets received:       {n}")
    rate = (n / actual_duration) if actual_duration > 0 else 0.0
    lines.append(f"Effective rate:         {rate:.1f} pkt/s")

    # Inter-packet intervals (ms) within this phase.
    intervals_ms: List[float] = []
    for i in range(1, n):
        intervals_ms.append((packets[i][0] - packets[i - 1][0]) * 1000.0)
    intervals_sorted = sorted(intervals_ms)
    if intervals_sorted:
        imin = intervals_sorted[0]
        ip50 = percentile(intervals_sorted, 0.50)
        ip95 = percentile(intervals_sorted, 0.95)
        imax = intervals_sorted[-1]
        lines.append(
            f"Inter-packet intervals (ms): "
            f"min={imin:.2f} p50={ip50:.2f} p95={ip95:.2f} max={imax:.2f}"
        )
    else:
        lines.append("Inter-packet intervals (ms): n/a (fewer than 2 packets)")

    # Parse all packets in the phase.
    parsed: List[Tuple[float, Tuple[int, int, int, int, int],
                       Optional[Tuple[int, int, Tuple[int, ...]]]]] = []
    for (t, raw) in packets:
        try:
            mouse, kbd = _parse_packet(raw)
        except struct.error:
            continue
        parsed.append((t, mouse, kbd))

    # Distinct payloads.
    distinct_mouse = set()
    distinct_kbd = set()
    for (_t, m, k) in parsed:
        # m = (rpt, buttons, x, y, wheel) -> compare (buttons, x, y, wheel)
        distinct_mouse.add((m[1], m[2], m[3], m[4]))
        if k is not None:
            distinct_kbd.add((k[0], k[1], k[2]))
    lines.append(f"Distinct mouse payloads (buttons,x,y,wheel): {len(distinct_mouse)}")
    if not no_keyboard:
        lines.append(f"Distinct keyboard payloads:                  {len(distinct_kbd)}")

    # Button mask transitions.
    transitions: List[Tuple[float, int, int]] = []  # (t, from, to)
    prev_mask: Optional[int] = None
    for (t, m, _k) in parsed:
        mask = m[1] & 0xFF
        if prev_mask is None:
            prev_mask = mask
            continue
        if mask != prev_mask:
            transitions.append((t, prev_mask, mask))
            prev_mask = mask
    sample_trans = transitions[:5]
    trans_str = ", ".join(
        f"0x{a:02X}->0x{b:02X} @ t={t:.3f}s" for (t, a, b) in sample_trans
    )
    if len(transitions) > len(sample_trans):
        trans_str += f", ... (+{len(transitions) - len(sample_trans)} more)"
    lines.append(f"Button mask transitions:  {len(transitions)}"
                 + (f"  ({trans_str})" if trans_str else ""))

    # First / last packet relative to subscribe (t=0).
    if parsed:
        first_ms = parsed[0][0] * 1000.0
        last_ms = parsed[-1][0] * 1000.0
        lines.append(f"First packet @ t+{first_ms:.1f}ms after subscribe")
        lines.append(f"Last  packet @ t+{last_ms:.1f}ms")
    else:
        lines.append("First packet @ t+--- after subscribe")
        lines.append("Last  packet @ t+---")

    # Byte field stats.
    buttons_hist: Dict[int, int] = collections.Counter()
    xs: List[int] = []
    ys: List[int] = []
    ws: List[int] = []
    for (_t, m, _k) in parsed:
        buttons_hist[m[1] & 0xFF] += 1
        xs.append(m[2])
        ys.append(m[3])
        ws.append(m[4])

    lines.append("Mouse byte fields seen:")
    if buttons_hist:
        bh_items = sorted(buttons_hist.items())
        bh_str = ", ".join(f"0x{k:02X}: {v}" for (k, v) in bh_items)
        lines.append(f"  buttons: {{ {bh_str} }}")
    else:
        lines.append("  buttons: {}")

    def _range_line(label: str, vals: List[int]) -> str:
        if not vals:
            return f"  {label} range: [---..---]   nonzero count: 0"
        nz = sum(1 for v in vals if v != 0)
        return (f"  {label} range: [{min(vals)}..{max(vals)}]   "
                f"nonzero count: {nz}")

    lines.append(_range_line("x   ", xs))
    lines.append(_range_line("y   ", ys))
    lines.append(_range_line("wheel", ws))

    # Sample packets: first 3, mid, last 3.
    lines.append("Sample packets (first 3, mid, last 3):")
    idx_set: List[int] = []
    if parsed:
        for i in range(min(3, len(parsed))):
            idx_set.append(i)
        mid = len(parsed) // 2
        if mid not in idx_set:
            idx_set.append(mid)
        for i in range(max(0, len(parsed) - 3), len(parsed)):
            if i not in idx_set:
                idx_set.append(i)
        idx_set = sorted(set(idx_set))
        for i in idx_set:
            t, m, k = parsed[i]
            tms = t * 1000.0
            if no_keyboard:
                lines.append(
                    f"  t+{tms:>8.1f}ms btn=0x{m[1] & 0xFF:02X} "
                    f"x={m[2]:>4d} y={m[3]:>4d} w={m[4]:>3d}"
                )
            else:
                kmod = (k[1] if k else 0)
                keys = (k[2] if k else ())
                lines.append(
                    f"  t+{tms:>8.1f}ms btn=0x{m[1] & 0xFF:02X} "
                    f"x={m[2]:>4d} y={m[3]:>4d} w={m[4]:>3d} | "
                    f"kbmod=0x{kmod:02X} keys={_fmt_kbd_keys(keys)}"
                )
    else:
        lines.append("  (no packets)")

    # Verdict heuristics.
    verdict = _verdict_for_phase(phase, parsed, actual_duration, rate, transitions)
    lines.append(f"Verdict: {verdict}")

    return "\n".join(lines)


def _verdict_for_phase(phase: PhaseDef,
                       parsed: List[Tuple[float, Tuple[int, int, int, int, int],
                                          Optional[Tuple[int, int, Tuple[int, ...]]]]],
                       duration: float, rate: float,
                       transitions: List[Tuple[float, int, int]]) -> str:
    n = len(parsed)
    if n == 0:
        if phase.num <= 6:
            return "NO PACKETS DURING IDLE (device silent while held/still)"
        return "NO PACKETS (device emitted nothing during this phase)"

    # Idle phases (1-6): assess whether device emits while held/still.
    if phase.num == 1:
        if n == 0:
            return "NO PACKETS DURING IDLE"
        return (f"EMITS WHILE IDLE: yes ({n} pkts at ~{rate:.0f} Hz over "
                f"{duration:.1f}s, no buttons)")
    if phase.num in (2, 3, 4, 5, 6):
        # Count packets where the expected button bit is set.
        bit_map = {2: 0x01, 3: 0x02, 4: 0x04, 5: 0x08, 6: 0x10}
        bit = bit_map[phase.num]
        held = sum(1 for (_t, m, _k) in parsed if (m[1] & bit))
        if held == 0:
            return (f"BUTTON NEVER OBSERVED HELD (bit 0x{bit:02X} not set in "
                    f"any of {n} pkts)")
        held_rate = held / duration if duration > 0 else 0.0
        if held_rate >= 200.0:
            kind = "PER-FRAME"
        elif held_rate >= 50.0:
            kind = "AMBIGUOUS"
        else:
            kind = "PER-TRANSITION"
        return (f"{kind}: {held}/{n} pkts have bit 0x{bit:02X} set "
                f"(~{held_rate:.0f} Hz while held). Transitions: "
                f"{len(transitions)}")
    if phase.num == 7:
        nz = sum(1 for (_t, m, _k) in parsed if (m[2] != 0 or m[3] != 0))
        return (f"MOTION: {nz}/{n} pkts have nonzero x/y (~{rate:.0f} Hz "
                f"total)")
    if phase.num == 8:
        nz = sum(1 for (_t, m, _k) in parsed if (m[2] != 0 or m[3] != 0))
        held = sum(1 for (_t, m, _k) in parsed if (m[1] & 0x01))
        return (f"DRAG: motion {nz}/{n} pkts, LMB held in {held}/{n} pkts "
                f"(~{rate:.0f} Hz)")
    if phase.num == 9:
        return (f"CLICKS: {len(transitions)} button-mask transitions in "
                f"{duration:.1f}s ({rate:.0f} pkts/s)")
    if phase.num == 10:
        nz = sum(1 for (_t, m, _k) in parsed if m[4] != 0)
        return (f"SCROLL: {nz}/{n} pkts have nonzero wheel (~{rate:.0f} Hz "
                f"total)")
    return f"{n} pkts, {rate:.0f} pkt/s"


# ---- Capture orchestration -------------------------------------------------

def parse_phase_set(s: str) -> List[int]:
    if not s:
        return []
    out: List[int] = []
    for tok in s.split(","):
        tok = tok.strip()
        if not tok:
            continue
        out.append(int(tok))
    return out


def slice_packets(buf: "Deque[Tuple[float, bytes]]",
                  buf_lock: threading.Lock,
                  t_start: float, t_end: float) -> List[Tuple[float, bytes]]:
    with buf_lock:
        snapshot = list(buf)
    return [(t, d) for (t, d) in snapshot if t_start <= t <= t_end]


def run_phase(phase: PhaseDef, duration: float,
              buf: "Deque[Tuple[float, bytes]]",
              buf_lock: threading.Lock,
              subscribe_t0: float,
              no_keyboard: bool = False) -> PhaseResult:
    print()
    print("-" * 72)
    print(f"PHASE {phase.num}: {phase.name}")
    print("-" * 72)
    print("INSTRUCTION:")
    print(f"  {phase.instruction}")
    print(f"Capture duration: {duration:.1f} s")
    try:
        input("Press Enter when you are READY and in position (Ctrl-C to abort)... ")
    except EOFError:
        # No stdin; auto-proceed.
        print("(no stdin; auto-proceeding)")

    print(f"Capturing for {duration:.1f}s ...")
    partial = False
    t_start_rel = time.perf_counter() - subscribe_t0
    end_at = time.perf_counter() + duration
    try:
        while True:
            remaining = end_at - time.perf_counter()
            if remaining <= 0:
                break
            time.sleep(min(0.1, remaining))
    except KeyboardInterrupt:
        partial = True
        print("\n  (Ctrl-C: ending this phase early)")
    t_end_rel = time.perf_counter() - subscribe_t0
    actual = t_end_rel - t_start_rel

    pkts = slice_packets(buf, buf_lock, t_start_rel, t_end_rel)
    summary = analyse_phase(phase, duration, actual, pkts, t_start_rel, partial,
                            no_keyboard=no_keyboard)
    print()
    print(summary)

    result = PhaseResult(num=phase.num, name=phase.name,
                         instruction=phase.instruction,
                         duration_target=duration, duration_actual=actual,
                         summary_text=summary, partial=partial)
    if partial:
        # Re-raise so caller can stop the whole run cleanly.
        raise KeyboardInterrupt
    return result


def print_final_report(results: List[PhaseResult]) -> None:
    print()
    print("=" * 72)
    print("=== FINAL REPORT ===")
    print("=" * 72)
    if not results:
        print("(no phases completed)")
        return
    for r in results:
        print()
        print(r.summary_text)
    print()
    print("=" * 72)
    print(f"Completed {len(results)} phase(s).")


# ---- Main ------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Interactive phased probe of a KMBox Net device's monitor "
                    "echo stream.")
    ap.add_argument("--ip", default=DEFAULT_IP, help="Device IP, e.g. 192.168.2.188")
    ap.add_argument("--port", default=DEFAULT_PORT, type=int,
                    help="Device UDP port, e.g. 1282")
    ap.add_argument("--uuid", default=DEFAULT_UUID,
                    help="Device UUID (hex string), e.g. AF425414")
    ap.add_argument("--listen-port", type=int, default=DEFAULT_LISTEN_PORT,
                    help="Local UDP port to receive monitor echoes "
                         "(default: 16001)")
    ap.add_argument("--phase-seconds", type=float, default=DEFAULT_PHASE_SECONDS,
                    help="Capture duration per phase (default: 10).")
    ap.add_argument("--skip-phases", default="",
                    help="Comma-separated phase numbers to skip, e.g. 1,3,5")
    ap.add_argument("--only-phases", default="",
                    help="Comma-separated phase numbers to run "
                         "(overrides --skip-phases), e.g. 2,7")
    ap.add_argument("--keyboard", action="store_true", default=False,
                    help="Re-enable keyboard-related lines in per-phase "
                         "summary (default: suppressed). Packet parsing is "
                         "unchanged regardless; only reporting is affected.")
    args = ap.parse_args()
    no_keyboard = DEFAULT_NO_KEYBOARD and not args.keyboard

    try:
        mac = parse_uuid(args.uuid)
    except ValueError:
        print(f"ERROR: --uuid {args.uuid!r} is not a hex string", file=sys.stderr)
        return 2

    try:
        skip_set = set(parse_phase_set(args.skip_phases))
        only_set = set(parse_phase_set(args.only_phases))
    except ValueError:
        print("ERROR: --skip-phases / --only-phases must be comma-separated "
              "integers.", file=sys.stderr)
        return 2

    if only_set:
        chosen = [p for p in PHASES if p.num in only_set]
    else:
        chosen = [p for p in PHASES if p.num not in skip_set]

    if not chosen:
        print("ERROR: no phases selected.", file=sys.stderr)
        return 2

    device_addr = (args.ip, args.port)

    # Listening socket for monitor echoes.
    listen_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        listen_sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    except OSError:
        pass  # best effort
    try:
        listen_sock.bind(("0.0.0.0", args.listen_port))
    except OSError as e:
        print(f"ERROR: cannot bind UDP {args.listen_port}: {e}", file=sys.stderr)
        return 2

    # Separate sending socket so reader thread can't interfere.
    send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send_sock.settimeout(1.0)
    sender = CmdSender(send_sock, device_addr, mac)

    buf: Deque[Tuple[float, bytes]] = collections.deque()
    buf_lock = threading.Lock()
    stop_evt = threading.Event()

    # ---- Handshake ----
    print(f"Connecting to {args.ip}:{args.port} (uuid={args.uuid}, "
          f"mac=0x{mac:08X})...")
    sender.send_connect()
    try:
        data, _ = send_sock.recvfrom(2048)
        print(f"  Connect reply received: {len(data)} bytes "
              f"(header echoed back).")
    except socket.timeout:
        print("  WARN: no reply to cmd_connect within 1s. Continuing.")

    # ---- Subscribe to monitor (t=0 reference) ----
    print(f"Subscribing to monitor on local port {args.listen_port}...")
    subscribe_t0 = time.perf_counter()
    reader = Reader(listen_sock, buf, buf_lock, subscribe_t0, stop_evt)
    reader.start()
    sender.send_monitor(args.listen_port)
    try:
        data, _ = send_sock.recvfrom(2048)
        print(f"  Monitor subscribe reply: {len(data)} bytes.")
    except socket.timeout:
        print("  WARN: no reply to cmd_monitor subscribe within 1s. "
              "Continuing.")

    print()
    print(f"Will run {len(chosen)} phase(s): "
          + ", ".join(str(p.num) for p in chosen))
    print(f"Per-phase capture: {args.phase_seconds:.1f}s")
    print("Listener thread is running in the background for the whole session.")

    results: List[PhaseResult] = []
    interrupted = False
    try:
        for i, phase in enumerate(chosen):
            try:
                r = run_phase(phase, args.phase_seconds, buf, buf_lock,
                              subscribe_t0, no_keyboard=no_keyboard)
                results.append(r)
            except KeyboardInterrupt:
                # run_phase already attached a partial result via summary print;
                # capture it for the final report by re-running the slice.
                t_now_rel = time.perf_counter() - subscribe_t0
                # The phase that just aborted has its summary already printed;
                # we still want it in the final report. Reconstruct minimally
                # by slicing from start-of-phase if possible. Easiest: re-run
                # analyse on the most recent window using approximate start.
                # We don't have phase_t_start here, so fall back to "no result"
                # for the partial phase (its summary was already printed).
                interrupted = True
                break

            if i < len(chosen) - 1:
                next_phase = chosen[i + 1]
                print()
                print(f"Phase {phase.num} complete. Release all buttons. "
                      f"Press Enter for next phase (phase {next_phase.num}: "
                      f"{next_phase.name}).")
                try:
                    input("> ")
                except EOFError:
                    print("(no stdin; auto-proceeding)")
                except KeyboardInterrupt:
                    interrupted = True
                    break
    finally:
        # ---- Unsubscribe (best effort) ----
        try:
            sender.send_monitor(0)
        except OSError:
            pass
        stop_evt.set()
        reader.join(timeout=1.0)
        try:
            listen_sock.close()
        except OSError:
            pass
        try:
            send_sock.close()
        except OSError:
            pass

        print_final_report(results)
        if interrupted:
            print("(Run was interrupted; final report covers completed phases "
                  "only.)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
