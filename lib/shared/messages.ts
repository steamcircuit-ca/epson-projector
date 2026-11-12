// Field-by-field builders and parsers for EEMP0100 control payloads.
//
// Every layout here is documented in docs/eemp-control-protocol.md. The
// builders were checked byte-for-byte against every message in the
// original packet captures (given the same field values). Bytes whose
// meaning is still unknown are reproduced as named constants rather than
// guessed at. See docs/reverse-engineering-todo.md.
//
// These functions build *payloads* (what follows the 20-byte header).
// Wrap them with `eempMessage()` to get a complete message on the wire.
import { EEMP_CONTROL_WORD } from "./constants";
import { createDataBuffer } from "./header";

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/** A client device (the app side). */
export type ClientIdentity = {
  /** IPv4 address, 4 bytes. */
  ip: Buffer;
  /** Display name, sent as UTF-16LE. Shown on the projector. */
  name: string;
};

/** A projector. */
export type ProjectorIdentity = {
  /** MAC address, 6 bytes. */
  mac: Buffer;
  /** IPv4 address, 4 bytes. */
  ip: Buffer;
  /** Network name, ASCII, max 32 bytes (real units use "EB" + MAC tail). */
  name: string;
};

export type Size = { width: number; height: number };

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

/** Family 0: discovery, probes, heartbeats, start signal. */
export const Fam0 = {
  search: 0x01,
  probe: 0x02,
  identity: 0x03,
  heartbeat: 0x0a,
  capabilities: 0x15,
  startStream: 0x16,
} as const;

/** Family 1: session state. */
export const Fam1 = {
  connectRequest: 0x01,
  connectAccept: 0x02,
  disconnect: 0x04,
  disconnectAck: 0x05,
  disconnectedByProjector: 0x07,
  layoutRequest: 0x08,
  layoutAccepted: 0x09,
  stateBroadcast: 0x0e,
  resume: 0x0f,
  openVideo: 0x10,
  staleSession: 0x17,
  inUse: 0x1a,
  streamStarted: 0x27,
} as const;

/** Wrap a payload in the 20-byte EEMP0100 header. */
export function eempMessage(
  ipAddress: Buffer,
  status: number,
  family: 0 | 1,
  payload: Buffer = Buffer.alloc(0)
): Buffer {
  return createDataBuffer(payload, {
    ipAddress,
    status,
    family,
    controlWord: EEMP_CONTROL_WORD,
  });
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function fixedAscii(text: string, size: number): Buffer {
  const b = Buffer.alloc(size);
  b.write(text.slice(0, size), 0, "ascii");
  return b;
}

/** One TLV record: tag u32 LE, length u32 LE, value. */
export function tlv(tag: number, value: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([u32(tag), u32(value.length), value]);
}

/** A TLV list: count u32 LE followed by the entries. */
export function tlvList(tag: number, entries: Buffer[]): Buffer {
  return tlv(tag, Buffer.concat([u32(entries.length), ...entries]));
}

export type TlvRecord = { tag: number; value: Buffer };

/** Parse a flat run of TLV records (does not recurse). */
export function parseTlvs(buf: Buffer): TlvRecord[] {
  const out: TlvRecord[] = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const tag = buf.readUInt32LE(pos);
    const length = buf.readUInt32LE(pos + 4);
    if (pos + 8 + length > buf.length) {
      throw new Error(`TLV tag 0x${tag.toString(16)} overruns its buffer`);
    }
    out.push({ tag, value: buf.subarray(pos + 8, pos + 8 + length) });
    pos += 8 + length;
  }
  return out;
}

/** Short (48-byte) prefix. Byte 1 says whether a TLV body follows. */
function shortPrefix(fields: { body?: boolean; at4?: number; at8?: number }): Buffer {
  const p = Buffer.alloc(48);
  p[1] = fields.body ? 1 : 0;
  p.writeUInt32LE(fields.at4 ?? 0, 4);
  p.writeUInt32LE(fields.at8 ?? 0, 8);
  return p;
}

/** Append a body: u32 LE body length, then the TLV records. */
function withBody(prefix: Buffer, records: Buffer[]): Buffer {
  const body = Buffer.concat(records);
  return Buffer.concat([prefix, u32(body.length), body]);
}

// ---------------------------------------------------------------------------
// TLV building blocks
// ---------------------------------------------------------------------------

