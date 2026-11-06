import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/socket.io": { target: "http://localhost:2567", ws: true },
      "/api": { target: "http://localhost:2567" }
    }
  }
});
