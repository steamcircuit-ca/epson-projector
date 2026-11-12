// Wire-protocol ports. These are just the values observed in the captures —
// nothing in the protocol negotiates them, so they're plain defaults that
// callers are free to override (e.g. to run several simulated projectors
// side by side on one machine).
export type ProjectorPorts = {
  main: number;
  discovery: number;
  image: number;
};

export const DEFAULT_PORTS: ProjectorPorts = {
  main: 3620,
  discovery: 3620,
  image: 3621,
};
