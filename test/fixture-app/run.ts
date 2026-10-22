import { startFixture } from "./server";
const f = await startFixture(Number(process.env.PORT) || 0);
console.log(`Acme shop fixture at ${f.url} (sign in as customer@acme.test / pw)`);
