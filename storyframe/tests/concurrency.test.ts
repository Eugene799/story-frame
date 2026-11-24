import { describe, expect, it, vi } from "vitest";
import { postTest, startTestServer } from "./server-helpers";

// MOCKED: the provider is held open locally to exercise duplicate submission.

describe("duplicate submission", () => {
  it("allows only one provider request at a time", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await gate;
      return new Response(
        JSON.stringify({
          model: "gemma4:31b",
          message: { content: "First request wins." },
          done: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const app = await startTestServer({ fetchImpl });

    try {
      const first = postTest(app.url, { model: "gemma", prompt: "Hello" });
      // Give the first request time to occupy the single concurrency slot.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = await postTest(app.url, { model: "gemma", prompt: "Hello again" });
      expect(second.status).toBe(429);
      expect(await second.json()).toMatchObject({ ok: false, error: { code: "REQUEST_IN_PROGRESS" } });

      release?.();
      const firstResponse = await first;
      expect(firstResponse.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      await app.close();
    }
  });
});
