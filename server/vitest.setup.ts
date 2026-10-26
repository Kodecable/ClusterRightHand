import { setHashParametersForTesting } from "./src/auth/password.ts";

// scrypt at production cost takes ~0.4 s per hash; test/password.test.ts restores it where the cost matters.
setHashParametersForTesting({ N: 2 ** 10, r: 8, p: 1 });
