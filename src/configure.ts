import { modelRef, type RunRequest } from "./request.js";
import type { RunContext } from "./runner.js";

type SessionModel = Awaited<ReturnType<RunContext["session"]["get"]>>["model"];

/** Applies the model, variant, agent, and title a run asked for. */
export const configureSession = async (
  context: RunContext,
  request: RunRequest,
  sessionID: string,
  current: SessionModel,
  signal: AbortSignal,
) => {
  const selected =
    request.model !== undefined
      ? modelRef(request.model, request.variant)
      : request.variant !== undefined
        ? (current ?? (await context.catalog.model.default()).data ?? undefined)
        : undefined;
  if (request.variant !== undefined && selected === undefined) {
    throw new Error("Cannot select a variant before selecting a model");
  }
  if (selected !== undefined) {
    await context.session.switchModel(
      {
        sessionID,
        model: {
          ...selected,
          ...(request.variant === undefined
            ? {}
            : { variant: request.variant }),
        },
      },
      { signal },
    );
  }
  if (request.agent !== undefined)
    await context.session.switchAgent(
      { sessionID, agent: request.agent },
      { signal },
    );
  if (request.title !== undefined)
    await context.session.rename(
      { sessionID, title: request.title },
      { signal },
    );
};
