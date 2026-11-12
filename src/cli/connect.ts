// `connect` was replaced by `self setup`; kept (hidden) so old instructions get a pointer instead of
// "unknown command".
import { type Ctx, newCommand, warnUnknownOptions } from "./command.ts";

export function connectCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("connect")).action(() => {
    console.error("Error: connect was replaced by self setup\nRun skill-library self setup to install the gateway skill into your agents.");
    ctx.done(1);
  });
}
