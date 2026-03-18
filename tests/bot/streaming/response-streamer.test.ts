import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseStreamer } from "../../../src/bot/streaming/response-streamer.js";

describe("bot/streaming/response-streamer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles updates and sends only the latest draft payload", async () => {
    vi.useFakeTimers();

    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const streamer = new ResponseStreamer({
      throttleMs: 500,
      sendDraft,
    });

    streamer.enqueue("s1", "m1", { text: "first", format: "raw" });
    streamer.enqueue("s1", "m1", { text: "second", format: "raw" });

    await vi.advanceTimersByTimeAsync(500);

    expect(sendDraft).toHaveBeenCalledTimes(1);
    expect(sendDraft).toHaveBeenCalledWith(1, "second");
  });

  it("retries raw mode when markdown draft parsing fails", async () => {
    vi.useFakeTimers();

    const sendDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValueOnce(undefined);

    const streamer = new ResponseStreamer({
      throttleMs: 0,
      sendDraft,
    });

    streamer.enqueue("s1", "m1", { text: "**hello**", format: "markdown_v2" });

    await vi.waitFor(() => {
      expect(sendDraft).toHaveBeenCalledTimes(2);
    });

    expect(sendDraft).toHaveBeenNthCalledWith(1, 1, "**hello**", { parse_mode: "MarkdownV2" });
    expect(sendDraft).toHaveBeenNthCalledWith(2, 1, "**hello**");
  });

  it("disables draft streaming after non-markdown API error", async () => {
    vi.useFakeTimers();

    const sendDraft = vi.fn().mockRejectedValue(new Error("Bad Request: method is not available"));

    const streamer = new ResponseStreamer({
      throttleMs: 0,
      sendDraft,
    });

    streamer.enqueue("s1", "m1", { text: "hello", format: "raw" });

    await vi.waitFor(() => {
      expect(sendDraft).toHaveBeenCalledTimes(1);
    });

    streamer.enqueue("s1", "m2", { text: "world", format: "raw" });
    await vi.advanceTimersByTimeAsync(100);

    expect(sendDraft).toHaveBeenCalledTimes(1);
  });

  it("flushes final payload on complete after streaming started", async () => {
    vi.useFakeTimers();

    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const streamer = new ResponseStreamer({
      throttleMs: 500,
      sendDraft,
    });

    streamer.enqueue("s1", "m1", { text: "partial", format: "raw" });
    await vi.advanceTimersByTimeAsync(500);

    await streamer.complete("s1", "m1", { text: "final", format: "raw" });
    await vi.waitFor(() => {
      expect(sendDraft).toHaveBeenCalledTimes(2);
    });

    expect(sendDraft).toHaveBeenNthCalledWith(2, 1, "final");

    await vi.advanceTimersByTimeAsync(1000);
    expect(sendDraft).toHaveBeenCalledTimes(2);
  });

  it("skips final draft when stream never emitted partial update", async () => {
    vi.useFakeTimers();

    const sendDraft = vi.fn().mockResolvedValue(undefined);
    const streamer = new ResponseStreamer({
      throttleMs: 500,
      sendDraft,
    });

    streamer.enqueue("s1", "m1", { text: "partial", format: "raw" });
    await streamer.complete("s1", "m1", { text: "final", format: "raw" });

    await vi.advanceTimersByTimeAsync(1000);
    expect(sendDraft).not.toHaveBeenCalled();
  });
});
