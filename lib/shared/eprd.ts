// EPRD0600 video stream codec (TCP 3621) — a modified VNC/RFB protocol.
//
// Wire format (all taken from the captures):
//   1. Hello message: 20-byte EPRD0600 header (status 0, payload length
//      little-endian like the EEMP channel) whose payload is a 46-byte
//      RFB-ServerInit-like blob: "cc000000" + width u16 BE + height u16 BE +
//      16-byte pixel format (16bpp RGB565, maxes little-endian) + trailer.
//   2. Update messages: 20-byte EPRD0600 header whose payload length is
//      big-endian (the RFB side of the protocol), payload is one RFB
//      FramebufferUpdate: u8 type=0, u8 pad, u16 BE rect count, then rects of
//      x/y/w/h u16 BE + encoding i32 BE = 7 (Tight), Tight payload =
//      control byte 0x90 (JPEG) + compact length (3 bytes) + JPEG data.
import { EPRD_CONTROL_WORD, EPRD_INIT } from "./constants";
import { HEADER_LENGTH } from "./header";

export const TIGHT_ENCODING = 7;
export const TIGHT_JPEG_CONTROL = 0x90;
const MAX_UPDATE_LENGTH = 8 * 1024 * 1024;

export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
  jpeg: Buffer;
};

function buildEprdHeader(
  ipAddress: Buffer,
  length: number,
  endian: "LE" | "BE"
): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH);
  header.write(EPRD_CONTROL_WORD, 0, "ascii");
  ipAddress.copy(header, 8);
  if (endian === "LE") header.writeUInt32LE(length, 16);
  else header.writeUInt32BE(length, 16);
  return header;
}

export function buildEprdHello(ipAddress: Buffer): Buffer {
  const init = Buffer.from(EPRD_INIT, "hex");
  return Buffer.concat([buildEprdHeader(ipAddress, init.length, "LE"), init]);
}

// The capture always emits the Tight compact length as 3 bytes
function compactLength(length: number): Buffer {
  return Buffer.from([
    (length & 0x7f) | 0x80,
    ((length >> 7) & 0x7f) | 0x80,
    (length >> 14) & 0x7f,
  ]);
}

export function buildEprdUpdate(ipAddress: Buffer, rects: Rect[]): Buffer {
  const parts: Buffer[] = [];
  const fbuHeader = Buffer.alloc(4);
  fbuHeader.writeUInt16BE(rects.length, 2);
  parts.push(fbuHeader);
  for (const { x, y, w, h, jpeg } of rects) {
    const rectHeader = Buffer.alloc(13);
    rectHeader.writeUInt16BE(x, 0);
    rectHeader.writeUInt16BE(y, 2);
    rectHeader.writeUInt16BE(w, 4);
    rectHeader.writeUInt16BE(h, 6);
    rectHeader.writeInt32BE(TIGHT_ENCODING, 8);
    rectHeader.writeUInt8(TIGHT_JPEG_CONTROL, 12);
    parts.push(rectHeader, compactLength(jpeg.length), jpeg);
  }
  const payload = Buffer.concat(parts);
  return Buffer.concat([buildEprdHeader(ipAddress, payload.length, "BE"), payload]);
}

export type StreamEvents = {
  onInit: (info: { width: number; height: number }) => void;
  onRect: (rect: Rect) => void;
  onError: (message: string) => void;
};

// Incremental parser for the app->projector byte stream. Feed raw socket
// chunks; emits the init and each decoded rect.
export class EprdStreamParser {
  private pending = Buffer.alloc(0);
  private sawHello = false;

  constructor(private events: StreamEvents) {}

  feed(chunk: Buffer) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= HEADER_LENGTH) {
      if (this.pending.subarray(0, 8).toString("ascii") !== EPRD_CONTROL_WORD) {
        this.events.onError(
          `bad control word: ${this.pending.subarray(0, 8).toString("hex")}`
        );
        this.pending = Buffer.alloc(0);
        return;
      }
      // hello length is little-endian, update lengths are big-endian
      const length = this.sawHello
        ? this.pending.readUInt32BE(16)
        : this.pending.readUInt32LE(16);
      if (length > MAX_UPDATE_LENGTH) {
        this.events.onError(`implausible message length ${length}`);
        this.pending = Buffer.alloc(0);
        return;
      }
      if (this.pending.length < HEADER_LENGTH + length) return;
      const payload = this.pending.subarray(
        HEADER_LENGTH,
        HEADER_LENGTH + length
      );
      this.pending = this.pending.subarray(HEADER_LENGTH + length);
      if (!this.sawHello) {
        this.sawHello = true;
        this.handleInit(payload);
      } else {
        this.handleUpdate(payload);
      }
    }
  }

  private handleInit(payload: Buffer) {
    if (payload.length < 8) {
      this.events.onError(`short init payload (${payload.length} bytes)`);
      return;
    }
    this.events.onInit({
      width: payload.readUInt16BE(4),
      height: payload.readUInt16BE(6),
    });
  }

  private handleUpdate(payload: Buffer) {
    if (payload.length < 4 || payload.readUInt8(0) !== 0) {
      this.events.onError("unexpected update message type");
      return;
    }
    const rectCount = payload.readUInt16BE(2);
    let pos = 4;
    for (let i = 0; i < rectCount; i++) {
      if (pos + 13 > payload.length) {
        this.events.onError("truncated rect header");
        return;
      }
      const x = payload.readUInt16BE(pos);
      const y = payload.readUInt16BE(pos + 2);
      const w = payload.readUInt16BE(pos + 4);
      const h = payload.readUInt16BE(pos + 6);
      const encoding = payload.readInt32BE(pos + 8);
      const control = payload.readUInt8(pos + 12);
      pos += 13;
      if (encoding !== TIGHT_ENCODING || (control & 0xf0) !== 0x90) {
        this.events.onError(
          `unsupported rect: encoding=${encoding} control=0x${control.toString(16)}`
        );
        return;
      }
      let jpegLength = 0;
      let shift = 0;
      let more = true;
      while (more) {
        if (pos >= payload.length) {
          this.events.onError("truncated compact length");
          return;
        }
        const b = payload.readUInt8(pos++);
        jpegLength |= (b & 0x7f) << shift;
        shift += 7;
        more = (b & 0x80) !== 0;
      }
      if (pos + jpegLength > payload.length) {
        this.events.onError("truncated jpeg data");
        return;
      }
      this.events.onRect({
        x,
        y,
        w,
        h,
        jpeg: Buffer.from(payload.subarray(pos, pos + jpegLength)),
      });
      pos += jpegLength;
    }
  }
}

// Minimal JPEG SOF scan for image dimensions
export function jpegDimensions(
  jpeg: Buffer
): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1];
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: jpeg.readUInt16BE(i + 5),
        width: jpeg.readUInt16BE(i + 7),
      };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return null;
}
