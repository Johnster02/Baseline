import { startFixture } from "./server";
const f = await startFixture();
console.log(`Acme shop fixture at ${f.url} (sign in as customer@acme.test / pw)`);
