import dgram from "dgram";
import config from "../config";

const BROADCAST_ADDR = "255.255.255.255";
const MESSAGE = Buffer.from(
  "0100000030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  "hex"
);
const IP = [127, 0, 0, 1];

const createHeader = (
  controlWord: Buffer,
  clientIp: Buffer,
  status: number,
  payloadLength: number
) => {
  const statusBuffer = Buffer.alloc(1);
  statusBuffer.writeUInt8(status, 0);
  const payloadLengthBuffer = Buffer.alloc(4);
  payloadLengthBuffer.writeUInt32BE(payloadLength, 0);

  return Buffer.concat([
    controlWord,
    clientIp,
    statusBuffer,
    payloadLengthBuffer,
  ]);
};

const client = dgram.createSocket("udp4");

client.bind(() => {
  client.setBroadcast(true);

  const header = createHeader(Buffer.from("EEMP0100"), Buffer.from(IP), 1, 48);

  const discoveryMessageBuffer = Buffer.concat([header, MESSAGE]);

  client.send(
    discoveryMessageBuffer,
    0,
    discoveryMessageBuffer.length,
    config.DISCOVERY_SERVER_PORT,
    BROADCAST_ADDR,
    (err) => {
      if (err) {
        console.error("Error sending message:", err);
      } else {
        console.log(
          `Message sent to ${BROADCAST_ADDR}:${config.DISCOVERY_SERVER_PORT}`
        );
      }
    }
  );

  // Listen for responses
  client.on("message", (msg, rinfo) => {
    console.log(`Received response from ${rinfo.address}:${rinfo.port}`);
    console.log(msg.toString("hex"));

    // Process the response message here if needed

    // Close the client if you only want to receive one response
    client.close();
  });
});
