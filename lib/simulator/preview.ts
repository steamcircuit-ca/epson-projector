// Browser preview of the incoming video stream. Serves a canvas page and
// pushes decoded JPEG rects to it over Server-Sent Events (no dependencies).
import { createServer, ServerResponse } from "http";
import { exec } from "child_process";
import { Rect } from "../shared/eprd";
import {
  EPRD_FRAMEBUFFER_WIDTH,
  EPRD_FRAMEBUFFER_HEIGHT,
} from "../shared/constants";

const clients = new Set<ServerResponse>();

let lastInit = {
  width: EPRD_FRAMEBUFFER_WIDTH,
  height: EPRD_FRAMEBUFFER_HEIGHT,
};
// latest rect per screen position, so a late-opened page gets the current frame
const lastRects = new Map<string, Rect>();

function sendEvent(res: ServerResponse, event: object) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event: object) {
  for (const res of clients) sendEvent(res, event);
}

export function publishInit(info: { width: number; height: number }) {
  lastInit = info;
  lastRects.clear();
  broadcast({ type: "init", ...info });
}

export function publishRect(rect: Rect) {
  lastRects.set(`${rect.x},${rect.y}`, rect);
  broadcast({
    type: "rect",
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    jpeg: rect.jpeg.toString("base64"),
  });
}

export function publishStatus(text: string) {
  broadcast({ type: "status", text });
}

const PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Projector Preview</title>
<style>
  body { margin: 0; background: #1c1c1e; color: #ddd; font: 13px monospace;
         display: flex; flex-direction: column; align-items: center; }
  #status { padding: 8px; }
  canvas { max-width: 96vw; height: auto; background: #000;
           box-shadow: 0 0 24px #000; }
</style>
</head>
<body>
<div id="status">waiting for stream…</div>
<canvas id="screen" width="1280" height="800"></canvas>
<script>
  const canvas = document.getElementById("screen");
  const ctx = canvas.getContext("2d");
  const status = document.getElementById("status");
  let frames = 0;
  let queue = Promise.resolve();

  const source = new EventSource("/events");
  source.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "init") {
      canvas.width = msg.width;
      canvas.height = msg.height;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      status.textContent = "stream connected: " + msg.width + "x" + msg.height;
    } else if (msg.type === "rect") {
      // serialize async decodes so rects draw in arrival order
      queue = queue.then(() => new Promise((done) => {
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, msg.x, msg.y, msg.w, msg.h);
          frames++;
          status.textContent = canvas.width + "x" + canvas.height +
            " — " + frames + " rects";
          done();
        };
        img.onerror = done;
        img.src = "data:image/jpeg;base64," + msg.jpeg;
      }));
    } else if (msg.type === "status") {
      status.textContent = msg.text;
    }
  };
  source.onerror = () => { status.textContent = "simulator offline — retrying…"; };
</script>
</body>
</html>`;

export function startPreviewServer(port: number) {
  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      clients.add(res);
      sendEvent(res, { type: "init", ...lastInit });
      for (const rect of lastRects.values()) {
        sendEvent(res, {
          type: "rect",
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
          jpeg: rect.jpeg.toString("base64"),
        });
      }
      req.on("close", () => clients.delete(res));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE);
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`Preview window at ${url}`);
    if (process.platform === "darwin" && !process.env.PREVIEW_NO_OPEN) {
      exec(`open ${url}`);
    }
  });

  return server;
}
