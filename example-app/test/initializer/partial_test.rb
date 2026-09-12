require "test_helper"
require "support/development_run"

# Scenario 11 (#31): a Partial request. `/scenarios/partial_request` holds a pause between
# two queries specifically so the Sidecar can be replaced out from under it — the same thing
# ADR-0003 says a boot-time truncation does to a live Run ("the Reader re-attaches
# mid-stream and its requests become ordinary Partial requests"). A request_start already on
# disk does not survive that; a query issued afterward has no way back to it.
class PartialTest < ActiveSupport::TestCase
  test "a request whose Sidecar is replaced mid-flight loses its own start, not its later queries" do
    run = DevelopmentRun.boot(script: <<~RUBY)
      request_thread = Thread.new { #{DevelopmentRun.real_request("/scenarios/partial_request")} }

      # The pause inside the action's own first half — after its first query, before its
      # second. Replacing the file here is standing in for the Reader attaching after a
      # truncation it had no part in: what already reached disk is gone, and O_APPEND means
      # the still-open Sidecar just keeps writing from the new end of file.
      sleep 0.5
      File.write("log/rails_log_reader.jsonl", "")

      request_thread.join
    RUBY

    assert run.booted?, run.output
    assert_empty run.events_of("request_start"),
      "it was written before the swap, which is exactly what a Partial request never has"

    finish = run.events_of("request_finish").sole
    request_id = finish["request_id"]
    assert request_id, "the request still finished as itself — only its start is missing"

    surviving_sql = run.events_of("sql").select { |event| event["request_id"] == request_id }
    assert_equal ["Comment Count"], surviving_sql.map { |event| event["payload"]["name"] },
      "the query on the near side of the swap went with it; only the far one survives"
  end
end
