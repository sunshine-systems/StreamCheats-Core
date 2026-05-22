"""
Reset an FT232H whose EEPROM was reprogrammed to a non-FTDI VID/PID
(currently 1A86:7523 / CH340 impersonation) back to FTDI defaults
(0403:6014) so FT_PROG can see it again.

ONE-TIME SETUP (per machine, per device):
    1. Plug in the FT232H.
    2. Run Zadig (https://zadig.akeo.ie/). Options -> List All Devices.
    3. Select the device showing VID 1A86 PID 7523.
    4. Pick driver "libusbK" (or "WinUSB") in the right-hand box.
    5. Click "Replace Driver". Wait for success.
    6. Run this script.

After it finishes the chip will re-enumerate as 0403:6014. To put the
FTDI D2XX driver back on it (so FT_PROG sees it), run Zadig again,
select the new 0403:6014 device, and click "Restore Original Driver".
"""

import sys
import subprocess

CURRENT_VID = 0x1A86
CURRENT_PID = 0x7523


def ensure_pyftdi():
    try:
        import pyftdi  # noqa: F401
    except ImportError:
        print("pyftdi not found, installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyftdi"])


SIO_REQ_ERASE_EEPROM = 0x92
FTDI_VENDOR_OUT = 0x40


def main():
    ensure_pyftdi()

    from pyftdi.eeprom import FtdiEeprom
    from pyftdi.ftdi import Ftdi
    from usb.core import USBError

    Ftdi.add_custom_vendor(CURRENT_VID)
    Ftdi.add_custom_product(CURRENT_VID, CURRENT_PID)

    url = f"ftdi://0x{CURRENT_VID:04x}:0x{CURRENT_PID:04x}/1"
    print(f"Opening {url} ...")

    eeprom = FtdiEeprom()
    try:
        eeprom.open(url)
    except USBError as e:
        print(f"\nERROR: could not open device: {e}")
        print("\nMost likely cause: Zadig hasn't replaced the driver yet.")
        print("See the setup instructions at the top of this script.")
        sys.exit(1)
    except Exception as e:
        print(f"\nERROR: {e}")
        print("\nIf this says 'no backend available', install libusb:")
        print("    pip install libusb")
        sys.exit(1)

    print("Device opened. Current EEPROM:")
    eeprom.dump_config()

    print("\nSending FTDI ERASE_EEPROM vendor command (bRequest 0x92)...")
    ftdi = eeprom._ftdi
    usb_dev = getattr(ftdi, 'usb_dev', None) or getattr(ftdi, '_usb_dev')
    try:
        usb_dev.ctrl_transfer(
            FTDI_VENDOR_OUT,
            SIO_REQ_ERASE_EEPROM,
            0, 0, None, 1000,
        )
    except USBError as e:
        print(f"\nERROR: erase vendor request failed: {e}")
        sys.exit(1)

    print("Erase command accepted by chip.")
    print("\nUnplug and replug the device now.")
    print("It should re-enumerate as VID 0403 PID 6014 and appear in FT_PROG.")


if __name__ == "__main__":
    main()
