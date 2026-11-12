// Reusable library for talking the Epson wireless projector protocol —
// see docs/README.md for the full protocol spec this implements.
//
//   import { client, simulator, shared } from "./lib";
//
// - client:    act as the iProjection app, talk to a real (or simulated) projector
// - simulator: act as a projector, for a real iProjection app to connect to
// - shared:    wire framing + protocol constants used by both sides
export * as client from "./client";
export * as simulator from "./simulator";
export * as shared from "./shared";
