type Config = {
  ipAddress: Buffer;
  status: number;
  controlWord: string;
};

function createDataBuffer(dataBuffer: Buffer, config: Config): Buffer {
  const { ipAddress, status, controlWord } = config;

  if (ipAddress.length !== 4) {
    throw new Error("IP address must be a 4-byte buffer.");
  }

  if (controlWord.length !== 8) {
    throw new Error("Control word must be 8 characters long.");
  }

  // Convert the control word to a Buffer
  const controlWordBuffer = Buffer.from(controlWord, "ascii");

  // Convert the status to a Buffer
  const statusBuffer = Buffer.alloc(1);
  statusBuffer.writeUInt8(status, 0);

  // Calculate the data length (dataBuffer length)
  const dataLength = dataBuffer.length;
  const dataLengthBuffer = Buffer.alloc(1);
  dataLengthBuffer.writeUInt8(dataLength, 0);

  // Initial padding buffer
  const paddingBuffer = Buffer.alloc(3); // 3 bytes of padding

  // Create the final buffer by concatenating all parts
  const finalBuffer = Buffer.concat([
    controlWordBuffer,
    ipAddress,
    statusBuffer,
    paddingBuffer,
    dataLengthBuffer,
    dataBuffer,
    paddingBuffer,
  ]);

  // Return the final buffer
  return finalBuffer;
}

console.log(
  createDataBuffer(
    Buffer.from(
      "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      "hex"
    ),
    {
      ipAddress: Buffer.from([172, 16, 0, 226]),
      status: 1,
      controlWord: "EEMP0100",
    }
  ).toString("hex")
);
