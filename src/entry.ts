import { main, io } from "./cli";
import { findProjectRoot } from "./project";
import { errMsg } from "./core/json";
import "./commands";

// Agents may call baseline from inside a run folder. Work from the project root, but remember
// where the caller was so relative paths still mean what they meant.
io.origCwd = process.cwd();
const root = findProjectRoot(process.cwd());
if (root && root !== process.cwd()) process.chdir(root);

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(errMsg(e) + "\n");
    process.exit(1);
  },
);
