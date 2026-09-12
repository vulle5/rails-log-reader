require "test_helper"
require "support/development_run"

# Scenario 13 (#31): TrailingEventMiddleware, inserted outside Rails::Rack::Logger, produces
# a genuine Trailing event — a child whose seq places it after its own request's
# request_finish, still carrying that request's request_id.
class TrailingTest < ActiveSupport::TestCase
  test "the query and log line from the close block arrive after request_finish, still attributed to it" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/scenarios/trailing_event"))

    assert run.booted?, run.output
    finish = run.events_of("request_finish").sole
    request_id = finish["request_id"]
    assert request_id, "the request has to have finished as itself for there to be anything to trail"

    trailing_sql = run.events_of("sql").find { |event| event["payload"]["name"] == "Comment Count" }
    trailing_log = run.events_of("app_log").find { |event| event["payload"]["message"].include?("Scenario 13") }

    assert trailing_sql, "the close block's own query never reached the Sidecar"
    assert trailing_log, "the close block's own log line never reached the Sidecar"

    [trailing_sql, trailing_log].each do |event|
      assert_equal request_id, event["request_id"],
        "a Trailing event is still this request's own — that is what makes it trailing " \
        "rather than merely unattributed"
      assert_operator event["seq"], :>, finish["seq"],
        "seq after request_finish's own is the entire definition of a Trailing event"
    end
  end

  # An ordinary request through the same middleware — everything but this one Scenario's own
  # path returns untouched, so the rest of the Example app pays nothing for this Scenario
  # existing.
  test "an ordinary request is not wrapped, and produces no trailing anything" do
    run = DevelopmentRun.boot(script: DevelopmentRun.real_request("/posts"))

    assert run.booted?, run.output
    finish = run.events_of("request_finish").sole

    after = run.events.select { |event| event["seq"] > finish["seq"] && event["type"] != "run_end" }
    assert_empty after, "nothing but the Run's own end should have been emitted after this request's finish"
  end
end
