import { createHash, timingSafeEqual } from "node:crypto";

export const json = (
  body: object,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const failure = (
  status: number,
  code: string,
  error: string,
  requestId: string,
  headers: Record<string, string> = {},
) => json({ code, error, requestId }, status, headers);

export const authorized = (request: Request, token: string | undefined) => {
  if (token === undefined) return true;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(token), hash(header.slice(7)));
};

export const readBody = async (
  request: Request,
  maxBytes: number,
  id: string,
): Promise<{ value: unknown } | { response: Response }> => {
  if (
    request.headers.get("content-type")?.toLowerCase().split(";")[0]?.trim() !==
    "application/json"
  ) {
    return {
      response: failure(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "request body must be application/json",
        id,
      ),
    };
  }
  const tooLarge = () => ({
    response: failure(413, "PAYLOAD_TOO_LARGE", "request body too large", id),
  });
  if (Number(request.headers.get("content-length")) > maxBytes)
    return tooLarge();
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  let size = 0;
  try {
    if (reader !== undefined) {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          return tooLarge();
        }
        chunks.push(item.value);
      }
    }
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { response: failure(400, "VALIDATION", "invalid JSON body", id) };
  } finally {
    reader?.releaseLock();
  }
};
