import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunRequest } from "./request.js";

export const attachments = (request: RunRequest, directory: string) => [
  ...(request.files ?? []).map((file) => ({
    uri: pathToFileURL(resolve(directory, file)).href,
    name: basename(file),
  })),
  ...(request.inlineFiles ?? []).map((file) => ({
    uri: `data:application/octet-stream;base64,${file.content}`,
    name: file.filename,
  })),
];
