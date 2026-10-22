import { main } from "./cli";
import "./commands";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(String((e && e.message) || e) + "\n");
    process.exit(1);
  },
);
