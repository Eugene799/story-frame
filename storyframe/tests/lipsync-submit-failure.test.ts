import { describe, expect, it } from "vitest";
import { formatSubmitFailure } from "../scripts/lipsync-submit-failure";

describe("lip sync submission failure", () => {
  it("surfaces the server's provider code and message", () => {
    expect(
      formatSubmitFailure(502, {
        ok: false,
        error: {
          code: "LIPSYNC_PROVIDER_FAILED",
          message: "Everypixel rejected the lip sync request (HTTP 500).",
        },
      }),
    ).toBe("HTTP 502 LIPSYNC_PROVIDER_FAILED Everypixel rejected the lip sync request (HTTP 500).");
  });

  it("falls back to a flat message and never invents detail", () => {
    expect(formatSubmitFailure(500, { message: "Everypixel could not be reached." })).toBe(
      "HTTP 500 Everypixel could not be reached.",
    );
    expect(formatSubmitFailure(502, null)).toBe("HTTP 502");
    expect(formatSubmitFailure(400, "bad request")).toBe("HTTP 400");
  });

  it("includes an upstream provider status when the server reports one", () => {
    expect(
      formatSubmitFailure(502, {
        ok: false,
        error: { code: "VIDEO_PROVIDER_FAILED", message: "JSON2Video rejected the render.", upstreamStatus: 500 },
      }),
    ).toBe("HTTP 502 VIDEO_PROVIDER_FAILED JSON2Video rejected the render. (upstream 500)");
  });
});
