#!/usr/bin/env python3
"""Emulate mouse-wheel notches via /dev/uinput.

ydotool 1.0.4 has no wheel command, so NetMouse's ydotool backend cannot scroll.
This writes REL_WHEEL / REL_HWHEEL events straight to a uinput device instead.

Usage:  wheel.py <notches> [h]
        notches > 0 = scroll down/right, < 0 = scroll up/left (X11 convention)
        trailing 'h' = horizontal wheel
Exit 0 on success, 1 on failure.
"""
import fcntl
import os
import struct
import sys
import time

EV_SYN = 0x00
EV_REL = 0x02
REL_HWHEEL = 0x06
REL_WHEEL = 0x08
SYN_REPORT = 0

UI_DEV_SETUP = 0x405C5503
UI_SET_EVBIT = 0x40045564
UI_SET_RELBIT = 0x40045566
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

BUS_USB = 0x03

# struct input_event on x86_64: timeval(16) + type(2) + code(2) + value(4)
EVENT_FMT = "llHHi"


def emit(fd, etype, code, value, sleep=0.0):
    if sleep:
        time.sleep(sleep)
    now = time.time()
    sec = int(now)
    usec = int((now - sec) * 1_000_000)
    os.write(fd, struct.pack(EVENT_FMT, sec, usec, etype, code, value))


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: wheel.py <notches> [h]", file=sys.stderr)
        return 1

    horizontal = args[-1].endswith("h")
    if horizontal:
        args[-1] = args[-1][:-1]
    try:
        notches = int(args[0])
    except ValueError:
        print("notches must be an integer", file=sys.stderr)
        return 1
    if notches == 0:
        return 0

    try:
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    except OSError as e:
        print(f"cannot open /dev/uinput: {e}", file=sys.stderr)
        return 1

    name = b"netmouse-wheel"
    setup = struct.pack("HHHH", BUS_USB, 0x1234, 0x5678, 1)
    setup += name + b"\0" * (80 - len(name))
    setup += struct.pack("I", 0)  # ff_effects_max

    created = False
    try:
        fcntl.ioctl(fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_REL)
        fcntl.ioctl(fd, UI_SET_RELBIT, REL_HWHEEL if horizontal else REL_WHEEL)
        fcntl.ioctl(fd, UI_DEV_CREATE)
        created = True

        # A freshly created uinput device is not usable the instant the ioctl
        # returns: the kernel notifies userspace (udev / the compositor) and the
        # device node has to be picked up first. Writing too early drops the
        # event. 60ms is comfortably enough and still imperceptible.
        time.sleep(0.06)
        code = REL_HWHEEL if horizontal else REL_WHEEL
        # One event per notch: compositors apply wheel acceleration to a single
        # large value, so a burst of ±1 notches feels the same as the real wheel.
        step = 1 if notches > 0 else -1
        for _ in range(abs(notches)):
            emit(fd, EV_REL, code, step, sleep=0.005)
            emit(fd, EV_SYN, SYN_REPORT, 0, sleep=0.005)
        # Let the last SYN be consumed before tearing the device down.
        time.sleep(0.05)
    except OSError as e:
        print(f"uinput failed: {e}", file=sys.stderr)
        try:
            if created:
                fcntl.ioctl(fd, UI_DEV_DESTROY)
        except OSError:
            pass
        os.close(fd)
        return 1

    try:
        fcntl.ioctl(fd, UI_DEV_DESTROY)
    except OSError:
        pass
    os.close(fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
