# Test clients (third-party)

The clients in this directory are **not part of the StreamCheats Core project**. They are external, upstream-maintained programs we pull down locally to validate that the translator correctly handles real-world `kmbox-net` UDP traffic. Anything in this directory was pulled verbatim from its upstream source — **do not modify it**. If you find a bug in one of these clients, file it upstream; if you need to tweak behavior for testing, fork it elsewhere, don't patch in-tree.

The cloned trees are git-ignored (see `.gitignore` in this directory and at the repo root) so they never end up in our commit history.

---

## `unibot-kmbox/` — ChuckNorris9939/Unibot-kmbox

- **Source:** <https://github.com/ChuckNorris9939/Unibot-kmbox>
- **Commit:** `4807242d9226a6a7234146cf560fefd0b306d071` (upstream commit date 2023-12-20)
- **Cloned:** 2026-05-21 (full `git clone`; `.git` preserved so you can `git pull` for updates)
- **License:** GNU General Public License v3.0 (SPDX: `GPL-3.0-or-later`) — see `unibot-kmbox/LICENSE.txt`.

A kmbox-net-enabled fork of the Unibot color-detection aim helper. For our purposes its value is that it pushes **real, high-rate, screen-capture-driven kmbox UDP traffic** — i.e. it exercises the translator the way an actual user would, not the way a unit test would. Used for live integration testing once the per-opcode demos pass.

### How to point this at the translator

Edit `unibot-kmbox/config.ini`, section `[communication]` (it is lowercase upstream, despite docs that sometimes capitalize it). The fields present in the upstream file are:

```ini
[communication]
type = none
encrypt = false
ip = 0.0.0.0
port = 50124
com_port = COM1
```

Set `type` to whatever kmbox mode Unibot expects (consult upstream README), and set `ip` / `port` to the address the translator's kmbox-net listener is bound to.

---

## `vendor-demos/python_demo/` — kvmaibox/kmboxnet (official vendor SDK)

- **Source:** <https://github.com/kvmaibox/kmboxnet>
- **Commit:** `9b62283c6271e8e594f3b97986fed291deb4318f`
- **Cloned:** 2026-05-21 (shallow clone to a temp directory; only `python_demo/` was copied here, then the temp clone was deleted — `.git` is intentionally absent)
- **License:** No `LICENSE` file is present in the upstream repo (only a Chinese-language `Readme` pointing at <http://www.kmbox.top>). Treat as **proprietary vendor sample code — see upstream**. Do not redistribute.

These are the manufacturer's own per-opcode demonstrations of the `kmbox-net` protocol. Each script exercises a single, narrow slice of the API (mouse moves, button masks, keyboard events, the monitor subscription path, the encrypted variants, etc.), which makes them ideal deterministic fuzzers for verifying that the translator decodes each opcode correctly.

Scripts present:
- `mouse.py` — non-encrypted mouse API (`mask_left`, `mask_right`, motion, buttons)
- `mouse_enc.py` — encrypted mouse API
- `keyboard_test.py` — `keydown` / `keyup` / `keypress` (and `enc_*` encrypted variants)
- `monitor.py` — subscribes to the kmbox monitor stream and prints physical input
- `mask.py` — input-blocking opcodes
- `trace.py` — motion-trace demos
- `playmp4.py` — video-driven scripted input
- `稳定性测试.py` — stability/soak test
- `调用速度测试.py` — API call-rate test
- `鼠标移动控制.py` — mouse motion control
- `yolov5_kmNet_Demo/` — large YOLOv5-based aim demo (not protocol-relevant; ignore for our testing)

### How to point this at the translator

Each demo hard-codes the device connection at the top of the file. Edit these three lines (verbatim, as they appear upstream):

```python
ip='192.168.2.188'
port ='1282'
uuid ='AF425414'
kmNet.init(ip,port,uuid)
```

Set `ip` to the translator's listen address (typically `'127.0.0.1'` for loopback testing), `port` to the translator's kmbox-net UDP port, and `uuid` to whatever UUID the translator is configured to accept. The `monitor.py` script additionally calls `kmNet.monitor(5001)` — that `5001` is the local UDP port the demo opens to *receive* monitor packets back from the translator; change it if it collides with something on your machine.

---

## Recommended test order

1. **`vendor-demos/python_demo/mouse.py`** — per-opcode validation against the simplest, most-used path (mouse buttons + motion). If this works, the basic request/response framing is sound.
2. **`vendor-demos/python_demo/monitor.py`** — exercises the kmbox_net monitor *subscriber* path (the one just shipped). Confirms the translator can not only receive opcodes but also push monitor events back to a subscribed client.
3. **`vendor-demos/python_demo/keyboard_test.py`** — extends opcode coverage to the keyboard surface.
4. **`unibot-kmbox/`** — graduate to live, high-rate, screen-capture-driven traffic once the per-opcode demos all pass. This is where you find ordering, throughput, and back-pressure bugs the deterministic demos won't surface.

---

## What NOT to do

- **Do not commit these trees into our repo.** They have their own licenses (GPL-3.0 for Unibot; vendor-proprietary-and-unlicensed for the kmboxnet demos) and their own upstream lifecycles. The `tests/` directory is `.gitignore`d at the repo root, and the cloned subtrees are additionally ignored by `tests/.gitignore`, so `git add` won't pick them up — keep it that way.
- **Do not patch these files in place.** If a demo needs changes for a test scenario, copy it out to a scratch dir and edit there. In-tree edits will be lost the next time someone re-clones, and they make the attribution above a lie.
- **Do not run these clients pointed at the translator without an isolated test machine / VM.** They send real HID input; an unconfigured run can take over your mouse and keyboard.