/** User-entry flag values (tag 0x0b) seen in the captures. */
export const UserFlags = {
  /** The client's own entry before the projector accepts it. */
  pending: 0x000,
  /** Accepted / in the connected-users list. */
  connected: 0x001,
  /** On screen. The real app sends 0x101 or 0x100; both get echoed. */
  onScreen: 0x101,
} as const;

/** Tag 0x05: one user. Field order matters; it's always this order. */
export function userEntry(
  client: ClientIdentity,
  opts: { registered: boolean; flags: number }
): Buffer {
  return tlv(
    0x05,
    Buffer.concat([
      tlv(0x02, client.ip),
      tlv(0x0c, u32(opts.registered ? 1 : 0)),
      tlv(0x01, Buffer.from(client.name, "utf16le")),
      tlv(0x0b, u32(opts.flags)),
      tlv(0x1c),
    ])
  );
}

/** Tag 0x00: an empty screen slot, identified by its number (1-4). */
export function emptySlot(slot: number): Buffer {
  return tlv(0x00, tlv(0x02, u32(slot)));
}

/** Tag 0x04: list of one projector identity (tag 0x03). */
function projectorListTlv(projector: ProjectorIdentity): Buffer {
  return tlvList(0x04, [
    tlv(0x03, Buffer.concat([projector.mac, projector.ip, fixedAscii(projector.name, 32)])),
  ]);
}

/** Maximum simultaneous connections advertised (tag 0x0f). Always 50. */
export const MAX_CONNECTIONS = 50;

export type ParsedUser = ClientIdentity & { registered: boolean; flags: number };

