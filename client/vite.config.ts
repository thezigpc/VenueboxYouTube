import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the client runs on :5176 and talks to the server on :3006.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5176,
    proxy: {
      "/api": "http://localhost:3006",
      "/__bargames": "http://localhost:3006",
    },
  },
});
