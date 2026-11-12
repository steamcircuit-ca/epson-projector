# Second-projector samples (`EB005302`)

Every capture in `captures/` is of one projector (`EB005301`,
MAC `00:00:5e:00:53:01`). The repo's earliest notes, since removed
(`protocol.md`, `exchange.yaml`, `projector/decode.js`; see git history),
recorded two discovery replies from a **different** projector that
are not in any capture. They're kept here because comparing two projectors
is the easiest way to work out which bytes are per-device and which are
fixed — see [`reverse-engineering-todo.md`](./reverse-engineering-todo.md).

Provenance is thinner than the captures: these are hex strings copied by
hand into notes, with no surrounding pcap. The header IP is `192.168.1.45`.

## Status `0x03` — identity reply (74-byte payload)

```
45454d5030313030c0a8012d030000004a000000
01000000454230303533303200000000000000000000000000000000000000000000000001000c00000100020c0000003030353330320000000000000000000000000000000000000000
```

Side by side with the captured projector's `PJ_INFO_2`
(`lib/shared/constants.ts`):

| Payload offset | `EB005302` | `EB005301` (captured) | Reading |
|---|---|---|---|
| 0–3 | `01000000` | `01000000` | same |
| 4–35 | `"EB005302"` + zeros | `"EB005301"` + zeros | projector name, 32-byte ASCII field |
| 36–45 | `01000c00000100020c00` | `01000900000101000000` | **differs** at 38 (`0c` vs `09`) and 42–44 — model/feature flags? unknown |
| 46–47 | `0000` | `0000` | same |
| 48–53 | `"005302"` (ASCII) | `00005e005301` (MAC) | **differs in kind** — a short ASCII name vs. a MAC address |
| 54–73 | zeros | zeros | same |

The name `EB005302` looks like `"EB"` + the last three bytes of the MAC in
hex (`EB005301` ↔ MAC `…:00:53:01`), so this projector's MAC likely ends
`…:00:53:02`. Unconfirmed.

## Status `0x15` — capabilities reply (216-byte payload)

Note **216 bytes**, versus 214 from the captured projector.

```
45454d5030313030c0a8012d15000000d8000000
303035333032000000000000000000000000000000000000000000ba000001040c000000020650423030000003068007b0040000040602008007b00405580709080000000800080080004000e001380400000000070b080000000800080010001000e001380400000000070d080000000800080010001000e0013804000000000000080000000800080010001000e001380400000000070a0100010c022d0000000008089f06f0dd000000000a0a002f0202320401000000000b0b00010a0b09070c02131415160d0a000104401f0000000000000e010005
```

Visible differences from `PJ_INFO_3`:

- Starts with ASCII `"005302"` where the captured one starts with the MAC
  (the same swap as the identity reply's offset 48).
- Payload byte 27 is `ba` (186) here vs `b8` (184) in the capture. Both
  equal *payload length − 30*, so this is very likely an inner length
  field covering everything after offset 30.
- Byte 32 is `0c` here vs `09` in the capture — the same value pair as
  identity-reply offset 38. Probably a model/series code.
- Both contain ASCII `"PB00"` (`50423030`) — likely a model/protocol tag.
- This projector has `8007` `b004` (1920 × 1200, little-endian) where the
  captured one has `0005` `2003` (1280 × 800, which matches the video
  hello's framebuffer size). Strong hint that this is a native-resolution
  field, and that this projector is a WUXGA model vs. the captured WXGA one.
- The captured payload repeats `9002` `a001` (656 × 416) — exactly the
  test card's largest tile size — where this one has `e001` `3804`. These
  may be maximum tile/rect dimensions.
- The record sequence near the end differs (`0b0b…` / `0c02…` / `0e010005`
  here vs `0c0d006b…ff7fff7f…` in the capture), which is where the
  2-byte length difference comes from.
