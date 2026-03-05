import { permissionManager } from "../permission/manager.js";
import { questionManager } from "../question/manager.js";
import { interactionManager } from "./manager.js";
import { logger } from "../utils/logger.js";

export function clearAllInteractionState(reason: string): void {
  const questionActive = questionManager.isActive();
  const permissionActive = permissionManager.isActive();
  const interactionSnapshot = interactionManager.getSnapshot();

  questionManager.clear();
  permissionManager.clear();
  interactionManager.clear(reason);

  const hasAnyActiveState = questionActive || permissionActive || interactionSnapshot !== null;

  const message =
    `[InteractionCleanup] Cleared state: reason=${reason}, ` +
    `questionActive=${questionActive}, permissionActive=${permissionActive}, ` +
    `interactionKind=${interactionSnapshot?.kind || "none"}`;

  if (hasAnyActiveState) {
    logger.info(message);
    return;
  }

  logger.debug(message);
}
