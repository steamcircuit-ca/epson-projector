import { readFileSync } from "fs";
import { join } from "path";
import { Rect, jpegDimensions } from "../shared/eprd";

const TESTCARD_DIR = join(__dirname, "testcard");

type TestCardTile = { file: string; x: number; y: number; w: number; h: number };

// The captured 4-tile "Connected to iProjection." test card, as a default
// set of frame rects to stream.
export function loadTestCard(): Rect[] {
  const index = JSON.parse(readFileSync(join(TESTCARD_DIR, "index.json"), "utf8"));
  return index.tiles.map((tile: TestCardTile) => ({
    x: tile.x,
    y: tile.y,
    w: tile.w,
    h: tile.h,
    jpeg: readFileSync(join(TESTCARD_DIR, tile.file)),
  }));
}

// An arbitrary JPEG file as a single full-frame rect. Dimensions are read
// from the JPEG's own SOF marker rather than trusted from outside.
export function loadJpegFrame(path: string): Rect[] {
  const jpeg = readFileSync(path);
  const dims = jpegDimensions(jpeg);
  if (!dims) {
    throw new Error(`${path} does not look like a baseline JPEG`);
  }
  return [{ x: 0, y: 0, w: dims.width, h: dims.height, jpeg }];
}
