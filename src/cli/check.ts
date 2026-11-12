// `check [skills...]`: like update, but only reports what has an update.
import type { Ctx } from "./command.ts";
import { updateLikeCommand } from "./update.ts";

export function checkCommand(ctx: Ctx) {
  return updateLikeCommand(ctx, "check").description("Check for updates without changing anything");
}
