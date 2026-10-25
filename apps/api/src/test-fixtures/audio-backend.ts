// Runs only against a freshly allocated integration-test database and storage root.
export {};
if (!/^beehave_audio_test_[a-f0-9]+$/.test(process.env.PGDATABASE ?? "") || !process.env.BEEHAVE_RECORDING_ROOT) {
  throw Error("Audio integration isolation guard");
}
const { createApp } = await import("../app");
const { app } = await createApp();
const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(JSON.stringify({ port: address.port }));
});
