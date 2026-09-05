require "test_helper"
require "support/development_run"

# The Marker file is the whole gate, and everything in the Initializer sits below it. These
# tests are what turns "a teammate who never opts in notices nothing" from a slogan into
# four statements a machine can check.
class GateTest < ActiveSupport::TestCase
  # Everything a Run can say about itself that our being loaded could possibly change.
  FINGERPRINT = <<~RUBY
    require "json"
    puts JSON.generate(
      middleware: Rails.application.middleware.map(&:name),
      subscribers: %w[sql.active_record request.action_dispatch start_processing.action_controller]
        .index_with { |event| ActiveSupport::Notifications.notifier.listeners_for(event).size },
      logger_sinks: Rails.logger.broadcasts.size
    )
  RUBY

  test "with no Marker file the Initializer installs nothing, and leaves no Sidecar behind" do
    installed = DevelopmentRun.boot(script: FINGERPRINT, marker: false)
    absent = DevelopmentRun.boot(script: FINGERPRINT, marker: false, initializer: false)

    assert installed.booted?, installed.output
    assert absent.booted?, absent.output

    with = JSON.parse(installed.output)
    without = JSON.parse(absent.output)

    assert_equal without["middleware"], with["middleware"], "a middleware was inserted"
    assert_equal without["subscribers"], with["subscribers"], "a subscriber was registered"
    assert_equal without["logger_sinks"], with["logger_sinks"], "a sink was attached to Rails.logger"
    assert_not installed.sidecar?, "a Sidecar was created for a developer who never asked for one"

    assert_includes without["middleware"], "ActionDispatch::RequestId",
      "the baseline is empty, so this test proves nothing"
  end

  # Not a setting and not a check that could be got wrong one environment at a time: the gate
  # names `development` and nothing else, so a deployed box is refused by construction.
  test "a deployed environment is refused however loudly the Marker file is present" do
    %w[production staging].each do |environment|
      run = DevelopmentRun.boot(env: environment, marker: true) do |root|
        # An app with a staging environment at all is the deployed box ADR-0004 refuses, so
        # give this one enough of a staging environment to boot into.
        FileUtils.cp("#{root}/config/environments/production.rb", "#{root}/config/environments/staging.rb")
        File.write("#{root}/config/database.yml", "\nstaging:\n  <<: *default\n", mode: "a")
      end

      assert run.booted?, run.output
      assert_not run.sidecar?, "#{environment} wrote a Sidecar"
    end
  end

  # Deferred rather than rejected: parallel workers, transactional rollback and thousands of
  # sub-millisecond requests all press on what a Run is before this could be turned on.
  test "the test environment is refused too" do
    run = DevelopmentRun.boot(env: "test", marker: true)

    assert run.booted?, run.output
    assert_not run.sidecar?
  end

  test "Rails below 7.1 is refused by name, and the app boots on regardless" do
    run = DevelopmentRun.boot do |root|
      # Sorts before rails_log_reader.rb, so the gate sees the version this pretends to be.
      File.write("#{root}/config/initializers/a_pretend_rails_is_older.rb", <<~RUBY)
        def Rails.gem_version = Gem::Version.new("7.0.8")
        def Rails.version = "7.0.8"
      RUBY
    end

    assert run.booted?, "a log reader must never be what stops an app booting:\n#{run.output}"
    assert_not run.sidecar?
    assert_equal 1, run.development_log.lines.grep(/rails_log_reader/).size,
      "expected exactly one warning:\n#{run.development_log}"
    assert_match(/broadcast_to/, run.development_log,
      "the warning has to name the mechanism, not just complain about a version")
    assert_match(/7\.0\.8/, run.development_log)
  end
end
