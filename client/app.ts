import dgram from "dgram";
import config from "../config";
import { createDataBuffer } from "../utils/header";
import { C_SEARCH_MESSAGE } from "../utils/constants";
import { createServer } from "net";

const BROADCAST_ADDR = "192.168.84.255";
const IP = Buffer.from([192, 168, 84, 174]);

function findProjectors() {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket("udp4");
    const responses: { [host: string]: Buffer[] } = {};

    client.on("listening", () => {
      const address = client.address();
      console.log(`UDP Client listening on ${address.address}:${address.port}`);
      client.setBroadcast(true);

      const data = createDataBuffer(Buffer.from(C_SEARCH_MESSAGE, "hex"), {
        ipAddress: IP,
        controlWord: "EEMP0100",
        status: 1,
      });

      client.send(
        data,
        0,
        data.length,
        config.DISCOVERY_SERVER_PORT,
        BROADCAST_ADDR,
        (err) => {
          if (err) {
            console.error("Error sending message:", err);
            client.close();
            reject(err);
          } else {
            console.log(
              `Message sent to ${BROADCAST_ADDR}:${config.DISCOVERY_SERVER_PORT}`
            );
          }
        }
      );
    });

    client.on("message", (msg, rinfo) => {
      console.log(`Received response from ${rinfo.address}:${rinfo.port}`);
      console.log(msg.toString("hex"));

      const host = rinfo.address;
      if (!responses[host]) {
        responses[host] = [];
      }
      responses[host].push(msg);
    });

    client.on("error", (err) => {
      console.error("Socket error:", err);
      client.close();
      reject(err);
    });

    client.bind(3620);

    // Listen for 3 seconds then resolve with responses
    setTimeout(() => {
      client.close();
      const result = Object.keys(responses).map(host => ({
        host,
        data: responses[host]
      }));
      resolve(result);
    }, 10000);
  });
}

// listeon on port 3620 tcp
const server = createServer(socket => {
  console.log("Connected to main server");

  socket.on("data", data => {
    console.log("Received data:", data.toString("hex"));
  });

  socket.on("close", () => {
    console.log("Disconnected from main server");
  });
});

server.listen(3620, () => {
  console.log("Main server listening on port 3620");
});
findProjectors()

