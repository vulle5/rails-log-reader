require "test_helper"
require "support/development_run"

# Standing constraint 1, and the defining failure of the prior art: a collaborator running
# `tail -f log/development.log` must see exactly what they see today. It is tested in the
# *enabled* state, because that is the only state where it can break — with no Marker file
# nothing of ours is loaded at all.
class DevelopmentLogTest < ActiveSupport::TestCase
  # Deliberately traffic that logs and nothing else. Development's formatter writes no
  # timestamp, so two Runs of this produce the same bytes and the comparison can be exactly
  # what it claims — no masking, no normalising, no "identical apart from". Requests and SQL
  # join it when the Initializer starts capturing them (#19, #20).
  TRAFFIC = <<~RUBY
    Rails.logger.debug "a debug line"
    Rails.logger.info "an info line"
    Rails.logger.warn "a warn line"
    Rails.logger.error "an error line"
    Rails.logger.fatal "a fatal line"
    Rails.logger.tagged("Scenario") { Rails.logger.info "a tagged line" }
  RUBY

  test "log/development.log is byte-identical to a Run that never had the Initializer" do
    enabled = DevelopmentRun.boot(script: TRAFFIC)
    untouched = DevelopmentRun.boot(script: TRAFFIC, initializer: false)

    assert enabled.booted?, enabled.output
    assert untouched.booted?, untouched.output
    assert enabled.sidecar?, "the Run under test was not capturing anything"
    assert_includes untouched.development_log, "a tagged line", "this traffic logged nothing"

    assert_equal untouched.development_log, enabled.development_log
  end
end
