#!/usr/bin/env python3
"""Generate the Apple Studio Display 5K EDID override.

Takes the panel's stock 512-byte EDID and appends one DisplayID (0x70)
extension block carrying 5120x2880 Type I detailed timings at
50/54/56/58/59.94 Hz. Rationale: at exactly 60.00 Hz / 936.000 MHz the
panel's TCON tears (uncompressed) or fails to sync (DSC); 1000 ppm under
nominal (59.94 Hz) is flawless. See README.md.

Self-check: replicates the kernel's drm_displayid.c parser (4-byte
displayid header {rev, bytes[3]}, 3-byte data-block header
{tag, rev, num_bytes}, structure checksum over [1..1+4+bytes]) and
refuses to emit an EDID the kernel would reject.

Usage: python3 build_ladder.py   (run from this directory)
Output: edid/apple-studio-display-5k-ladder.bin (640 bytes, 5 blocks)
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STOCK = os.path.join(HERE, "edid", "apple-studio-display-stock.bin")
OUT = os.path.join(HERE, "edid", "apple-studio-display-5k-ladder.bin")

FREQS = [50, 54, 56, 58, 59.94]     # Hz; clock = htot*vtot*f, quantized to 10 kHz
HTOT, VTOT = 5200, 3000             # panel-native porches (from stock 5K@60 timing)

# Type I detailed timing fields 3..19 (flags + 8 u16 "+1" LE fields), copied from
# the stock 5K@60 timing minus the preferred bit: flags, hact, hblk, hsync, hsw,
# vact, vblk, vsync, vsw.
TAIL = bytes([0x04,
              0xFF, 0x13,  # hactive  5120
              0x4F, 0x00,  # hblank     80
              0x07, 0x80,  # hsync off   8 (+positive, bit15)
              0x1F, 0x00,  # hsw        32
              0x3F, 0x0B,  # vactive  2880
              0x77, 0x00,  # vblank    120
              0x69, 0x00,  # vsync off 106 (negative)
              0x07, 0x00]) # vsw         8


def parse_type1(block4, bstart, n):
    """Decode n 20-byte Type I timings at block4[bstart:] (kernel rules)."""
    out = []
    for i in range(n):
        t = block4[bstart + 20*i: bstart + 20*i + 20]
        clk = (t[0] | t[1] << 8 | t[2] << 16) + 1          # 10 kHz units
        u16 = lambda o: t[o] | t[o+1] << 8
        out.append(dict(
            clock_khz=clk * 10, flags=t[3],
            hact=u16(4)+1, hblk=u16(6)+1, hsync=(u16(8) & 0x7fff)+1, hsw=u16(10)+1,
            vact=u16(12)+1, vblk=u16(14)+1, vsync=(u16(16) & 0x7fff)+1, vsw=u16(18)+1,
        ))
    return out


def kernel_parse(ext, label):
    """Replicate displayid_iter on one 128-byte 0x70 extension block."""
    assert ext[0] == 0x70, f"{label}: tag {ext[0]:#02x}"
    idx, length = 1, 127
    dbytes = ext[2] | ext[3] << 8 | ext[4] << 16
    dispid_len = 4 + dbytes + 1                            # hdr + data + csum
    assert dispid_len <= length - idx, f"{label}: structure too long"
    assert sum(ext[idx:idx + dispid_len]) & 0xFF == 0, f"{label}: displayID checksum"
    idx += 4
    itlen = idx + dbytes                                   # kernel iter->length
    tag, rev, num = ext[idx], ext[idx+1], ext[idx+2]
    assert idx + 3 <= itlen and idx + 3 + num <= itlen, f"{label}: block bounds"
    assert tag == 0x03, f"{label}: tag {tag:#02x} != Type I detailed timing"
    assert num % 20 == 0, f"{label}: size {num} not a multiple of 20"
    assert sum(ext) & 0xFF == 0, f"{label}: EDID block checksum"
    return parse_type1(ext, idx + 3, num // 20)


def main():
    stock = open(STOCK, "rb").read()
    assert len(stock) == 512, f"stock EDID must be 512 bytes, got {len(stock)}"
    assert stock[126] == 3, f"stock EDID extension count {stock[126]} != 3"
    for i in range(4):
        assert sum(stock[128*i:128*(i+1)]) & 0xFF == 0, f"stock block {i} checksum"

    timings = b""
    for f in FREQS:
        khz = int(HTOT * VTOT * f) // 1000                 # kHz, truncated
        n = khz // 10 - 1                                  # 10 kHz units, minus 1
        assert 0 <= n < (1 << 24)
        clk = bytes([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF])
        assert (clk[0] | clk[1] << 8 | clk[2] << 16) + 1 == khz // 10
        timings += clk + TAIL

    blk = bytearray(128)
    blk[0] = 0x70                                          # DisplayID EDID ext
    blk[1] = 0x12                                          # rev (as in stock blocks)
    data_len = 3 + len(timings)                            # data-block hdr + payload
    blk[2], blk[3], blk[4] = data_len & 0xFF, (data_len >> 8) & 0xFF, data_len >> 16
    blk[5], blk[6], blk[7] = 0x03, 0x00, len(timings)      # Type I tag, rev, size
    blk[8:8 + len(timings)] = timings
    csum = 8 + len(timings)
    blk[csum] = (-sum(blk[1:csum])) & 0xFF                 # structure checksum
    blk[127] = (-sum(blk[0:127])) & 0xFF                   # EDID block checksum

    got = kernel_parse(blk, "generated block 4")
    want = [(int(HTOT * VTOT * f) // 1000 // 10 * 10, 5120, 2880) for f in FREQS]
    assert [(t["clock_khz"], t["hact"], t["vact"]) for t in got] == want, \
        f"decode mismatch: {[(t['clock_khz'],) for t in got]} != {want}"

    out = bytearray(stock) + blk
    out[126] = 4                                           # extension count
    out[127] = (-sum(out[0:127])) & 0xFF                   # block 0 checksum
    out = bytes(out)
    assert len(out) == 640 and out[126] == 4, "extension count"
    for i in range(1, 5):
        assert sum(out[128*i:128*(i+1)]) & 0xFF == 0, f"output block {i} checksum"

    open(OUT, "wb").write(bytes(out))
    hz = [f"{t['clock_khz']*1000/(HTOT*VTOT):.2f}" for t in got]
    print(f"wrote {OUT}\n  {len(got)} added 5120x2880 timings: "
          + ", ".join(hz) + " Hz  (stock 5K@60 unchanged and preferred)")


if __name__ == "__main__":
    sys.exit(main())
