/* Baseline engine. Built from src/ by scripts/build.mjs. Do not edit. */
"use strict";

// .claude-plugin/plugin.json
var plugin_default = {
  name: "baseline",
  version: "0.1.0",
  description: "Acceptance testing for any web app, inside Claude Code. Point it at a PR, ticket or spec and a URL. It reads the code, walks the site as your test users, and reports where spec, code and site disagree.",
  author: {
    name: "John Chaplin"
  },
  homepage: "https://github.com/Johnster02/Baseline",
  repository: "https://github.com/Johnster02/Baseline",
  license: "MIT",
  keywords: [
    "qa",
    "acceptance-testing",
    "playwright",
    "testing"
  ],
  userConfig: {
    jira_base_url: {
      type: "string",
      title: "Jira base URL",
      description: "For example https://acme.atlassian.net. Only needed for Jira tickets when no Jira connector is set up.",
      required: false
    },
    jira_email: {
      type: "string",
      title: "Jira account email",
      required: false,
      description: "The email of the Jira account the token belongs to."
    },
    jira_token: {
      type: "string",
      title: "Jira API token",
      required: false,
      sensitive: true,
      description: "A Jira API token. Stored in your system's secure credential store."
    },
    linear_api_key: {
      type: "string",
      title: "Linear API key",
      description: "Only needed for Linear issues when no Linear connector is set up. Stored in your system's secure credential store.",
      required: false,
      sensitive: true
    }
  }
};

// src/cli.ts
var commands = /* @__PURE__ */ new Map();
function register(name, help, handler) {
  commands.set(name, { handler, help });
}
function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}
function err(text) {
  process.stderr.write(text.endsWith("\n") ? text : text + "\n");
}
register("version", "print the plugin version", () => {
  out(plugin_default.version);
  return 0;
});
function usage() {
  const lines = [...commands.entries()].sort().map(([n, c]) => `  ${n.padEnd(14)} ${c.help}`);
  return ["usage: baseline <command> [args]", "", ...lines].join("\n");
}
async function main(argv) {
  const [name, ...rest] = argv;
  const cmd = name ? commands.get(name) : void 0;
  if (!cmd) {
    err(usage());
    return 2;
  }
  return await cmd.handler(rest);
}

// src/entry.ts
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(String(e && e.message || e) + "\n");
    process.exit(1);
  }
);
