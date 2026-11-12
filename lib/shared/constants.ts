// Protocol constants. Payloads are built field by field in ./messages.ts
// (control channel) and ./eprd.ts (video channel); nothing here is copied
// from a packet capture.

export const EEMP_CONTROL_WORD = "EEMP0100";
export const EPRD_CONTROL_WORD = "EPRD0600";

/** Framebuffer size used when the projector's capabilities don't say. */
export const EPRD_FRAMEBUFFER_WIDTH = 1280;
export const EPRD_FRAMEBUFFER_HEIGHT = 800;
