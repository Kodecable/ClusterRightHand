import { setArgon2ParametersForTesting } from "./src/auth/password.ts";

// Argon2id at production cost holds 64 MiB and takes hundreds of milliseconds; test/password.test.ts
// restores the production parameters where the cost is the point. m=1024 KiB, t=1 keeps every suite fast.
setArgon2ParametersForTesting({ memory: 1024, passes: 1, parallelism: 1 });
