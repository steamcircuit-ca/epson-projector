export function bufferToIp(buffer: Buffer): string {
  return `${buffer[0]}.${buffer[1]}.${buffer[2]}.${buffer[3]}`;
}

export function ipToBuffer(ip: string): Buffer {
  // Accepts plain IPv4 and IPv6-mapped addresses ("::ffff:192.168.84.226")
  const v4 = ip.split(":").pop() ?? ip;
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) {
    throw new Error(`Not an IPv4 address: ${ip}`);
  }
  return Buffer.from(parts);
}

// Wire header layout (20 bytes):
//   0-7   control word, ASCII ("EEMP0100" / "EPRD0600")
//   8-11  IPv4 address (requests carry the client's own IP; replies echo it,
//         except keepalive replies where the projector stamps its own IP)
//   12    status code
//   13    family: 0x00 = discovery/probe messages, 0x01 = session messages
//   14-15 padding
//   16-19 payload length, uint32 little-endian
export const HEADER_LENGTH = 20;

type Config = {
  ipAddress: Buffer;
  status: number;
  family?: number;
  controlWord: string;
};

export function createDataBuffer(dataBuffer: Buffer, config: Config): Buffer {
  const { ipAddress, status, family, controlWord } = config;

  if (ipAddress.length !== 4) {
    throw new Error("IP address must be a 4-byte buffer.");
  }

  if (controlWord.length !== 8) {
    throw new Error("Control word must be 8 characters long.");
  }

  const header = Buffer.alloc(HEADER_LENGTH);
  header.write(controlWord, 0, "ascii");
  ipAddress.copy(header, 8);
  header.writeUInt8(status, 12);
  header.writeUInt8(family ?? 0, 13);
  header.writeUInt32LE(dataBuffer.length, 16);

  return Buffer.concat([header, dataBuffer]);
}

type Header = {
  controlWord: string;
  ipAddress: Buffer;
  status: number;
  family: number;
  dataLength: number;
};

export function decodeDataBuffer(buffer: Buffer): {
  header: Header;
  data: Buffer;
} {
  const header: Header = {
    controlWord: buffer.subarray(0, 8).toString("ascii"),
    ipAddress: buffer.subarray(8, 12),
    status: buffer.readUInt8(12),
    family: buffer.readUInt8(13),
    dataLength: buffer.readUInt32LE(16),
  };

  const data = buffer.subarray(
    HEADER_LENGTH,
    HEADER_LENGTH + header.dataLength
  );

  return { header, data };
}

// TCP segments can carry several messages back-to-back or split one across
// segments, so callers must accumulate: feed the running buffer in, get the
// complete messages out, and keep `rest` for the next 'data' event.
export function extractMessages(buffer: Buffer): {
  messages: Buffer[];
  rest: Buffer;
} {
  const messages: Buffer[] = [];
  let rest = buffer;
  while (rest.length >= HEADER_LENGTH) {
    const messageLength = HEADER_LENGTH + rest.readUInt32LE(16);
    if (rest.length < messageLength) break;
    messages.push(rest.subarray(0, messageLength));
    rest = rest.subarray(messageLength);
  }
  return { messages, rest };
}

export function replaceAllBytes(
  buffer: Buffer,
  find: Buffer,
  replace: Buffer
): Buffer {
  if (find.length !== replace.length) {
    throw new Error("find and replace must be the same length");
  }
  const result = Buffer.from(buffer);
  let index = result.indexOf(find);
  while (index !== -1) {
    replace.copy(result, index);
    index = result.indexOf(find, index + find.length);
  }
  return result;
}
