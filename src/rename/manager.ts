import { logger } from "../utils/logger.js";

interface RenameState {
  messageId: number | null;
  sessionId: string | null;
  directory: string | null;
}

class RenameManager {
  private state: RenameState = {
    messageId: null,
    sessionId: null,
    directory: null,
  };

  start(messageId: number, sessionId: string, directory: string): void {
    logger.info(
      `[RenameManager] Starting rename flow: messageId=${messageId}, sessionId=${sessionId}`,
    );

    this.state = {
      messageId,
      sessionId,
      directory,
    };
  }

  isActive(): boolean {
    return this.state.sessionId !== null;
  }

  getMessageId(): number | null {
    return this.state.messageId;
  }

  getSessionId(): string | null {
    return this.state.sessionId;
  }

  getDirectory(): string | null {
    return this.state.directory;
  }

  cancel(): void {
    logger.info("[RenameManager] Cancelling rename flow");
    this.state.sessionId = null;
  }

  clear(): void {
    logger.info("[RenameManager] Clearing rename state");
    this.state = {
      messageId: null,
      sessionId: null,
      directory: null,
    };
  }
}

export const renameManager = new RenameManager();
