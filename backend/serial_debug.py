#!/usr/bin/env python3
"""
Streamcheats firmware serial debug tool — companion to the KMBox Net
Translator.

Sends 9-byte Streamcheats binary packets directly to the Teensy over the
serial port, byte-for-byte identical to the production
``FirmwareInterface.create_spoofed_hid_report`` builder in the Python
``sunbox_interface`` reference. Bypasses UDP and bypasses the translator
entirely — use it when you need to isolate a firmware-side issue from a
translator-side one.

Requirements:
    pip install pyserial

Usage:
    python serial_debug.py --port COM7
    python serial_debug.py --port COM7 --baud 115200

Arguments:
    --port   Serial port name (required). COM<n> on Windows,
             /dev/ttyUSB<n> on Linux.
    --baud   Baud rate. Defaults to 115200 to match the firmware.

The interactive menu (movement shortcuts, button clicks, spam loop,
heartbeat) is described at runtime once the port is open. The right
column of every OUT line is the exact hex the firmware will receive.
"""

import argparse
import sys
import threading
import time

try:
    import serial
except ImportError:
    print("Error: pyserial not installed. Run: pip install pyserial")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Packet builder — copied verbatim from FirmwareInterface.create_spoofed_hid_report
# ---------------------------------------------------------------------------
def create_spoofed_hid_report(mouse_buttons, desired_x, desired_y, enable_sens_reduction=False):
    """Build the 9-byte length-prefixed mouse packet the firmware expects.

    Layout (post-length-prefix, indices match ``data[]`` in the firmware):
        [0] buttons (bitmask: 0x01=L 0x02=R 0x04=M 0x08=S1 0x10=S2)
        [1] x_lo  — direct int8 in [-127, 126]; 0x7F if x >= 127;
                    0x80 if x <= -128 (overflow sentinel)
        [2] y_lo  — same convention
        [3] sensReduction (0/1) — firmware reads as scrollWheel slot
        [4-5] x extended (i16 LE) — always populated
        [6-7] y extended (i16 LE) — always populated
    """
    data = bytearray(8)
    data[0] = mouse_buttons & 0xFF

    if desired_x >= 127:
        data[1] = 0x7F
    elif desired_x <= -128:
        data[1] = 0x80
    else:
        data[1] = desired_x & 0xFF

    if desired_y >= 127:
        data[2] = 0x7F
    elif desired_y <= -128:
        data[2] = 0x80
    else:
        data[2] = desired_y & 0xFF

    data[3] = 1 if enable_sens_reduction else 0
    data[4] = desired_x & 0xFF
    data[5] = (desired_x >> 8) & 0xFF
    data[6] = desired_y & 0xFF
    data[7] = (desired_y >> 8) & 0xFF

    return bytearray([len(data)]) + data


def create_settings_report(setting_id, value):
    """Build a 9-byte settings packet (length prefix = 3).

    Mirrors ``FirmwareInterface.create_settings_report``. Useful as a
    cheap heartbeat — setting_id=0 requests the firmware version.
    """
    data = bytearray(8)
    data[0] = setting_id & 0xFF
    value_bytes = int(value).to_bytes(2, byteorder="little", signed=True)
    data[1:3] = value_bytes
    return bytearray([3]) + data


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------
def hex_str(data):
    return " ".join(f"{b:02X}" for b in data)


def send(ser, packet, label):
    ser.write(bytes(packet))
    ser.flush()
    print(f"  OUT ({ser.port}): {hex_str(packet)}  -- {label}")


def reader_loop(ser, stop_event):
    """Print every newline-terminated line the firmware sends back."""
    buffer = bytearray()
    while not stop_event.is_set():
        try:
            n = ser.in_waiting
            if n:
                buffer.extend(ser.read(n))
                while b"\n" in buffer:
                    line, _, rest = buffer.partition(b"\n")
                    buffer = bytearray(rest)
                    text = line.rstrip(b"\r").decode("utf-8", errors="replace")
                    if text:
                        print(f"\n  IN  ({ser.port}): {text}")
            else:
                time.sleep(0.02)
        except (serial.SerialException, OSError) as e:
            print(f"\n  [reader error] {e}")
            stop_event.set()
            return


