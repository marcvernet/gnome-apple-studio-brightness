#!/usr/bin/env python3
"""Generate the Apple Studio Display 5K EDID override (single-mode).

Takes the panel's stock 512-byte EDID and rewrites its stock
5120x2880@60.00 DisplayID Type I timing to 59.94 Hz / 935.060 MHz,
keeping the preferred flag.  That single timing is the ONLY 5K mode the
EDID advertises (the poison 60.00 Hz / 936.000 MHz clock appears
nowhere), so GNOME/mutter cannot select a tearing timing — not even
through the preferred-mode fallback an unsaved arrangement such as
"External only" uses.  Rationale: at exactly 60.00 Hz the panel's TCON
tears (uncompressed) or fails to sync (DSC); 1000 ppm under nominal —
59.94 Hz, identical link load — is flawless.  See README.md.

Smaller modes (4K, 1080p, ...) and the CTA block's audio descriptors
are left untouched: they are never picked while the 5K mode is
available, they keep DisplayPort audio working, and they give mutter a
safe fallback resolution if a link ever fails to train at 5K.

Self-checks replicate the kernel's DisplayID rules — structure
checksum (sum of bytes 1..end-of-structure must be 0 mod 256; one bad
structure makes the kernel drop ALL DisplayID timings of the whole
EDID) and Type I decoding — and refuse to emit an EDID the kernel
would reject, that still advertises the 936000 kHz poison clock, or
that advertises more than one 5K timing.

Usage: python3 build_edid.py    (from this directory)
Output: edid/apple-studio-display-5k.bin  (512 bytes, 3 extensions)
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STOCK = os.path.join(HERE, "edid", "apple-studio-display-stock.bin")
OUT = os.path.join(HERE, "edid", "apple-studio-display-5k.bin")

HTOT, VTOT = 5200, 3000           # panel-native totals (from stock 5K@60 timing)
KEEP_HZ = 59.94                   # the only 5K timing advertised (preferred)
POISON_KHZ = 936000               # exact-60 timing: tears w/o DSC, won't sync w/ DSC


def clk_bytes(freq_hz):
    """Pixel clock as the EDID Type I 3-byte field: kHz//10 - 1, little-endian."""
    n = int(HTOT * VTOT * freq_hz) // 1000 // 10 - 1
    assert 0 <= n < (1 << 24)
    return bytes([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF])


def parse_type1_all(ext, label):
    """Yield (abs_off, clock_khz, hact, vact, flags) for every Type I timing in
    a 128-byte DisplayID extension, walking data blocks the way the kernel's
    displayid iterator does."""
    assert ext[0] == 0x70, f"{label}: tag {ext[0]:#02x}"
    dbytes = ext[2] | ext[3] << 8 | ext[4] << 16
    assert 4 + dbytes + 1 <= 127, f"{label}: structure too long"
    # The structure checksum byte lives at 5 + dbytes (header = tag + rev +
    # 3-byte length).  The kernel drops ALL DisplayID timings of the whole
    # EDID when any single structure checksum is invalid — enforce that here
    # so an unbuildable EDID can never be shipped.
    assert sum(ext[1: 6 + dbytes]) & 0xFF == 0, f"{label}: displayid checksum"
    idx = 5                                        # first data block
    while idx + 3 <= 5 + dbytes:
        tag, num = ext[idx], ext[idx + 2]
        if tag == 0x03:                            # Type I detailed timings
            assert num % 20 == 0, f"{label}: size {num} not a multiple of 20"
            for k in range(num // 20):
                t = ext[idx + 3 + 20*k: idx + 3 + 20*(k+1)]
                clk = (t[0] | t[1] << 8 | t[2] << 16) + 1
                u16 = lambda o: t[o] | t[o+1] << 8
                yield (idx + 3 + 20*k, clk * 10, u16(4) + 1, u16(12) + 1, t[3])
        if tag == 0x00 and num == 0x00:
            break                                  # zero padding terminates
        idx += 3 + num


def defang_poison(d):
    """Rewrite the stock 5120x2880@60.00 Type I entry to KEEP_HZ, keeping the
    preferred flag, and re-checksum the DisplayID structure and block."""
    d = bytearray(d)
    patched = 0
    for bi in range(1, d[126] + 1):
        ext = d[128*bi:128*(bi+1)]
        if ext[0] != 0x70:
            continue
        hits = [off for off, clk, h, v, _ in parse_type1_all(ext, f"stock block {bi}")
                if (clk, h, v) == (POISON_KHZ, 5120, 2880)]
        if not hits:
            continue
        csum = 5 + (ext[2] | ext[3] << 8 | ext[4] << 16)   # structure checksum byte
        for off in hits:
            d[128*bi + off: 128*bi + off + 3] = clk_bytes(KEEP_HZ)
            # preferred bit must survive: mutter's no-config fallback uses it
            assert d[128*bi + off + 3] & 0x80, \
                f"stock block {bi}: patched timing lost preferred flag"
        d[128*bi + csum] = (-sum(d[128*bi + 1: 128*bi + csum])) & 0xFF
        d[128*bi + 127] = (-sum(d[128*bi: 128*bi + 127])) & 0xFF
        patched += len(hits)
    assert patched == 1, f"expected exactly one stock 5K@60 timing, found {patched}"
    return bytes(d)


def main():
    stock = open(STOCK, "rb").read()
    assert len(stock) == 512, f"stock EDID must be 512 bytes, got {len(stock)}"
    assert stock[126] == 3, f"stock EDID extension count {stock[126]} != 3"
    for i in range(4):
        assert sum(stock[128*i:128*(i+1)]) & 0xFF == 0, f"stock block {i} checksum"

    out = defang_poison(stock)

    assert len(out) == 512 and out[126] == 3, "extension layout changed"
    for i in range(4):
        assert sum(out[128*i:128*(i+1)]) & 0xFF == 0, f"output block {i} checksum"

    fivek = [(clk, flags) for bi in range(1, 4) if out[128*bi] == 0x70
             for _, clk, h, v, flags in parse_type1_all(out[128*bi:128*(bi+1)],
                                                        f"block {bi}")
             if (h, v) == (5120, 2880)]
    assert len(fivek) == 1, f"expected exactly one 5K timing, got {fivek}"
    (clk, flags), = fivek
    assert clk != POISON_KHZ, "poison 60 Hz timing still present"
    assert clk == 935060, f"unexpected 5K clock {clk} kHz"
    assert flags & 0x80, "the single 5K timing must be preferred"

    open(OUT, "wb").write(out)
    print(f"wrote {OUT}\n"
          f"  only advertised 5K timing: 5120x2880 @ {clk*1000/(HTOT*VTOT):.2f} Hz "
          f"(clock {clk} kHz, preferred)\n"
          f"  stock 5K@60.00 (936000 kHz) removed; smaller modes and CTA audio intact")


if __name__ == "__main__":
    sys.exit(main())
