import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ALLOWED_INTERACTION_COMMANDS,
  interactionManager,
} from "../../src/interaction/manager.js";

describe("interactionManager", () => {
  beforeEach(() => {
    interactionManager.clear("test_setup");
  });

  it("starts interaction with defaults", () => {
    const state = interactionManager.start({
      kind: "question",
      expectedInput: "callback",
      metadata: { requestId: "q-1" },
    });

    expect(state.kind).toBe("question");
    expect(state.expectedInput).toBe("callback");
    expect(state.metadata).toEqual({ requestId: "q-1" });
    expect(state.allowedCommands).toEqual([...DEFAULT_ALLOWED_INTERACTION_COMMANDS]);
    expect(state.createdAt).toBeTypeOf("number");
    expect(state.expiresAt).toBeNull();
    expect(interactionManager.isActive()).toBe(true);
  });

  it("normalizes and deduplicates allowed commands", () => {
    const state = interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      allowedCommands: ["/Help", "status", "/help", " /STATUS@MyBot ", "", " / "],
    });

    expect(state.allowedCommands).toEqual(["/help", "/status"]);
  });

  it("tracks expiration by expiresAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    interactionManager.start({
      kind: "permission",
      expectedInput: "callback",
      expiresInMs: 1000,
    });

    expect(interactionManager.isExpired()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(interactionManager.isExpired()).toBe(true);
  });

  it("clears active interaction", () => {
    interactionManager.start({
      kind: "custom",
      expectedInput: "mixed",
    });

    interactionManager.clear("test");

    expect(interactionManager.isActive()).toBe(false);
    expect(interactionManager.get()).toBeNull();
  });
});