# ---------------------------------------------------------------------------
# Action shortcuts
# ---------------------------------------------------------------------------
def move(ser, dx, dy, label=None):
    label = label or f"move dx={dx} dy={dy}"
    send(ser, create_spoofed_hid_report(0, dx, dy), label)


def button(ser, mask, label):
    send(ser, create_spoofed_hid_report(mask, 0, 0), label)


def click(ser, mask, label, hold_ms=50):
    button(ser, mask, f"{label} down")
    time.sleep(hold_ms / 1000.0)
    button(ser, 0x00, f"{label} up")


def heartbeat(ser):
    send(ser, create_settings_report(0, 0), "heartbeat (firmware version request)")


# ---------------------------------------------------------------------------
# Menu
# ---------------------------------------------------------------------------
MENU = """
============================================================
  SunBox Serial Debug Tool
============================================================
  Movement (relative)
    1) Move right 100px
    2) Move left  100px
    3) Move up    100px
    4) Move down  100px
    5) Custom move (enter dx, dy)
    6) Spam move right 100px every 10ms for 1 second
  Buttons
    L) Left  click
    R) Right click
    M) Middle click
    P) Left press  (hold down)
    U) All buttons up (release)
  Misc
    H) Heartbeat (firmware version request)
    S) Show last status (R:/S:/C: line from firmware)
    Q) Quit

  Choice: """


def menu_loop(ser):
    print(MENU.rstrip("\n"))
    last_status = None
    while True:
        try:
            choice = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not choice:
            print(MENU)
            continue
        c = choice.lower()
        if c == "1":
            move(ser, 100, 0, "right 100px")
        elif c == "2":
            move(ser, -100, 0, "left 100px")
        elif c == "3":
            move(ser, 0, -100, "up 100px")
        elif c == "4":
            move(ser, 0, 100, "down 100px")
        elif c == "5":
            try:
                dx = int(input("    dx: ").strip())
                dy = int(input("    dy: ").strip())
            except ValueError:
                print("    invalid numbers")
                continue
            move(ser, dx, dy)
        elif c == "6":
            print("    sending 100 packets, 10ms apart...")
            for _ in range(100):
                move(ser, 100, 0, "spam right 100px")
                time.sleep(0.010)
        elif c == "l":
            click(ser, 0x01, "left")
        elif c == "r":
            click(ser, 0x02, "right")
        elif c == "m":
            click(ser, 0x04, "middle")
        elif c == "p":
            button(ser, 0x01, "left press (hold)")
        elif c == "u":
            button(ser, 0x00, "all release")
        elif c == "h":
            heartbeat(ser)
        elif c == "s":
            print(f"    last status: {last_status or '(none received yet)'}")
        elif c == "q":
            return
        elif c == "?":
            print(MENU)
        else:
            print(f"    unknown choice: {choice!r}  (type ? for menu, Q to quit)")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", required=True, help="Serial port (e.g. COM8 on Windows, /dev/ttyUSB0 on Linux)")
    ap.add_argument("--baud", type=int, default=115200, help="Baud rate (default 115200)")
    args = ap.parse_args()

    print(f"Opening {args.port} @ {args.baud} ...")
    try:
        ser = serial.Serial(args.port, baudrate=args.baud, timeout=2)
    except serial.SerialException as e:
        print(f"  could not open {args.port}: {e}")
        sys.exit(1)
    print("  connected.")

    stop = threading.Event()
    rt = threading.Thread(target=reader_loop, args=(ser, stop), daemon=True)
    rt.start()

    try:
        menu_loop(ser)
    finally:
        print("Closing.")
        stop.set()
        try:
            ser.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
