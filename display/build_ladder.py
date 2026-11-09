#!/usr/bin/env python3
"""Generate the Apple Studio Display 5K EDID override.

Takes the panel's stock 512-byte EDID, rewrites the stock 5120x2880@60.00
DisplayID timing to 59.94 Hz (keeping its preferred flag), and appends one
DisplayID (0x70) extension block with extra 5120x2880 Type I timings at
50/54/56/58 Hz. Rationale: at exactly 60.00 Hz / 936.000 MHz the panel's
TCON tears (uncompressed) or fails to sync (DSC); 1000 ppm under nominal
(59.94 Hz) is flawless — so 60.00 Hz is removed outright and can never be
picked, e.g. by mutter's "preferred mode" fallback when an arrangement
like "External only" has no saved monitors.xml rate. See README.md.

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

FREQS = [50, 54, 56, 58]          # Hz appended as block 4 (59.94 comes from the
                                  # patched stock 60 Hz entry, see defang_poison)
HTOT, VTOT = 5200, 3000           # panel-native porches (from stock 5K@60 timing)
POISON_KHZ = 936000               # exact-60 timing: tears w/o DSC, won't sync w/ DSC


def clk_bytes(freq_hz):
    """Pixel clock as EDID Type I 3-byte field: kHz//10 - 1, little-endian."""
    n = int(HTOT * VTOT * freq_hz) // 1000 // 10 - 1
    assert 0 <= n < (1 << 24)
    return bytes([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF])

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


def parse_type1_all(ext, label):
    """Yield (abs_off, clock_khz, hact, vact) for every Type I timing in a
    128-byte DisplayID extension, walking data blocks like the kernel does."""
    assert ext[0] == 0x70, f"{label}: tag {ext[0]:#02x}"
    dbytes = ext[2] | ext[3] << 8 | ext[4] << 16
    assert 4 + dbytes + 1 <= 127, f"{label}: structure too long"
    # Structure checksum byte lives at 5 + dbytes (hdr is rev + 3-byte length);
    # one bad structure checksum makes the kernel drop ALL DisplayID timings of
    # the whole EDID (observed: 0 5K modes over 5 valid ones), so verify here.
    assert sum(ext[1: 6 + dbytes]) & 0xFF == 0, f"{label}: displayID checksum"
    idx = 5                                        # first data block
    while idx + 3 <= 5 + dbytes:
        tag, num = ext[idx], ext[idx + 2]
        if tag == 0x03:                            # Type I detailed timings
            assert num % 20 == 0, f"{label}: size {num} not a multiple of 20"
            for k in range(num // 20):
                t = ext[idx + 3 + 20*k: idx + 3 + 20*(k+1)]
                clk = (t[0] | t[1] << 8 | t[2] << 16) + 1
                u16 = lambda o: t[o] | t[o+1] << 8
                yield (idx + 3 + 20*k, clk * 10, u16(4) + 1, u16(12) + 1)
        if tag == 0x00 and num == 0x00:
            break                                  # zero padding terminates
        idx += 3 + num


def defang_poison(d, keep_hz=59.94):
    """Rewrite every stock 5120x2880@60.00 Type I entry to 59.94 Hz (preferred
    flag kept), re-checksumming the blocks touched.

    Why remove (not just avoid) 60 Hz: mutter keys monitors.xml by output set,
    so a different arrangement (e.g. "External only") has no saved rate and
    falls back to the preferred mode. If stock 60 Hz is still in the EDID the
    panel lands on the one timing that tears (or blacks with DSC latched)."""
    d = bytearray(d)
    patched = 0
    for bi in range(1, d[126] + 1):
        ext = d[128*bi:128*(bi+1)]
        if ext[0] != 0x70:
            continue
        hits = [off for off, clk, h, v in parse_type1_all(ext, f"stock block {bi}")
                if (clk, h, v) == (POISON_KHZ, 5120, 2880)]
        if not hits:
            continue
        dbytes = ext[2] | ext[3] << 8 | ext[4] << 16
        csum = 5 + dbytes                          # structure checksum byte
        for off in hits:
            d[128*bi + off: 128*bi + off + 3] = clk_bytes(keep_hz)
            # keep the preferred bit intact: mutter's fallback uses it
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
    stock = defang_poison(stock)

    timings = b""
    for f in FREQS:
        clk = clk_bytes(f)
        khz = int(HTOT * VTOT * f) // 1000
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

    fivek = sorted({clk for bi in range(1, 5) if out[128*bi] == 0x70
                    for _, clk, h, v in parse_type1_all(out[128*bi:128*(bi+1)],
                                                         f"block {bi}")
                    if (h, v) == (5120, 2880)})
    assert POISON_KHZ not in fivek, "poison 60 Hz timing still present"
    assert 935060 in fivek, "59.94 Hz (patched stock) timing missing"
    assert len(fivek) == len(FREQS) + 1, f"unexpected 5K clock set {fivek}"

    open(OUT, "wb").write(out)
    hz = [f"{t['clock_khz']*1000/(HTOT*VTOT):.2f}" for t in got]
    print(f"wrote {OUT}\n  5120x2880 clocks advertised (kHz): "
          + ", ".join(str(c) for c in fivek)
          + "\n  stock 5K@60.00 -> 59.94 (preferred); appended: "
          + ", ".join(hz) + " Hz")


if __name__ == "__main__":
    sys.exit(main())
