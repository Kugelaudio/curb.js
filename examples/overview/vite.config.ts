import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Its own port: the framework's preview owns 4000 and this is meant to run
// beside it during a demo, not instead of it.
export default defineConfig({
  plugins: [react()],
  server: { port: 4100, host: "127.0.0.1" },
});
