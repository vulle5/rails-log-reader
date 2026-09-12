require "test_helper"
require "support/development_run"
require "net/http"

# Scenario 12 (#31): clustered Puma at WEB_CONCURRENCY=2, the only test of the pid-keyed
# run_id against Puma's own real clustering rather than a bare `fork` standing in for it
# (RunTest already covers that mechanism generically). Puma preloads the app by default in
# cluster mode, so the Initializer boots — and writes its one run_header — in the master
# before either worker exists; each worker then gets its own run_id purely from
# `emit`'s own pid check the first time it observes anything, with no run_header of its own.
# That gap is ADR-0003's own: "a forked Puma worker becomes its own Run", not "a forked Puma
# worker announces itself" — nothing here is a bug to fix.
class ClusteredTest < ActiveSupport::TestCase
  test "two workers sharing one Sidecar never collide on (run_id, seq), and both are Runs of their own" do
    DevelopmentRun.shared_root do |root|
      served = DevelopmentRun.serve(root:, web_concurrency: 2)

      # A moment for both workers to fork and boot before the flood — Puma logs each as it
      # comes up, but the Sidecar itself is the only thing this test is allowed to read.
      sleep 1.5
      20.times.map do
        Thread.new { Net::HTTP.get(URI("http://127.0.0.1:#{served.port}/scenarios/flood")) }
      end.each { |thread| thread.join }

      Process.kill("TERM", served.pid)
      _, status = Process.wait2(served.pid)
      result = served.finish(status)

      by_run = result.events.group_by { |event| event["run_id"] }
      assert_equal 3, by_run.size, "the master plus two workers, each its own Run"

      master = result.events_of("run_header").sole
      assert_equal served.pid, master["payload"]["pid"], "preloading boots the app in the master, before either fork"

      workers = by_run.reject { |run_id, _| run_id == master["run_id"] }
      assert_equal [], workers.flat_map { |_, events| events }.select { |event| event["type"] == "run_header" },
        "a forked worker gets its own run_id the first time it emits anything, never a run_header of its own"

      finishes = workers.sum { |_, events| events.count { |event| event["type"] == "request_finish" } }
      assert_equal 20, finishes, "every one of the twenty requests finished, from one worker or the other"

      workers.each_value do |events|
        assert_equal (1..events.size).to_a, events.map { |event| event["seq"] }.sort,
          "each worker's own seq counts 1..N — the whole reason it needed a run_id of its own"
      end
    end
  end
end
