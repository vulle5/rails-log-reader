// Throwaway experiment: drive `bin/rails console` through a Bun PTY (`Bun.spawn`'s
// `terminal` option) and log the raw bytes IRB and Reline write back.
//
//   bun docs/research/driving-a-rails-console-from-bun/irb-over-pty.ts [--answer-dsr] [irb flags...]
//
// `--answer-dsr` replies to Reline's cursor-position query (ESC [ 6 n) the way a terminal
// emulator would; without it Reline waits out its own timeout on every prompt.

const appRoot = new URL("../../../example-app/", import.meta.url).pathname;
const args = process.argv.slice(2);
const answerDsr = args[0] === "--answer-dsr";
const irbFlags = answerDsr ? args.slice(1) : args;
const t0 = performance.now();
const stamp = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;
const decoder = new TextDecoder();

const proc = Bun.spawn(["bin/rails", "console", "--", ...irbFlags], {
  cwd: appRoot,
  terminal: {
    cols: 100,
    rows: 30,
    data(terminal, bytes) {
      const text = decoder.decode(bytes);
      console.log(`[${stamp()} pty] ${JSON.stringify(text)}`);
      if (answerDsr && text.includes("\x1b[6n")) terminal.write("\x1b[1;1R");
    },
  },
});

const send = async (text: string, waitMs = 1500) => {
  console.log(`[${stamp()} in ] ${JSON.stringify(text)}`);
  proc.terminal!.write(text);
  await Bun.sleep(waitMs);
};

await Bun.sleep(6000); // boot
await send("1 + 1\r");
await send("def foo\r");
await send("42\r");
await send("end\r");
await send("Post.cou\t", 1000);
await send("\t", 1000); // second Tab: Reline lists candidates
await send("\r");
await send("sleep 30; :never\r", 1000);
console.log(`[${stamp()} ^C ] writing \\x03 to the PTY`);
proc.terminal!.write("\x03");
await Bun.sleep(1500);
await send(":after_interrupt\r");
await send("exit\r");
console.log(`[${stamp()} exit] code=${await proc.exited} signal=${proc.signalCode}`);
proc.terminal!.close();
