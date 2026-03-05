import { CommandContext, Context, InlineKeyboard } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession, setCurrentSession, type SessionInfo } from "../../session/manager.js";
import { renameManager } from "../../rename/manager.js";
import { interactionManager } from "../../interaction/manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

const RENAME_CALLBACK_PREFIX = "rename:";
const RENAME_CALLBACK_CANCEL = `${RENAME_CALLBACK_PREFIX}cancel`;

function normalizeDirectoryForApi(directory: string): string {
  return directory.replace(/\\/g, "/");
}

export async function renameCommand(ctx: CommandContext<Context>): Promise<void> {
  const currentSession = getCurrentSession();

  if (!currentSession) {
    await ctx.reply(t("rename.no_active_session"));
    return;
  }

  logger.info(`[RenameCommand] Starting rename flow for session: ${currentSession.id}`);

  const keyboard = new InlineKeyboard().text(t("rename.button.cancel"), RENAME_CALLBACK_CANCEL);

  const message = await ctx.reply(t("rename.prompt"), {
    reply_markup: keyboard,
  });

  renameManager.start(message.message_id, currentSession.id, currentSession.directory);

  interactionManager.start({
    kind: "custom",
    expectedInput: "mixed",
    allowedCommands: ["/help", "/status", "/stop"],
    metadata: {
      flow: "rename",
      messageId: message.message_id,
      sessionId: currentSession.id,
      directory: currentSession.directory,
    },
  });
}

function isRenameInteractionActive(): boolean {
  const state = interactionManager.getSnapshot();
  if (!state || state.kind !== "custom") {
    return false;
  }
  return state.metadata.flow === "rename";
}

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

export async function handleRenameCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(RENAME_CALLBACK_PREFIX)) {
    return false;
  }

  logger.debug(`[RenameHandler] Received callback: ${data}`);

  const callbackMessageId = getCallbackMessageId(ctx);
  const expectedMessageId = renameManager.getMessageId();

  if (
    !isRenameInteractionActive() ||
    callbackMessageId === null ||
    callbackMessageId !== expectedMessageId
  ) {
    await ctx.answerCallbackQuery({ text: t("rename.inactive_callback"), show_alert: true });
    return true;
  }

  try {
    if (data === RENAME_CALLBACK_CANCEL) {
      renameManager.cancel();

      const state = interactionManager.getSnapshot();
      if (state?.kind === "custom" && state.metadata.flow === "rename") {
        interactionManager.clear("rename_cancelled");
      }

      await ctx.editMessageText(t("rename.cancelled")).catch(() => {});
      await ctx.answerCallbackQuery({ text: t("rename.cancelled_callback") });
      return true;
    }

    await ctx.answerCallbackQuery({ text: t("callback.unknown_command") });
    return true;
  } catch (err) {
    logger.error("[RenameHandler] Error handling callback:", err);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}

export async function handleRenameTextInput(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text;
  if (!text || text.startsWith("/")) {
    return false;
  }

  if (!isRenameInteractionActive()) {
    return false;
  }

  const newTitle = text.trim();
  if (!newTitle) {
    await ctx.reply(t("rename.empty_title"));
    return true;
  }

  const sessionId = renameManager.getSessionId();
  const directory = renameManager.getDirectory();
  const messageId = renameManager.getMessageId();

  if (!sessionId || !directory) {
    logger.error("[RenameHandler] Missing session info for rename");
    await ctx.reply(t("rename.error"));
    renameManager.clear();
    interactionManager.clear("rename_error");
    return true;
  }

  logger.info(`[RenameHandler] Renaming session ${sessionId} to: ${newTitle}`);

  try {
    const { error } = await opencodeClient.session.update({
      sessionID: sessionId,
      directory: normalizeDirectoryForApi(directory),
      title: newTitle,
    });

    if (error) {
      logger.error("[RenameHandler] Failed to rename session:", error);
      await ctx.reply(t("rename.error"));
      renameManager.clear();
      interactionManager.clear("rename_api_error");
      return true;
    }

    // Update session title in settings
    const currentSession = getCurrentSession();
    if (currentSession && currentSession.id === sessionId) {
      const updatedSession: SessionInfo = {
        ...currentSession,
        title: newTitle,
      };
      setCurrentSession(updatedSession);
    }

    // Delete the original prompt message
    if (messageId !== null && ctx.chat) {
      await ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {});
    }

    await ctx.reply(t("rename.success", { title: newTitle }));

    renameManager.clear();
    interactionManager.clear("rename_completed");
  } catch (err) {
    logger.error("[RenameHandler] Unexpected error during rename:", err);
    await ctx.reply(t("rename.error"));
    renameManager.clear();
    interactionManager.clear("rename_exception");
  }

  return true;
}
