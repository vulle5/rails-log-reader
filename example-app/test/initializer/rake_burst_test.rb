require "test_helper"
require "support/development_run"

# Scenario 8 (#31): `bin/rake scenarios:rake_burst`, a second concurrent Run appending bulk
# unattributed queries to the same Sidecar as whatever server is running beside it. `fork` is
# what RunTest already uses to put two Runs in one process without two terminals — the same
# technique proves the burst's own shape, and proves it beside a real request's own Run
# rather than alone, which is the only way ADR-0003's O_APPEND claim has anything to say.
class RakeBurstTest < ActiveSupport::TestCase
  # `rake` itself loads tasks via `Rails.application.load_tasks`, which a plain boot through
  # `config/environment` never does — so the script has to do what `bin/rake` would.
  INVOKE_BURST = <<~RUBY
    require "rake"
    Rails.application.load_tasks
    Rake::Task["scenarios:rake_burst"].invoke
  RUBY

  test "the rake burst is bulk, unattributed, and shares the Sidecar with a concurrent request" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      Process.wait(fork { #{INVOKE_BURST} })
      #{DevelopmentRun.real_request("/posts")}
    RUBY

    assert run.booted?, run.output
    request_start = run.events_of("request_start").sole
    burst = run.events_of("sql").select { |event| event["request_id"].nil? }

    assert_operator burst.size, :>, 1_000, "the whole point of a burst is that it is bulk"
    names = burst.map { |event| event["payload"]["name"] }.uniq
    assert_equal ["Post Count"], names - ["SCHEMA"],
      "every query in the burst is the same shape, run for volume rather than variety — " \
      "SCHEMA is allowed once, from the forked child's first connection checkout"
    assert_not_equal request_start["run_id"], burst.first["run_id"],
      "the burst is a Run of its own, not the request's"

    # The one way a concurrent O_APPEND writer could corrupt append order rather than merely
    # interleave with it is a write landing inside another write. A line that failed to parse
    # would already have failed `run.events` above; this additionally proves neither Run's
    # own seq skipped or repeated a number, which a torn write would do to at least one of them.
    run.events.group_by { |event| event["run_id"] }.each_value do |events|
      assert_equal (1..events.size).to_a, events.map { |event| event["seq"] }.sort,
        "a Run's own seq must count 1..N with nothing dropped and nothing doubled"
    end
  end

  # Through `bin/rake` itself, unlike the test above: `Rake.application.run` is exactly what
  # the `rake` executable calls, ARGV and all, so `top_level_tasks` is populated the same way
  # it would be from a real terminal — the one thing the fork-based test above cannot prove,
  # since it hands the task to `Rake::Task#invoke` after the environment has already booted.
  test "run through bin/rake, the task is a Run whose kind is genuinely \"rake\"" do
    run = DevelopmentRun.boot(through: :rake, script: <<~RUBY)
      require "rake"
      ARGV.replace(["scenarios:rake_burst"])
      Rake.application.run
    RUBY

    assert run.booted?, run.output
    header = run.events_of("run_header").sole
    assert_equal "rake", header["payload"]["kind"]
    assert_equal [], run.events_of("sql").map { |event| event["request_id"] }.uniq.compact,
      "every query a rake task runs is unattributed by construction — there is no request to own it"
  end
end
