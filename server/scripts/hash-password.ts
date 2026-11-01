import { hashPassword, randomSecret } from "../src/password.js";

const MIN_LENGTH = 10;

async function readPiped(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0] ?? "";
}

/** Prompts go to stderr so stdout carries only the NAME=value lines, ready for `fly secrets import`. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (input: string) => {
      for (const char of input) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          process.stderr.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await promptHidden("Choose a password for Recall: ");
    const again = await promptHidden("Type it again: ");
    if (password !== again) {
      console.error("The passwords didn't match. Nothing was changed.");
      process.exit(1);
    }
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_LENGTH) {
    console.error(`Use at least ${MIN_LENGTH} characters. A short phrase works well.`);
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const secret = randomSecret();
  console.error("\nAdd these two lines to .env for local use, or set them as Fly secrets:\n");
  console.log(`RECALL_PASSWORD_HASH=${hash}`);
  console.log(`RECALL_SESSION_SECRET=${secret}`);
  console.error(`\nFor Fly:\n  fly secrets set RECALL_PASSWORD_HASH='${hash}' RECALL_SESSION_SECRET='${secret}'`);
}

await main();