/** Parse a tag-0x05 user entry's value. */
export function parseUserEntry(value: Buffer): ParsedUser {
  const fields = new Map(parseTlvs(value).map((r) => [r.tag, r.value]));
  const ip = fields.get(0x02);
  const name = fields.get(0x01);
  if (!ip || ip.length !== 4 || !name) throw new Error("malformed user entry");
  return {
    ip: Buffer.from(ip),
    name: name.toString("utf16le"),
    registered: (fields.get(0x0c)?.readUInt32LE(0) ?? 0) === 1,
    flags: fields.get(0x0b)?.readUInt32LE(0) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Discovery: search, probe, identity, in-use, capabilities
// ---------------------------------------------------------------------------

/** Search (fam 0 / 0x01) and probe (fam 0 / 0x02): 48 zero bytes. */
export function searchPayload(): Buffer {
  return Buffer.alloc(48);
}

/** Model/series code seen in the captured projector (0x0c on another model). */
export const DEFAULT_MODEL_CODE = 0x09;

/**
 * Identity reply (fam 0 / 0x03). Idle: the 74-byte long prefix alone.
 * In use: the same prefix with the body flag set, plus a TLV body.
 */
export function identityPayload(
  projector: ProjectorIdentity,
  opts: { connectedUsers?: number; modelCode?: number } = {}
): Buffer {
  const users = opts.connectedUsers ?? 0;
  const inUse = users > 0;
  const p = Buffer.alloc(74);
  p[0] = 0x01; // long prefix
  p[1] = inUse ? 0x01 : 0x00; // body follows
  fixedAscii(projector.name, 32).copy(p, 4);
  p[36] = inUse ? 0x03 : 0x01; // status bits; bit 1 = in use
  p[38] = opts.modelCode ?? DEFAULT_MODEL_CODE;
  p[40] = Math.min(users, 0xff);
  p[41] = 0x01; // unknown, constant
  p[42] = 0x01; // unknown, constant
  projector.mac.copy(p, 48);
  if (!inUse) return p;
  return withBody(p, [
    projectorListTlv(projector),
    tlv(0x0d, u32(1)), // unknown, constant
    tlv(0x0f, u32(MAX_CONNECTIONS)),
    tlv(0x10, u32(users)),
  ]);
}

export type ParsedIdentity = {
  name: string;
  mac: Buffer;
  inUse: boolean;
  connectedUsers: number;
  modelCode: number;
};

export function parseIdentity(payload: Buffer): ParsedIdentity {
  if (payload.length < 74 || payload[0] !== 0x01) throw new Error("not an identity reply");
  return {
    name: payload.subarray(4, 36).toString("ascii").replace(/\0+$/, ""),
    mac: Buffer.from(payload.subarray(48, 54)),
    inUse: (payload[36] & 0x02) !== 0,
    connectedUsers: payload[40],
    modelCode: payload[38],
  };
}

/** "In use" notice (fam 1 / 0x1a), sent before an in-use identity reply. */
export function inUsePayload(): Buffer {
  return Buffer.alloc(48);
}

/** Maximum rect size the captured projector accepts per Tight rect. */
export const DEFAULT_MAX_RECT: Size = { width: 656, height: 416 };

// Capabilities records whose meaning is unknown, reproduced verbatim.
const CAPS_PROTOCOL_TAG = Buffer.from("PB00\0\0", "latin1");
const CAPS_RECORD_07 = Buffer.from("0100010c000000000000", "hex");
const CAPS_RECORD_08 = Buffer.from("9f03001500000000", "hex");
const CAPS_RECORD_0A = Buffer.from("00030101320401000000", "hex");
// The last 30 bytes don't follow the [type][len] framing; still undecoded.
const CAPS_TAIL = Buffer.from(
  "000c0d006b000000ff7fff7f00000000000d0a000104401f000000000000",
  "hex"
);

// One 22-byte encoding-table entry: [07 = Tight (or 00)][sub-id], then
// u16 LE values 8, 0, a, a, 2a, 2a, maxW, maxH, 0, 0. `a` is 16 for the
// first entry and 8 for the rest; its meaning is unknown.
function encodingEntry(subId: number, a: number, maxRect: Size): Buffer {
  const e = Buffer.alloc(22);
  e[0] = subId === 0 ? 0x00 : 0x07;
  e[1] = subId;
  e.writeUInt16LE(8, 2);
  e.writeUInt16LE(a, 6);
  e.writeUInt16LE(a, 8);
  e.writeUInt16LE(a * 2, 10);
  e.writeUInt16LE(a * 2, 12);
  e.writeUInt16LE(maxRect.width, 14);
  e.writeUInt16LE(maxRect.height, 16);
  return e;
}

/** Capabilities reply (fam 0 / 0x15). Its own [type u8][len u8] format. */
export function capabilitiesPayload(
  projector: Pick<ProjectorIdentity, "mac">,
  opts: {
    modelCode?: number;
    nativeResolution?: Size;
    framebuffer?: Size;
    maxRect?: Size;
  } = {}
): Buffer {
  const native = opts.nativeResolution ?? { width: 1280, height: 800 };
  const fb = opts.framebuffer ?? native;
  const maxRect = opts.maxRect ?? DEFAULT_MAX_RECT;
  const record = (type: number, data: Buffer) =>
    Buffer.concat([Buffer.from([type, data.length]), data]);
  const size = (s: Size, extra?: number) => {
    const b = Buffer.alloc(6);
    if (extra === undefined) {
      b.writeUInt16LE(s.width, 0);
      b.writeUInt16LE(s.height, 2);
    } else {
      b.writeUInt16LE(extra, 0);
      b.writeUInt16LE(s.width, 2);
      b.writeUInt16LE(s.height, 4);
    }
    return b;
  };
  const records = Buffer.concat([
    record(0x01, u32(opts.modelCode ?? DEFAULT_MODEL_CODE)),
    record(0x02, CAPS_PROTOCOL_TAG),
    record(0x03, size(native)),
    record(0x04, size(fb, 2)),
    record(
      0x05,
      Buffer.concat([
        encodingEntry(0x09, 16, maxRect),
        encodingEntry(0x0b, 8, maxRect),
        encodingEntry(0x0d, 8, maxRect),
        encodingEntry(0x00, 8, maxRect),
      ])
    ),
    record(0x07, CAPS_RECORD_07),
    record(0x08, CAPS_RECORD_08),
    record(0x0a, CAPS_RECORD_0A),
    CAPS_TAIL,
  ]);
  const head = Buffer.alloc(30);
  projector.mac.copy(head, 0);
  head.writeUInt16BE(records.length, 26);
  return Buffer.concat([head, records]);
}

export type ParsedCapabilities = {
  modelCode?: number;
  nativeResolution?: Size;
  framebuffer?: Size;
  maxRect?: Size;
};

/** Parse the decoded records of a capabilities reply; unknown ones are skipped. */
export function parseCapabilities(payload: Buffer): ParsedCapabilities {
  const out: ParsedCapabilities = {};
  if (payload.length < 30) return out;
  const end = Math.min(payload.length, 30 + payload.readUInt16BE(26));
  let pos = 30;
  while (pos + 2 <= end) {
    const type = payload[pos];
    const len = payload[pos + 1];
    const data = payload.subarray(pos + 2, pos + 2 + len);
    if (data.length < len) break;
    if (type === 0x01 && len >= 4) out.modelCode = data.readUInt32LE(0);
    if (type === 0x03 && len >= 4)
      out.nativeResolution = { width: data.readUInt16LE(0), height: data.readUInt16LE(2) };
    if (type === 0x04 && len >= 6)
      out.framebuffer = { width: data.readUInt16LE(2), height: data.readUInt16LE(4) };
    if (type === 0x05 && len >= 22)
      out.maxRect = { width: data.readUInt16LE(14), height: data.readUInt16LE(16) };
    if (type === 0x0a) break; // the bytes after this record aren't decoded yet
    pos += 2 + len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session setup
// ---------------------------------------------------------------------------

// Connect-request prefix bytes that are constant in every capture and not
// yet understood (see docs § Connect request).
const CONNECT_PREFIX_NETMASK = Buffer.from("00ffffff", "hex"); // offsets 12-15
const CONNECT_PREFIX_VERSION = Buffer.from("00020f03", "hex"); // offsets 20-23
const CONNECT_PREFIX_44 = Buffer.from("010c", "hex"); // offsets 44-45
const CONNECT_TAG_30 = Buffer.from("060000003430350000000000", "hex");

/**
 * Connect request (fam 1 / 0x01). `screen` is the app's own screen size;
 * the app declares 32bpp RGB888 here even though it streams JPEG.
 */
export function connectRequestPayload(
  client: ClientIdentity,
  target: ProjectorIdentity,
  opts: { screen?: Size; resume?: boolean } = {}
): Buffer {
  const screen = opts.screen ?? { width: 1280, height: 800 };
  const p = Buffer.alloc(74);
  p[0] = 0x01; // long prefix
  p[1] = 0x01; // body follows
  CONNECT_PREFIX_NETMASK.copy(p, 12);
  CONNECT_PREFIX_VERSION.copy(p, 20);
  p.writeUInt16LE(screen.width, 24);
  p.writeUInt16LE(screen.height, 26);
  // RFB PIXEL_FORMAT: 32 bpp, depth 32, little-endian, true colour,
  // max 255/255/255 (LE), shifts 0/8/16.
  Buffer.from("20200001ff00ff00ff00000810000000", "hex").copy(p, 28);
  CONNECT_PREFIX_44.copy(p, 44);
  target.mac.copy(p, 48);
  target.ip.copy(p, 70);
  return withBody(p, [
    userEntry(client, { registered: !!opts.resume, flags: UserFlags.pending }),
    projectorListTlv(target),
    tlv(0x0f, u32(MAX_CONNECTIONS)),
    tlv(0x0d, u32(1)),
    tlv(0x26, Buffer.alloc(8)),
    tlv(0x2e, Buffer.alloc(1)),
    tlv(0x30, CONNECT_TAG_30),
  ]);
}

export type ParsedConnectRequest = {
  client: ParsedUser;
  screen: Size;
  targetMac: Buffer;
  targetIp: Buffer;
};

export function parseConnectRequest(payload: Buffer): ParsedConnectRequest {
  if (payload.length < 78 || payload[0] !== 0x01) throw new Error("not a connect request");
  const bodyLen = payload.readUInt32LE(74);
  const records = parseTlvs(payload.subarray(78, 78 + bodyLen));
  const user = records.find((r) => r.tag === 0x05);
  if (!user) throw new Error("connect request has no user entry");
  return {
    client: parseUserEntry(user.value),
    screen: { width: payload.readUInt16LE(24), height: payload.readUInt16LE(26) },
    targetMac: Buffer.from(payload.subarray(48, 54)),
    targetIp: Buffer.from(payload.subarray(70, 74)),
  };
}

/** Connect accept (fam 1 / 0x02). */
export function connectAcceptPayload(client: ClientIdentity, projector: ProjectorIdentity): Buffer {
  const p = Buffer.alloc(74);
  p[0] = 0x01;
  p[1] = 0x01;
  p.writeUInt32LE(2, 4);
  projector.mac.copy(p, 48);
  return withBody(p, [
    userEntry(client, { registered: true, flags: UserFlags.connected }),
    projectorListTlv(projector),
    tlv(0x0f, u32(MAX_CONNECTIONS)),
    tlv(0x1e),
  ]);
}

// ---------------------------------------------------------------------------
// Session state (layout)
// ---------------------------------------------------------------------------

/** A screen-slot entry: either a user (on screen) or an empty slot. */
export type SlotEntry = { user: ClientIdentity; flags?: number } | { empty: number };

function slotTlv(entry: SlotEntry): Buffer {
  return "empty" in entry
    ? emptySlot(entry.empty)
    : userEntry(entry.user, { registered: true, flags: entry.flags ?? UserFlags.onScreen });
}

export type ScreenState = {
  /** List 0x07: who is full-screen (or [{ empty: 1 }] when nobody is). */
  presenter: SlotEntry[];
  /** List 0x08: the four split-screen panels. Omitted in the initial broadcast. */
  panels?: SlotEntry[];
  /** List 0x06: connected users. */
  users: ClientIdentity[];
};

/** State broadcast (fam 1 / 0x0e). `version` is the projector-wide counter. */
export function stateBroadcastPayload(version: number, state: ScreenState): Buffer {
  const records = [tlvList(0x07, state.presenter.map(slotTlv))];
  if (state.panels) records.push(tlvList(0x08, state.panels.map(slotTlv)));
  records.push(
    tlvList(
      0x06,
      state.users.map((u) => userEntry(u, { registered: true, flags: UserFlags.connected }))
    )
  );
  return withBody(shortPrefix({ body: true, at4: version }), records);
}

/** The usual "client alone, full screen and in panel 1" layout. */
export function soloLayout(
  client: ClientIdentity,
  presenterFlags: number = UserFlags.onScreen,
  panelFlags: number = presenterFlags
): { presenter: SlotEntry[]; panels: SlotEntry[] } {
  return {
    presenter: [{ user: client, flags: presenterFlags }],
    panels: [{ user: client, flags: panelFlags }, { empty: 2 }, { empty: 3 }, { empty: 4 }],
  };
}

/** Layout request (fam 1 / 0x08): "put me on screen". */
export function layoutRequestPayload(
  client: ClientIdentity,
  layout = soloLayout(client)
): Buffer {
  return withBody(shortPrefix({ body: true, at4: 0 }), [
    userEntry(client, { registered: true, flags: UserFlags.pending }),
    tlvList(0x07, layout.presenter.map(slotTlv)),
    tlvList(0x08, layout.panels.map(slotTlv)),
  ]);
}

/**
 * Layout accepted (fam 1 / 0x09): the request echoed back with the new state
 * version, and the requester's own entry marked connected.
 */
export function layoutAcceptedPayload(request: Buffer, version: number): Buffer {
  const records = parseTlvs(request.subarray(52, 52 + request.readUInt32LE(48)));
  const rebuilt = records.map((r, i) => {
    if (i === 0 && r.tag === 0x05) {
      const u = parseUserEntry(r.value);
      return userEntry(u, { registered: u.registered, flags: UserFlags.connected });
    }
    return tlv(r.tag, r.value);
  });
  return withBody(shortPrefix({ body: true, at4: version }), rebuilt);
}

// ---------------------------------------------------------------------------
// Streaming, heartbeats, teardown
// ---------------------------------------------------------------------------

/** Start streaming (fam 0 / 0x16). */
export function startStreamPayload(): Buffer {
  return shortPrefix({ at8: 1 });
}

/** Streaming started (fam 1 / 0x27). Optional in practice. */
export function streamStartedPayload(): Buffer {
  return shortPrefix({ at4: 3 });
}

/** Audio sample rate the projector announces in its periodic heartbeats. */
export const HEARTBEAT_SAMPLE_RATE = 44100;
/** Both sides send a heartbeat about this often, independently. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Projector heartbeat (fam 0 / 0x0a). `sampleRate` is 0 in the immediate
 * reply to the app's first heartbeat and 44100 in the periodic ones. The
 * app's own heartbeat has an empty payload.
 */
export function projectorHeartbeatPayload(sampleRate: number = HEARTBEAT_SAMPLE_RATE): Buffer {
  return shortPrefix({ at8: sampleRate });
}

/** Stale-session notice (fam 1 / 0x17). */
export function staleSessionPayload(): Buffer {
  return withBody(shortPrefix({ body: true }), [tlv(0x25, u32(1))]);
}

/** Disconnect ack (fam 1 / 0x05), reply to the app's empty 0x04. */
export function disconnectAckPayload(): Buffer {
  return shortPrefix({ at4: 1, at8: 1 });
}

/** Disconnected by the projector (fam 1 / 0x07). */
export function disconnectedByProjectorPayload(): Buffer {
  return shortPrefix({ at4: 1, at8: 2 });
}
