// `npm run sim` — runs Bridge against the terminal simulator instead of real iMessage.
// (Sets PHOTON_MODE here instead of in the npm script so it works on Windows too.)
process.env.PHOTON_MODE = "mock";
await import("./index.js");
export {};
