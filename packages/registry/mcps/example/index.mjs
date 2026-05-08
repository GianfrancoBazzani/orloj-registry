import { z } from "zod";

export default function register(server) {
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Returns the input text unchanged.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({
      content: [{ type: "text", text }],
    }),
  );
}
