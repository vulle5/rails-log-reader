// Throwaway experiment: drive `bin/rails console` over plain pipes and log exactly what
// comes back on stdout and stderr, with timestamps, so the output framing can be seen.
//
//   bun docs/research/driving-a-rails-console-from-bun/irb-over-pipes.ts [irb flags...]
//
// Run from the repo root; the Example app must have been set up (`example-app/bin/setup`).

const appRoot = new URL("../../../example-app/", import.meta.url).pathname;
const irbFlags = process.argv.slice(2);
const t0 = performance.now();
const stamp = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;

const proc = Bun.spawn(["bin/rails", "console", "--", ...irbFlags], {
  cwd: appRoot,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

async function drain(name: string, stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    console.log(`[${stamp()} ${name}] ${JSON.stringify(decoder.decode(chunk))}`);
  }
}
const drained = Promise.all([drain("out", proc.stdout), drain("err", proc.stderr)]);

const send = async (text: string, waitMs = 1500) => {
  console.log(`[${stamp()} in ] ${JSON.stringify(text)}`);
  proc.stdin.write(text);
  proc.stdin.flush();
  await Bun.sleep(waitMs);
};

await Bun.sleep(6000); // boot
await send("1 + 1\n");
await send("def foo\n");
await send("  42\n");
await send("end\n");
await send('puts "printed"; $stderr.puts "warned"; :value\n');
await send("Post.count\n");
await send('raise "boom"\n');
await send("reload!\n");
await send("sleep 30; :never\n", 1000);
console.log(`[${stamp()} sig] SIGINT`);
proc.kill("SIGINT");
await Bun.sleep(1500);
await send(":after_interrupt\n");
await send("exit\n");
console.log(`[${stamp()} exit] code=${await proc.exited} signal=${proc.signalCode}`);
await drained;
