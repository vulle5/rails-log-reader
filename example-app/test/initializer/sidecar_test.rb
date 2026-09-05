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
    assert_equal 1, run.development_log.lines.grep(/rails_log_reader/).size,
      "expected exactly one warning:\n#{run.development_log}"
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
    assert run.sidecar.start_with?(earlier), "an earlier Run's events were thrown away"
    assert_no_match(/rails_log_reader/, run.development_log)
  end

  # No event this Initializer emits yet has a field that could reach 64 KB, so the Run is
  # asked to write one through the same front door every subscriber will use.
  test "a field past 64 KB is cut, and the file records how long it really was" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      RailsLogReader.emit("app_log", { severity: "info", message: "x" * 100_000, source: "app", tags: [] })
    RUBY

    assert run.booted?, run.output
    logged = run.events_of("app_log").sole

    assert_equal 64 * 1024, logged["payload"]["message"].bytesize
    assert_equal({ "message" => 100_000 }, logged["truncated"],
      "the original byte length is what lets the Reader say 'showing 64KB of 98KB'")
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
    assert_equal 1, run.development_log.lines.grep(/rails_log_reader/).size,
      "expected exactly one warning:\n#{run.development_log}"
  end

  # The exemption has to survive the shape a backtrace actually arrives in: nested inside a
  # request_finish's `exception`, not as a field of its own.
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
