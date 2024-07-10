import dgram from "dgram";
import { createServer } from "net";
import config from "../config";
import {
  handleDiscoveryServerConnection,
  handleImageServerConnection,
  handleMainServerConnection,
} from "./handler";

console.log("------EPSON NETWORK PROJECTOR SIMULATOR------");

const mainServer = createServer(handleMainServerConnection);
const imageServer = createServer(handleImageServerConnection);

const discoveryServer = dgram.createSocket("udp4");

discoveryServer.on("message", (msg, rinfo) => {
  handleDiscoveryServerConnection(msg, rinfo, (msg, port) => {
    discoveryServer.send(msg, port, rinfo.address);
  });
});

mainServer.listen(config.MAIN_SERVER_PORT, () => {
  console.log(`Main server listening on port ${config.MAIN_SERVER_PORT}`);
});

imageServer.listen(config.IMAGE_SERVER_PORT, () => {
  console.log(`Image server listening on port ${config.IMAGE_SERVER_PORT}`);
});

discoveryServer.bind(config.DISCOVERY_SERVER_PORT);
