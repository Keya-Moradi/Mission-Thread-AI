// Standalone probe, spawned as its own child process by
// import-side-effects.test.ts. Its only job is to import the module path
// given as argv[2] and then print a fixed marker block *after* import
// completes — anything printed before "PROBE_MARKER_START" is output the
// import itself produced, which the test asserts never happens.
const modulePath = process.argv[2];
const mod = await import(modulePath);

console.log("PROBE_MARKER_START");
console.log(`sigint_listeners=${process.listenerCount("SIGINT")}`);
console.log(`sigterm_listeners=${process.listenerCount("SIGTERM")}`);
console.log(`has_createServer=${typeof mod.createMissionThreadMcpServer === "function"}`);
console.log(`has_startStdio=${typeof mod.startMissionThreadStdioServer === "function"}`);
console.log("PROBE_MARKER_END");
process.exit(0);
