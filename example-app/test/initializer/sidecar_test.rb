require "test_helper"
require "support/development_run"

# The Sidecar is the transport, and the only file this product creates. Its bounds are
# bounds rather than assumptions: they hold however long a Run lives, because it is the file
# that accumulates across the dozens of Runs a day puma-dev's idle reaping produces.
class SidecarTest < ActiveSupport::TestCase
  OVER_THE_CAP = (64 * 1024 * 1024) + 1

  test "a Sidecar past 64 MB is emptied once, at boot, and says so" do
    run = DevelopmentRun.boot do |root|
      File.write("#{root}/log/rails_log_reader.jsonl", "an event from some earlier day\n")
      File.truncate("#{root}/log/rails_log_reader.jsonl", OVER_THE_CAP)
    end

    assert run.booted?, run.output
    assert_operator run.sidecar_size, :<, 1024, "the file was not emptied"
    assert_equal %w[run_header run_end], run.events.map { |event| event["type"] },
      "the Run's own events are all that should be left"
    assert_equal 1, run.warnings.size, "expected exactly one warning:\n#{run.development_log}"
    assert_match(/64 MB/, run.development_log)
  end

  # The other half of "checked once, at boot": truncating every time would fire on every
  # idle cycle and destroy the history the Reader replays on open.
  test "a Sidecar under the cap keeps everything an earlier Run wrote" do
    earlier = "an event from some earlier day\n"
    run = DevelopmentRun.boot do |root|
      File.write("#{root}/log/rails_log_reader.jsonl", earlier)
    end

    assert run.booted?, run.output
    assert run.sidecar_bytes.start_with?(earlier), "an earlier Run's events were thrown away"
    assert_empty run.warnings
  end

  # Driven through a real request rather than RailsLogReader.emit directly, now that one
  # exists: request_route's `params` is the first payload #18 didn't have, and the ordinary
  # way a field gets this large is a request carrying an oversized query value, not a test
  # calling the writer's own front door.
  test "a field past 64 KB is cut, and the file records how long it really was" do
    huge = "x" * 100_000
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/posts", params: { spoiler: huge }))

    assert run.booted?, run.output
    route = run.events_of("request_route").sole

    assert_operator route["payload"]["params"]["spoiler"].bytesize, :<, huge.bytesize
    assert_equal %w[action controller spoiler], route["payload"]["params"].keys.sort,
      "a params hash losing a key would say the request never carried it — it must keep all three"
    assert_operator route["truncated"]["params"], :>, 64 * 1024
  end

  # ADR-0003's line cap, past ADR-0002's field cap: nothing here writes a field over 64 KB
  # except a backtrace, kept whole on purpose, so it is the one thing that can still make a
  # single line this large. Unlike the field cap, the line cap is allowed to touch it — a
  # write(2) too large to be atomic is the one way append order can be corrupted.
  #
  # Driven through RailsLogReader.emit rather than a real request, unlike the 64 KB test
  # above: reaching 256 KB needs tens of thousands of frames, and the only way to make a
  # real request raise with a backtrace that deep is scaffolding built for no other reason
  # than to be deep — worse than naming the writer's own front door. RequestTest already
  # proves a real exception's real backtrace reaches request_finish intact; this test's job
  # is the cap itself, at a scale nothing in the Example app can produce honestly.
  test "a line past 256 KB is shrunk further, backtrace included, and the file says so" do
    frames = ["a frame of it"] * 30_000
    run = DevelopmentRun.boot(script: <<~RUBY)
      RailsLogReader.emit("request_finish", {
        status: 500, duration_ms: 1.0,
        exception: { class: "RuntimeError", message: "boom", backtrace: #{frames.inspect} }
      })
    RUBY

    assert run.booted?, run.output
    finish = run.events_of("request_finish").sole
    line = run.lines[run.events.index(finish)]

    assert_operator line.bytesize, :<=, 256 * 1024
    assert_operator finish["truncated"]["exception"], :>, 256 * 1024,
      "the original byte length, from before any shrinking, is what the Reader shows"
    assert_operator finish["payload"]["exception"]["backtrace"].size, :<, frames.size,
      "past the line cap a backtrace is shed from its tail rather than kept whole"
  end

  # An unwritable log/ is the case that cannot report itself into the Sidecar, which is why
  # the complaint goes to Rails.logger — a line only the developer who made the marker sees.
  test "a Sidecar that cannot be opened warns once, and the app boots on without one" do
    skip "root can write to anything" if Process.uid.zero?

    run = DevelopmentRun.boot(script: 'puts "the app booted"') do |root|
      FileUtils.touch("#{root}/log/development.log")
      File.chmod(0o555, "#{root}/log")
    end

    assert run.booted?, run.output
    assert_includes run.output, "the app booted"
    assert_not run.sidecar?
    assert_equal 1, run.warnings.size, "expected exactly one warning:\n#{run.development_log}"
  end

  # The exemption has to survive the shape a backtrace actually arrives in: nested inside a
  # request_finish's `exception`, not as a field of its own.
  #
  # Still driven through RailsLogReader.emit, not a real request: this proves the exemption
  # holds *at scale* — hundreds of KB past the cap — which no real Example app route can
  # produce without a controller action built only to recurse. RequestTest's exception test
  # already re-drives the exemption itself through a real, ordinary-sized backtrace; this
  # one is the writer's own robustness test, not a second copy of that.
  test "a backtrace is kept whole however far past the cap it runs" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      RailsLogReader.emit("request_finish", {
        status: 500, duration_ms: 1.0,
        exception: {
          class: "RuntimeError", message: "boom",
          backtrace: ["a frame of it"] * 5_000 + ["x" * 100_000]
        }
      })
    RUBY

    assert run.booted?, run.output
    finish = run.events_of("request_finish").sole
    backtrace = finish["payload"]["exception"]["backtrace"]

    assert_equal 5_001, backtrace.size
    assert_equal 100_000, backtrace.last.bytesize,
      "a single frame past the cap was cut anyway, and the answer with it"
    assert_nil finish["truncated"]
  end
end
