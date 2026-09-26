// Throwaway experiment: drive reader_repl.rb over stdio with line-delimited JSON.
//
//   bun docs/research/driving-a-rails-console-from-bun/custom-loop.ts runner
//   bun docs/research/driving-a-rails-console-from-bun/custom-loop.ts console

const appRoot = new URL("../../../example-app/", import.meta.url).pathname;
const script = new URL("./reader_repl.rb", import.meta.url).pathname;
const mode = process.argv[2] ?? "runner";
const command =
  mode === "console"
    ? ["bin/rails", "console", "--", "-r", script]
    : ["bin/rails", "runner", "--skip-executor", script];
const t0 = performance.now();
const stamp = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;

const proc = Bun.spawn(command, { cwd: appRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

async function drain(name: string, stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    for (const line of decoder.decode(chunk).split("\n").filter(Boolean)) {
      console.log(`[${stamp()} ${name}] ${line}`);
    }
  }
}
const drained = Promise.all([drain("out", proc.stdout), drain("err", proc.stderr)]);

let nextId = 1;
const send = async (op: string, code: string, waitMs = 1000) => {
  const request = JSON.stringify({ id: nextId++, op, code });
  console.log(`[${stamp()} in ] ${request}`);
  proc.stdin.write(`${request}\n`);
  proc.stdin.flush();
  await Bun.sleep(waitMs);
};

await Bun.sleep(6000); // boot
await send("eval", "1 + 1");
await send("check", "def foo");
await send("check", "def foo\n  42\nend");
await send("eval", "def foo\n  42\nend");
await send("eval", 'puts "printed"; sleep 0.5; puts "later"; $stderr.puts "warned"; { a: [1, 2] }');
await send("eval", "Post.count");
await send("eval", "Post.count"); // a second time: query cache or not?
await send("eval", 'raise "boom"');
await send("eval", "x = 5");
await send("eval", "x * 2"); // locals persist between evaluations
await send("complete", "Post.cou");
await send("complete", "x.ti");
await send("eval", "reload!");
await send("eval", "sleep 30; :never", 1000);
console.log(`[${stamp()} sig] SIGINT`);
proc.kill("SIGINT");
await Bun.sleep(1000);
await send("eval", ":after_interrupt");
proc.stdin.end();
console.log(`[${stamp()} exit] code=${await proc.exited} signal=${proc.signalCode}`);
await drained;
