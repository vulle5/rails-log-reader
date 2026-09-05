require "test_helper"
require "support/development_run"

# A Run is one boot-to-shutdown lifetime of the Rails process, and the Sidecar is where it
# says so. These drive a real development Run and read the file it wrote.
class RunTest < ActiveSupport::TestCase
  test "a Run announces itself with a run_header the moment the Initializer loads" do
    run = DevelopmentRun.boot

    assert run.booted?, run.output
    headers = run.events_of("run_header")
    assert_equal 1, headers.size, "expected exactly one run_header:\n#{run.sidecar_bytes}"

    header = headers.first
    assert_equal 1, header["v"]
    assert_equal 1, header["seq"], "the header is the Run's first observation"
    assert_match(/\A[0-9a-f-]{36}\z/, header["run_id"])
    assert_nil header["request_id"], "a run_header belongs to no request"
    # CLOCK_MONOTONIC counts from the machine's boot and is shared across processes, so
    # this process can read the very same clock. An at_mono that was epoch-anything, or
    # milliseconds rather than nanoseconds, would be out by orders of magnitude.
    assert_in_delta Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond),
      header["at_mono"], 60_000_000_000
    assert_in_delta Time.now.to_f * 1000, header["at_wall"], 60_000
    assert_nil header["truncated"], "nothing in a run_header is anywhere near 64 KB"

    payload = header["payload"]
    assert_equal Rails.version, payload["rails_version"]
    assert_equal "ExampleApp", payload["app_name"]
    assert_equal run.root, payload["rails_root"]
    assert_operator payload["pid"], :>, 0
    # This Run is neither a console, a rake task nor a rack boot, and "unknown" is the
    # honest answer for it — the wire carries the word precisely so it can be given. The
    # shapes that do have a name are driven by the process-lifecycle Scenarios (#31).
    assert_equal "unknown", payload["kind"]
  end

  test "a Run that shuts down cleanly says so, and its seq counts the Run's observations" do
    run = DevelopmentRun.boot

    assert run.booted?, run.output
    header, ending = run.events

    assert_equal "run_end", ending["type"]
    assert_equal({}, ending["payload"], "a run_end has nothing to say beyond having happened")
    assert_equal header["run_id"], ending["run_id"]
    assert_equal 2, ending["seq"], "the second thing this Run observed"
    assert_nil ending["request_id"]
  end

  # The Initializer loads before a clustered Puma forks its workers, so every worker would
  # inherit one run_id while keeping its own seq counter — and (run_id, seq) is the event
  # identity, so the Reader would silently eat one of every colliding pair.
  test "a process forked after boot is its own Run, with its own run_id and its own seq" do
    run = DevelopmentRun.boot(script: "Process.wait(fork {})")

    assert run.booted?, run.output
    header = run.events_of("run_header").first
    worker, parent = run.events_of("run_end")

    assert_equal header["run_id"], parent["run_id"], "the parent kept the Run it announced"
    assert_equal 2, parent["seq"]

    assert_not_equal header["run_id"], worker["run_id"], "the worker is a Run of its own"
    assert_equal 1, worker["seq"], "and its seq space starts over, which is why it must be"
  end

  # The branch that matters, and the one a check for a constant would get wrong: `rails s`
  # leaves a Rails::Server behind, but puma-dev boots straight through config.ru and leaves
  # nothing at all. Puma itself is no help — `Bundler.require` loads it in every Run there is.
  test "a Run that came in through the rack entry point knows it is a server" do
    run = DevelopmentRun.boot(through: :config_ru)

    assert run.booted?, run.output
    assert_equal "server", run.events_of("run_header").sole["payload"]["kind"]
  end
end
