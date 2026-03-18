import type { Api, RawApi } from "grammy";
import { logger } from "../../utils/logger.js";
import { isTelegramMarkdownParseError } from "../utils/send-with-markdown-fallback.js";

type DraftApi = Pick<Api<RawApi>, "sendMessageDraft">;
type TelegramDraftOptions = Parameters<DraftApi["sendMessageDraft"]>[3];

export type ResponseDraftFormat = "raw" | "markdown_v2";

export interface ResponseDraftPayload {
  text: string;
  format: ResponseDraftFormat;
}

interface ResponseStreamerCompleteOptions {
  flushFinal?: boolean;
}

interface ResponseStreamerOptions {
  throttleMs: number;
  sendDraft: (draftId: number, text: string, options?: TelegramDraftOptions) => Promise<void>;
}

interface StreamState {
  key: string;
  sessionId: string;
  messageId: string;
  draftId: number;
  latestPayload: ResponseDraftPayload | null;
  lastSentSignature: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  task: Promise<void>;
}

function buildStateKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

function normalizePayload(payload: ResponseDraftPayload): ResponseDraftPayload | null {
  const normalizedText = payload.text.trim();
  if (!normalizedText) {
    return null;
  }

  return {
    text: normalizedText,
    format: payload.format,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getRetryAfterMs(error: unknown): number | null {
  const message = getErrorMessage(error);
  if (!/\b429\b/.test(message)) {
    return null;
  }

  const retryMatch = message.match(/retry after\s+(\d+)/i);
  if (!retryMatch) {
    return null;
  }

  const seconds = Number.parseInt(retryMatch[1], 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return seconds * 1000;
}

export class ResponseStreamer {
  private readonly throttleMs: number;
  private readonly sendDraft: ResponseStreamerOptions["sendDraft"];
  private readonly states: Map<string, StreamState> = new Map();
  private nextDraftId = 1;
  private unavailable = false;

  constructor(options: ResponseStreamerOptions) {
    this.throttleMs = Math.max(0, Math.floor(options.throttleMs));
    this.sendDraft = options.sendDraft;
  }

  enqueue(sessionId: string, messageId: string, payload: ResponseDraftPayload): void {
    if (this.unavailable) {
      return;
    }

    const normalizedPayload = normalizePayload(payload);
    if (!normalizedPayload) {
      return;
    }

    const state = this.getOrCreateState(sessionId, messageId);
    state.latestPayload = normalizedPayload;
    this.ensureTimer(state);
  }

  async complete(
    sessionId: string,
    messageId: string,
    payload?: ResponseDraftPayload,
    options?: ResponseStreamerCompleteOptions,
  ): Promise<boolean> {
    if (this.unavailable) {
      return false;
    }

    const state = this.states.get(buildStateKey(sessionId, messageId));
    if (!state) {
      return false;
    }

    if (payload) {
      const normalizedPayload = normalizePayload(payload);
      if (normalizedPayload) {
        state.latestPayload = normalizedPayload;
      }
    }

    if (state.lastSentSignature === null) {
      this.clearTimer(state);
      this.states.delete(state.key);
      return false;
    }

    const streamedAtLeastOnce = state.lastSentSignature !== null;

    this.clearTimer(state);
    if (options?.flushFinal !== false) {
      await this.enqueueTask(state, () => this.flushState(state, "complete"));
    }
    this.clearTimer(state);
    this.states.delete(state.key);
    return streamedAtLeastOnce;
  }

  clearMessage(sessionId: string, messageId: string, reason: string): void {
    const key = buildStateKey(sessionId, messageId);
    const state = this.states.get(key);
    if (!state) {
      return;
    }

    this.clearTimer(state);
    this.states.delete(key);
    logger.debug(
      `[ResponseStreamer] Cleared message stream: session=${sessionId}, message=${messageId}, reason=${reason}`,
    );
  }

  clearSession(sessionId: string, reason: string): void {
    for (const state of Array.from(this.states.values())) {
      if (state.sessionId !== sessionId) {
        continue;
      }

      this.clearTimer(state);
      this.states.delete(state.key);
    }

    logger.debug(
      `[ResponseStreamer] Cleared session streams: session=${sessionId}, reason=${reason}`,
    );
  }

  clearAll(reason: string): void {
    for (const state of this.states.values()) {
      this.clearTimer(state);
    }

    const count = this.states.size;
    this.states.clear();

    if (count > 0) {
      logger.debug(`[ResponseStreamer] Cleared all streams: count=${count}, reason=${reason}`);
    }
  }

  private getOrCreateState(sessionId: string, messageId: string): StreamState {
    const key = buildStateKey(sessionId, messageId);
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }

    const state: StreamState = {
      key,
      sessionId,
      messageId,
      draftId: this.consumeDraftId(),
      latestPayload: null,
      lastSentSignature: null,
      timer: null,
      task: Promise.resolve(),
    };

    this.states.set(key, state);
    return state;
  }

  private consumeDraftId(): number {
    const draftId = this.nextDraftId;
    this.nextDraftId++;

    if (this.nextDraftId > Number.MAX_SAFE_INTEGER) {
      this.nextDraftId = 1;
    }

    return draftId;
  }

  private ensureTimer(state: StreamState): void {
    if (state.timer) {
      return;
    }

    if (this.throttleMs === 0) {
      void this.enqueueTask(state, () => this.flushState(state, "immediate"));
      return;
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.enqueueTask(state, () => this.flushState(state, "throttle_elapsed"));
    }, this.throttleMs);
  }

  private clearTimer(state: StreamState): void {
    if (!state.timer) {
      return;
    }

    clearTimeout(state.timer);
    state.timer = null;
  }

  private enqueueTask(state: StreamState, task: () => Promise<void>): Promise<void> {
    const nextTask = state.task
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        logger.error(
          `[ResponseStreamer] Stream task failed: session=${state.sessionId}, message=${state.messageId}`,
          error,
        );
      });

    state.task = nextTask;
    return nextTask;
  }

  private async flushState(state: StreamState, reason: string): Promise<void> {
    if (this.unavailable) {
      return;
    }

    const payload = state.latestPayload;
    if (!payload) {
      return;
    }

    const signature = `${payload.format}\n${payload.text}`;
    if (state.lastSentSignature === signature) {
      return;
    }

    try {
      await this.sendPayload(state.draftId, payload);
      state.lastSentSignature = signature;
      logger.debug(
        `[ResponseStreamer] Draft sent: session=${state.sessionId}, message=${state.messageId}, reason=${reason}, length=${payload.text.length}`,
      );
    } catch (error) {
      const retryAfterMs = getRetryAfterMs(error);
      if (retryAfterMs !== null) {
        this.scheduleRetry(state, retryAfterMs, reason, error);
        return;
      }

      this.disableStreaming(error);
    }
  }

  private scheduleRetry(
    state: StreamState,
    retryAfterMs: number,
    reason: string,
    error: unknown,
  ): void {
    const delayMs = Math.max(this.throttleMs, retryAfterMs);
    this.clearTimer(state);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.enqueueTask(state, () => this.flushState(state, "rate_limit_retry"));
    }, delayMs);

    logger.warn(
      `[ResponseStreamer] Draft send rate-limited, retrying in ${delayMs}ms: session=${state.sessionId}, message=${state.messageId}, reason=${reason}`,
      error,
    );
  }

  private async sendPayload(draftId: number, payload: ResponseDraftPayload): Promise<void> {
    if (payload.format === "markdown_v2") {
      try {
        await this.sendDraft(draftId, payload.text, { parse_mode: "MarkdownV2" });
        return;
      } catch (error) {
        if (!isTelegramMarkdownParseError(error)) {
          throw error;
        }

        logger.debug("[ResponseStreamer] Markdown draft parse failed, retrying raw", error);
      }
    }

    await this.sendDraft(draftId, payload.text);
  }

  private disableStreaming(error: unknown): void {
    if (this.unavailable) {
      return;
    }

    this.unavailable = true;
    this.clearAll("draft_unavailable");
    logger.warn("[ResponseStreamer] Disabling draft streaming after Telegram API error", error);
  }
}
