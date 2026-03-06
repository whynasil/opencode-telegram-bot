import { CommandContext, Context, InlineKeyboard } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession, setCurrentSession } from "../../session/manager.js";
import { interactionManager } from "../../interaction/manager.js";
import type { InteractionState } from "../../interaction/types.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

const RENAME_CALLBACK_CANCEL = "rename:cancel";

interface RenameMetadata {
  flow: "rename";
  messageId: number;
}

function parseRenameMetadata(state: InteractionState | null): RenameMetadata | null {
  if (!state || state.kind !== "custom") {
    return null;
  }

  if (state.metadata.flow === "rename" && typeof state.metadata.messageId === "number") {
    return {
      flow: "rename",
      messageId: state.metadata.messageId,
    };
  }

  return null;
}

function clearRenameInteraction(reason: string): void {
  const metadata = parseRenameMetadata(interactionManager.getSnapshot());
  if (metadata) {
    interactionManager.clear(reason);
  }
}

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

export async function renameCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    const currentSession = getCurrentSession();
    if (!currentSession) {
      await ctx.reply(t("rename.no_active_session"));
      return;
    }

    const keyboard = new InlineKeyboard().text(t("rename.button.cancel"), RENAME_CALLBACK_CANCEL);
    const message = await ctx.reply(t("rename.prompt"), {
      reply_markup: keyboard,
    });

    interactionManager.start({
      kind: "custom",
      expectedInput: "mixed",
      metadata: {
        flow: "rename",
        messageId: message.message_id,
      },
    });
  } catch (error) {
    logger.error("[Rename] Error in rename command:", error);
    await ctx.reply(t("rename.error"));
  }
}

export async function handleRenameCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || data !== RENAME_CALLBACK_CANCEL) {
    return false;
  }

  const metadata = parseRenameMetadata(interactionManager.getSnapshot());
  const callbackMessageId = getCallbackMessageId(ctx);

  if (!metadata || callbackMessageId === null || metadata.messageId !== callbackMessageId) {
    await ctx.answerCallbackQuery({ text: t("rename.inactive_callback"), show_alert: true });
    return true;
  }

  try {
    clearRenameInteraction("rename_cancelled");
    await ctx.answerCallbackQuery({ text: t("rename.cancelled_callback") });
    await ctx.deleteMessage().catch(() => {});
    return true;
  } catch (error) {
    logger.error("[Rename] Error handling rename cancel callback:", error);
    clearRenameInteraction("rename_cancel_error");
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}

export async function handleRenameText(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text;
  if (!text || text.startsWith("/")) {
    return false;
  }

  const metadata = parseRenameMetadata(interactionManager.getSnapshot());
  if (!metadata) {
    return false;
  }

  const newTitle = text.trim();
  if (!newTitle) {
    await ctx.reply(t("rename.empty_name"));
    return true; // We handled it (by showing error), keep interaction alive
  }

  clearRenameInteraction("rename_submitted");

  if (ctx.chat) {
    await ctx.api.deleteMessage(ctx.chat.id, metadata.messageId).catch(() => {});
  }

  try {
    const currentSession = getCurrentSession();
    if (!currentSession) {
      await ctx.reply(t("rename.no_active_session"));
      return true;
    }

    const { error } = await opencodeClient.session.update({
      sessionID: currentSession.id,
      directory: currentSession.directory,
      title: newTitle,
    });

    if (error) {
      logger.error("[Rename] Error updating session on server:", error);
      await ctx.reply(t("rename.error"));
      return true;
    }

    const updatedSession = { ...currentSession, title: newTitle };
    setCurrentSession(updatedSession);
    await ingestSessionInfoForCache({ directory: currentSession.directory });

    if (pinnedMessageManager.isInitialized()) {
      try {
        await pinnedMessageManager.onSessionChange(updatedSession.id, updatedSession.title);
      } catch (err) {
        logger.error("[Rename] Error updating pinned message:", err);
      }
    }

    await ctx.reply(t("rename.success", { title: newTitle }));
  } catch (error) {
    logger.error("[Rename] Error handling rename text:", error);
    await ctx.reply(t("rename.error"));
  }

  return true;
}
