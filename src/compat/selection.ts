import type { OpenCodeClient } from "@opencode/client";
import type { LegacyRequest } from "./request.js";

export const selectSession = async (
  client: OpenCodeClient,
  request: LegacyRequest,
  directory: string,
  signal: AbortSignal,
) => {
  const options = { signal };
  const location = await client.location.get(
    { location: { directory } },
    options,
  );
  let selected =
    request.session === undefined
      ? undefined
      : await client.session.get({ sessionID: request.session }, options);
  if (selected === undefined && request.continue) {
    let cursor: string | undefined;
    do {
      const page = await client.session.list(
        {
          directory: location.directory,
          parentID: null,
          order: "desc",
          limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
        },
        options,
      );
      selected = page.data.find(
        (session) => session.location.directory === location.directory,
      );
      cursor = page.cursor.next ?? undefined;
    } while (selected === undefined && cursor !== undefined);
  }
  // Omitting `before` forks the whole session, matching the previous
  // unconditional `{ type: "through" }` boundary.
  if (selected !== undefined && request.fork)
    return client.session.fork({ sessionID: selected.id }, options);
  return (
    selected ??
    client.session.create(
      { location: { directory: location.directory } },
      options,
    )
  );
};
