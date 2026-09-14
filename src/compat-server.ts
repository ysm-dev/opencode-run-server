import { bootstrap } from "./compat/bootstrap.js";

/* v8 ignore next -- executable entry exercised by installed-package tests */
await bootstrap(process.env);
